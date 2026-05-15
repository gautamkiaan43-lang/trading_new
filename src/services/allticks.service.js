/**
 * AllTick Integration Service
 * ───────────────────────────
 * Provides realtime Forex & Crypto market data via AllTick API.
 *
 * Primary:  WebSocket  wss://quote.alltick.co/quote-b-ws-api?token=TOKEN
 * Fallback: HTTP Poll  https://quote.alltick.co/quote-b-api/batch-kline?token=TOKEN
 *
 * Only starts when ALLTICKS_API_KEY is present in env.
 */

const WebSocket = require('ws');
const axios = require('axios');
const { formatForexData } = require('../utils/forexFormatter');
const { formatCryptoData } = require('../utils/cryptoFormatter');

const WS_URL  = 'wss://quote.alltick.co/quote-b-ws-api';
const HTTP_URL = 'https://quote.alltick.co/quote-b-api/batch-kline';

class AllTickService {
    constructor() {
        this.ws               = null;
        this.pollingInterval  = null;
        this.heartbeatInterval = null;
        this.isRunning        = false;
        this.isWsConnected    = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;

        this.token = null; // read fresh on start()

        // ── Symbol Lists ──────────────────────────────────────
        this.forexSymbols = [
            'AUDCAD', 'EURINR', 'EURUSD', 'GBPINR', 'GBPUSD',
            'USDCHF', 'USDINR', 'USDJPY', 'XAGUSD', 'XAUUSD'
        ];
        this.cryptoSymbols = [
            'ADAUSD', 'AVAXUSD', 'BNBUSD', 'BTCUSD', 'DOGEUSD',
            'DOTUSD', 'ETHUSD', 'MATICUSD', 'SOLUSD', 'XRPUSD'
        ];

        // ── In-Memory Cache ───────────────────────────────────
        this.cache         = {}; // symbol -> last formatted data (keeps data alive on reconnect)
        this.prevCloseCache = {}; // symbol -> previousClose for change % calculation
    }

    // ─────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────

    start() {
        this.token = process.env.ALLTICKS_API_KEY;
        if (!this.token) {
            console.log('ℹ️  ALLTICKS_API_KEY not set — AllTick service idle.');
            return;
        }
        if (this.isRunning) return; // singleton guard
        this.isRunning = true;
        console.log('🚀 Starting AllTick Integration Service (Forex + Crypto)...');
        this._connectWs();
    }

    stop() {
        console.log('🛑 Stopping AllTick Integration Service...');
        this.isRunning = false;
        this._closeWs();
        this._stopPolling();
    }

    // ─────────────────────────────────────────────────────────
    //  WebSocket
    // ─────────────────────────────────────────────────────────

