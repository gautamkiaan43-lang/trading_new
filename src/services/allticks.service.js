/**
 * AllTick Integration Service
 * ───────────────────────────
 * Realtime Forex & Crypto quotes via AllTick API with real bid/ask spreads.
 *
 * Primary:  WebSocket  wss://quote.alltick.io/quote-b-ws-api?token=TOKEN
 * Fallback: HTTP Poll  https://quote.alltick.io/quote-b-api/depth-tick?token=TOKEN&query=...
 *
 * API Protocol:
 *   depth-tick endpoint provides:
 *     - bids: array of {price, volume} (best bid first)
 *     - asks: array of {price, volume} (best ask first)
 *     - Real market depth data, not calculated spreads
 *
 * WebSocket (optional):
 *   Subscribe   → cmd_id 22004, symbol field: "code"
 *   Push ticks  ← cmd_id 22998
 *   Heartbeat   → cmd_id 22000 | Pong ← cmd_id 22001
 */

const WebSocket = require('ws');
const axios = require('axios');
const { formatForexData } = require('../utils/forexFormatter');
const { formatCryptoData } = require('../utils/cryptoFormatter');

const WS_URL         = 'wss://quote.alltick.io/quote-b-ws-api';
const HTTP_DEPTH_URL = 'https://quote.alltick.io/quote-b-api/depth-tick';

class AllTickService {
    constructor() {
        this.ws                   = null;
        this.pollingInterval      = null;
        this.heartbeatInterval    = null;
        this.isRunning            = false;
        this.isWsConnected        = false;
        this.wsDisabled           = false; // set true on 401 — stop retrying WS
        this.reconnectAttempts    = 0;
        this.maxReconnectAttempts = 10;

        this.token = null;

        // Default fallback symbols (will be overridden by DB symbols)
        this.forexSymbols = [
            'AUDCAD', 'EURINR', 'EURUSD', 'GBPINR', 'GBPUSD',
            'USDCHF', 'USDINR', 'USDJPY', 'Silver', 'XAUUSD'
        ];
        // AllTick crypto symbols use USDT suffix (not USD)
        this.cryptoSymbols = [
            'ADAUSDT', 'AVAXUSDT', 'BNBUSDT', 'BTCUSDT', 'DOGEUSDT',
            'DOTUSDT', 'ETHUSDT', 'MATICUSDT', 'SOLUSDT', 'XRPUSDT'
        ];

        this.cache         = {};
        this.prevCloseCache = {};
    }