    _connectWs() {
        if (!this.isRunning) return;
        const url = `${WS_URL}?token=${this.token}`;

        try {
            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                console.log('⚡ AllTick WebSocket Connected');
                this.isWsConnected    = true;
                this.reconnectAttempts = 0;
                this._stopPolling();   // cancel HTTP fallback if it was running
                this._subscribe();
                this._startHeartbeat();
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    this._handleWsMessage(msg);
                } catch (_) { /* ignore malformed frames */ }
            });

            this.ws.on('error', (err) => {
                console.error('❌ AllTick WS Error:', err.message);
                this.isWsConnected = false;
                this._startPolling(); // fallback immediately
            });

            this.ws.on('close', () => {
                if (this.isWsConnected) {
                    console.log('🔌 AllTick WebSocket Closed');
                }
                this.isWsConnected = false;
                this._stopHeartbeat();
                if (this.isRunning) {
                    this._retryConnection();
                }
            });
        } catch (err) {
            console.error('❌ AllTick WS Connection Exception:', err.message);
            this._startPolling();
        }
    }

    _retryConnection() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            console.log(`🔄 AllTick reconnect in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this._connectWs(), delay);
        } else {
            console.warn('⚠️  AllTick WS max reconnects reached — staying on HTTP polling.');
            this._startPolling();
        }
    }

    _closeWs() {
        if (this.ws) {
            try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        this.isWsConnected = false;
        this._stopHeartbeat();
    }

    // ─────────────────────────────────────────────────────────
    //  Heartbeat
    // ─────────────────────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    cmd_id: 22000,
                    seq_id: Date.now(),
                    trace: 'heartbeat'
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
    //  Subscription
    // ─────────────────────────────────────────────────────────

    _subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const symbolList = [...this.forexSymbols, ...this.cryptoSymbols]
            .map(sym => ({ symbol: sym }));

        const subMsg = {
            cmd_id: 22002,
            seq_id: Date.now(),
            trace: 'sub_quotes',
            data: { symbol_list: symbolList }
        };

        this.ws.send(JSON.stringify(subMsg));
        console.log(`📡 AllTick subscribed to ${symbolList.length} symbols`);
    }

    // ─────────────────────────────────────────────────────────
    //  Message Handling
    // ─────────────────────────────────────────────────────────

    _handleWsMessage(msg) {
        // AllTick tick push: cmd_id 22004, data contains tick(s)
        if (!msg || !msg.data) return;

        if (msg.cmd_id === 22004) {
            const data = msg.data;
            if (Array.isArray(data)) {
                data.forEach(tick => this._processTick(tick));
            } else if (data && data.symbol) {
                this._processTick(data);
            }
        } else if (msg.cmd_id === 22000) {
            // Heartbeat pong — ignore silently
        }
    }

    _processTick(tick) {
        if (!tick || !tick.symbol) return;

        const symbol   = tick.symbol;
        const isForex  = this.forexSymbols.includes(symbol);
        const isCrypto = this.cryptoSymbols.includes(symbol);
        if (!isForex && !isCrypto) return;

        // AllTick field names: bid, ask, last (or close_price), chg, vol
        const bid = parseFloat(tick.bid  || tick.open  || tick.last || tick.close_price || 0);
        const ask = parseFloat(tick.ask  || tick.open  || tick.last || tick.close_price || 0);
        const ltp = parseFloat(tick.last || tick.close_price || ((bid + ask) / 2) || 0);

        if (!ltp || isNaN(ltp)) return; // Skip invalid/zero ticks

        // Seed previousClose on first tick (used for % change)
        if (!this.prevCloseCache[symbol]) {
            this.prevCloseCache[symbol] = ltp;
        }

        const dataToFormat = {
            bid,
            ask,
            ltp,
            previousClose: this.prevCloseCache[symbol],
            volume: tick.vol || tick.volume || '-',
            change: tick.chg || tick.change || 0
        };

        // Update prevClose slowly — use current ltp so next tick shows real delta
        // (prevClose is only updated when we get a genuine previous-close field)
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
    //  Broadcast to MarketDataService (price store)
    // ─────────────────────────────────────────────────────────

    _broadcast(item) {
        try {
            const mds = require('./MarketDataService');
            if (!mds || !mds.prices) return;

            const prefix              = item.type; // 'FOREX' | 'CRYPTO'
            const instrument          = item.instrument; // 'EUR/USD'
            const slashedSymbol       = `${prefix}:${instrument}`;
            const unslashedInstrument = instrument.replace('/', '');
            const unslashedSymbol     = `${prefix}:${unslashedInstrument}`;

            const base = {
                ...item,
                category: prefix.toLowerCase()
            };

            // Store under slashed key (e.g. FOREX:EUR/USD)
            mds.prices[slashedSymbol] = {
                ...mds.prices[slashedSymbol],
                ...base,
                symbol: slashedSymbol,
                name: instrument
            };
            mds.dirtySymbols.add(slashedSymbol);

            // Store under unslashed key (e.g. FOREX:EURUSD) for backward compat
            mds.prices[unslashedSymbol] = {
                ...mds.prices[unslashedSymbol],
                ...base,
                instrument: unslashedInstrument,
                symbol: unslashedSymbol,
                name: unslashedInstrument
            };
            mds.dirtySymbols.add(unslashedSymbol);
        } catch (err) {
            // Never crash the feed due to broadcast error
            console.error('⚠️  AllTick broadcast error:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    //  HTTP Polling Fallback
    // ─────────────────────────────────────────────────────────

    _startPolling() {
        if (this.pollingInterval || this.isWsConnected) return;
        console.log('🔄 AllTick falling back to HTTP polling (1s interval)...');
        this._poll(); // immediate first call
        this.pollingInterval = setInterval(() => this._poll(), 1000);
    }

    _stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    async _poll() {
        if (!this.token || !this.isRunning || this.isWsConnected) return;

        try {
            // AllTick batch-kline endpoint — POST with JSON body
            // symbol_list: array of { symbol, kline_type, kline_timestamp_end, query_kline_num }
            // For latest tick (not kline), we use query_kline_num=1 with kline_type=1 (1-min)
            const allSymbols = [...this.forexSymbols, ...this.cryptoSymbols];
            const symbolList = allSymbols.map(sym => ({
                symbol: sym,
                kline_type: 1,          // 1-minute kline
                kline_timestamp_end: 0, // 0 = latest
                query_kline_num: 1      // only need the latest candle
            }));

            const response = await axios.post(
                `${HTTP_URL}?token=${this.token}`,
                { symbol_list: symbolList },
                {
                    timeout: 5000,
                    headers: { 'Content-Type': 'application/json' }
                }
            );

            const respData = response.data;
            if (!respData) return;

            // AllTick HTTP response: { code, msg, data: { kline_list: [...] } }
            // OR: { code, data: [ { symbol, kline_list: [...] } ] }
            const dataBlock = respData.data;
            if (!dataBlock) return;

            if (Array.isArray(dataBlock)) {
                // Format: [ { symbol, kline_list: [{open,high,low,close,vol,...}] } ]
                dataBlock.forEach(entry => {
                    if (!entry.symbol || !Array.isArray(entry.kline_list) || !entry.kline_list.length) return;
                    const kline = entry.kline_list[entry.kline_list.length - 1]; // most recent candle
                    this._processTick({
                        symbol: entry.symbol,
                        last: kline.close,
                        bid:  kline.close,
                        ask:  kline.close,
                        vol:  kline.vol || kline.volume || '-',
                        pre_close_price: kline.open // use open as prevClose proxy
                    });
                });
            } else if (dataBlock.kline_list && Array.isArray(dataBlock.kline_list)) {
                // Alternative format with a flat kline_list
                dataBlock.kline_list.forEach(entry => {
                    if (!entry.symbol) return;
                    this._processTick({
                        symbol: entry.symbol,
                        last: entry.close,
                        bid:  entry.close,
                        ask:  entry.close,
                        vol:  entry.vol || '-'
                    });
                });
            }
        } catch (err) {
            if (err.code !== 'ECONNABORTED') {
                console.error('⚠️  AllTick HTTP Poll Error:', err.message);
            }
        }
    }
}

module.exports = new AllTickService();