    // Load symbols from database (dynamic, not hardcoded)
    async _loadSymbolsFromDb() {
        try {
            const db = require('../config/db');

            // Load Forex symbols from DB and convert to AllTick format
            const [forexRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'FOREX'
            `);
            if (forexRows.length > 0) {
                this.forexSymbols = forexRows.map(r => {
                    const sym = r.symbol || '';
                    // Special cases for commodity codes that don't follow standard format
                    if (sym === 'XAG/USD') {
                        return 'Silver';  // XAG/USD → Silver (AllTicks code)
                    }
                    // Convert EUR/USD → EURUSD format for AllTick
                    return sym.replace(/\//g, '');
                }).filter(Boolean);
            }

            // Load Crypto symbols from DB and convert to AllTick format
            const [cryptoRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'CRYPTO'
            `);
            if (cryptoRows.length > 0) {
                this.cryptoSymbols = cryptoRows.map(r => {
                    // Convert BTC/USD → BTCUSDT format for AllTick
                    const sym = (r.symbol || '').replace(/\/USD$/i, 'USDT').replace(/\//g, '');
                    return sym;
                }).filter(Boolean);
            }
        } catch (err) {
            console.error('[ALLTICKS] Failed to load symbols from DB:', err.message);
            // Will use hardcoded fallbacks
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────

    async start() {
        this.token = process.env.ALLTICKS_API_KEY;
        if (!this.token) {
            console.log('[ALLTICKS] ALLTICKS_API_KEY not set — service idle.');
            return;
        }
        if (this.isRunning) return;
        this.isRunning = true;

        // Load symbols from database first (replaces hardcoded list)
        await this._loadSymbolsFromDb();

        console.log(`[ALLTICKS] Starting AllTick Integration Service - Crypto: ${this.cryptoSymbols.length}, Forex: ${this.forexSymbols.length}`);
        // Always run HTTP polling (5s) as primary source.
        // WS is attempted in parallel — if it delivers ticks they override HTTP data.
        // This handles plans where WS connects but sends no ticks.
        this._startPolling();
        this._connectWs();
    }

    stop() {
        console.log('[ALLTICKS] Stopping AllTick Integration Service...');
        this.isRunning = false;
        this._closeWs();
        this._stopPolling();
    }

    // ─────────────────────────────────────────────────────────
    //  WebSocket
    // ─────────────────────────────────────────────────────────

    _connectWs() {
        if (!this.isRunning || this.wsDisabled) {
            if (this.wsDisabled) this._startPolling();
            return;
        }

        const url = `${WS_URL}?token=${this.token}`;

        try {
            this.ws = new WebSocket(url);

            // Register error handler FIRST to prevent unhandled errors
            this.ws.on('error', (err) => {
                if (!this.wsDisabled) {
                    console.error('[ALLTICKS] WS Error:', err.message);
                    this.isWsConnected = false;
                    this._startPolling();
                }
            });

            // Handle non-101 upgrade responses (e.g. 401, 429)
            this.ws.on('unexpected-response', (req, res) => {
                const code = res.statusCode;
                if (code === 401) {
                    console.error('[ALLTICKS] WebSocket 401 Unauthorized — token invalid or plan does not include WS. Falling back to HTTP polling permanently.');
                    this.wsDisabled = true;
                } else if (code === 429) {
                    console.warn(`[ALLTICKS] WebSocket 429 Rate Limited. Using HTTP polling instead.`);
                } else {
                    console.error(`[ALLTICKS] WebSocket upgrade failed with HTTP ${code}. Falling back to HTTP polling.`);
                }
                if (this.ws) {
                    this.ws.removeAllListeners();
                    try {
                        if (this.ws.readyState === 0 || this.ws.readyState === 1) {
                            this.ws.close();
                        }
                    } catch (closeErr) {
                        // WebSocket already closed or in invalid state
                    }
                    this.ws = null;
                }
                this._startPolling();
            });

            this.ws.on('open', () => {
                console.log('[ALLTICKS] WebSocket Connected');
                this.isWsConnected    = true;
                this.reconnectAttempts = 0;
                this._subscribe();
                this._startHeartbeat();
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    this._handleWsMessage(msg);
                } catch (_) {}
            });

            this.ws.on('close', () => {
                if (this.isWsConnected) {
                    console.log('[ALLTICKS] WebSocket Closed');
                }
                this.isWsConnected = false;
                this._stopHeartbeat();
                if (this.isRunning && !this.wsDisabled) {
                    this._retryConnection();
                }
            });
        } catch (err) {
            console.error('[ALLTICKS] WS Connection Exception:', err.message);
            this._startPolling();
        }
    }

    _retryConnection() {
        if (this.wsDisabled) {
            this._startPolling();
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            console.log(`[ALLTICKS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this._connectWs(), delay);
        } else {
            console.warn('[ALLTICKS] Max WS reconnects reached — switching to HTTP polling permanently.');
            this._startPolling();
        }
    }

    _closeWs() {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                if (this.ws.readyState !== 3) { // 3 = CLOSED
                    this.ws.close();
                }
            } catch (_) {}
            this.ws = null;
        }
        this.isWsConnected = false;
        this._stopHeartbeat();
    }

    // ─────────────────────────────────────────────────────────
    //  Heartbeat  (request: 22000 | pong from server: 22001)
    // ─────────────────────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    cmd_id: 22000,
                    seq_id: Date.now(),
                    trace:  'hb-' + Date.now(),
                    data:   {}
                }));
            }
        }, 10000);
    }

    _stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Subscription  (cmd_id: 22004, field: "code")
    // ─────────────────────────────────────────────────────────

    _subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const symbolList = [...this.forexSymbols, ...this.cryptoSymbols]
            .map(sym => ({ code: sym })); // AllTick uses "code", not "symbol"

        const subMsg = {
            cmd_id: 22004,           // correct subscribe cmd_id per AllTick docs
            seq_id: Date.now(),
            trace:  'sub-' + Date.now(),
            data:   { symbol_list: symbolList }
        };

        this.ws.send(JSON.stringify(subMsg));
        console.log(`[ALLTICKS] Subscribed to ${symbolList.length} symbols via WS`);
    }

    // ─────────────────────────────────────────────────────────
    //  Message Handling
    //  Server push ticks use cmd_id 22998 (not 22004)
    // ─────────────────────────────────────────────────────────

    _handleWsMessage(msg) {
        if (!msg) return;

        if (msg.cmd_id === 22998) {
            // Server tick push — data is a single tick object
            if (msg.data) {
                this._processTick(msg.data);
            }
        }
        // cmd_id 22001 = heartbeat pong — ignore silently
        // cmd_id 22005 = subscription ack — ignore silently
    }

    // ─────────────────────────────────────────────────────────
    //  Tick Processing
    //  AllTick tick fields: code, price, volume, turnover, tick_time
    // ─────────────────────────────────────────────────────────

    _processTick(tick) {
        if (!tick || !tick.code) return;

        const symbol  = tick.code; // AllTick uses "code" not "symbol"
        const isForex  = this.forexSymbols.includes(symbol);
        const isCrypto = this.cryptoSymbols.includes(symbol);
        if (!isForex && !isCrypto) return;

        // Extract bid from bids array (best bid = first element)
        let bid = 0;
        if (Array.isArray(tick.bids) && tick.bids.length > 0) {
            bid = parseFloat(tick.bids[0].price || 0);
        }

        // Extract ask from asks array (best ask = first element)
        let ask = 0;
        if (Array.isArray(tick.asks) && tick.asks.length > 0) {
            ask = parseFloat(tick.asks[0].price || 0);
        }

        // Calculate LTP as average of bid/ask (or use mid-price)
        let ltp = bid && ask ? (bid + ask) / 2 : (bid || ask || 0);
        if (!ltp || isNaN(ltp)) return;

        if (!this.prevCloseCache[symbol]) {
            this.prevCloseCache[symbol] = ltp;
        }

        // Calculate total volume from bids + asks
        let totalVolume = 0;
        if (Array.isArray(tick.bids)) {
            tick.bids.forEach(b => {
                totalVolume += parseFloat(b.volume || 0);
            });
        }
        if (Array.isArray(tick.asks)) {
            tick.asks.forEach(a => {
                totalVolume += parseFloat(a.volume || 0);
            });
        }

        const dataToFormat = {
            bid,
            ask,
            ltp,
            previousClose: this.prevCloseCache[symbol],
            volume:        totalVolume > 0 ? totalVolume : '-',
            change:        0
        };

        if (tick.pre_close_price && parseFloat(tick.pre_close_price) > 0) {
            this.prevCloseCache[symbol] = parseFloat(tick.pre_close_price);
        }

        let formatted;
        if (isForex) {
            formatted = formatForexData(symbol, dataToFormat);
        } else {
            formatted = formatCryptoData(symbol, dataToFormat);
        }

        this.cache[symbol] = formatted;
        this._broadcast(formatted);
    }

    // ─────────────────────────────────────────────────────────
    //  Broadcast to MarketDataService
    // ─────────────────────────────────────────────────────────

    _broadcast(item) {
        try {
            const mds = require('./MarketDataService');
            if (!mds || !mds.prices) return;

            const prefix              = item.type;
            const instrument          = item.instrument;
            const slashedSymbol       = `${prefix}:${instrument}`;
            const unslashedInstrument = instrument.replace('/', '');
            const unslashedSymbol     = `${prefix}:${unslashedInstrument}`;

            const base = { ...item, category: prefix.toLowerCase() };

            mds.prices[slashedSymbol] = {
                ...mds.prices[slashedSymbol],
                ...base,
                symbol: slashedSymbol,
                name:   instrument
            };
            mds.dirtySymbols.add(slashedSymbol);

            mds.prices[unslashedSymbol] = {
                ...mds.prices[unslashedSymbol],
                ...base,
                instrument: unslashedInstrument,
                symbol:     unslashedSymbol,
                name:       unslashedInstrument
            };
            mds.dirtySymbols.add(unslashedSymbol);

            console.log(`[ALLTICKS] 📡 Broadcast: ${slashedSymbol} | Bid: ${item.bid} Ask: ${item.ask}`);
        } catch (err) {
            console.error('[ALLTICKS] Broadcast error:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    //  HTTP Polling Fallback
    //  Uses depth-tick endpoint: GET /quote-b-api/depth-tick
    //  Returns real bid/ask from order book (bids + asks arrays)
    //  query param = URL-encoded JSON
    // ─────────────────────────────────────────────────────────

    _startPolling() {
        if (this.pollingInterval) return;
        console.log('[ALLTICKS] Starting HTTP polling (depth-tick, 1s interval)...');
        this._poll();
        this.pollingInterval = setInterval(() => this._poll(), 1000);
    }

    _stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    async _poll() {
        if (!this.token || !this.isRunning) return;

        const allSymbols = [...this.forexSymbols, ...this.cryptoSymbols];
        const query = JSON.stringify({
            trace: 'poll-' + Date.now(),
            data:  { symbol_list: allSymbols.map(sym => ({ code: sym })) }
        });

        try {
            const response = await axios.get(HTTP_DEPTH_URL, {
                params:  { token: this.token, query },
                timeout: 5000
            });

            const respData = response.data;
            if (!respData || respData.ret !== 200) {
                if (respData?.ret === 401) {
                    console.error('[ALLTICKS] HTTP 401 — token invalid. Stopping polling.');
                    this._stopPolling();
                }
                return;
            }

            const tickList = respData.data?.tick_list;
            if (!Array.isArray(tickList)) return;

            tickList.forEach(tick => this._processTick(tick));

        } catch (err) {
            if (err.code !== 'ECONNABORTED') {
                console.error('[ALLTICKS] HTTP Poll Error:', err.message);
            }
        }
    }
}

module.exports = new AllTickService();
