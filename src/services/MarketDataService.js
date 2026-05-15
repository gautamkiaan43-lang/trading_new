const { KiteTicker } = require('kiteconnect');
const socketManager = require('../websocket/SocketManager');
const EventEmitter = require('events');
const WebSocket = require('ws');
const axios = require('axios');
const alertMonitor = require('./alertMonitorService'); // ✅ Import alert monitor

// ── Binance Config ──
const BINANCE_REST_BASE = 'https://api.binance.com/api/v3';
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';

let CRYPTO_SYMBOLS_LIST = [];
let FOREX_SYMBOLS_LIST = [];


let SYMBOL_META = {};

// ── FastForex Integration ──
const fastForexService = require('./fastforex.service');

/**
 * Optimized MarketDataService
 * - Production-level accuracy for Binance (miniTicker + bookTicker)
 * - Efficient batched broadcasting (150ms)
 * - Memory-efficient state management with prefixed symbols
 * - Intelligent reconnect and error handling
 */
class MarketDataService extends EventEmitter {
    constructor() {
        super();
        this.ticker = null;
        this.isConnecting = false;

        // Unified State Management
        // Key format: "CRYPTO:BTC/USD", "FOREX:XAU/USD", "NSE:RELIANCE"
        this.prices = {};
        this.dirtySymbols = new Set();

        // Subscription Sets
        this.subscribedTokens = new Set();
        this.subscribedSymbols = new Set();
        this.instrumentMap = {}; // token -> Set of symbols

        // Binance Connection State
        this.binanceWs = null;
        this.isBinanceActive = false;
        this.binanceReconnectAttempts = 0;
        this.binanceError = null; // Track Binance specific errors
        this.isBinanceBlocked = false; // Persistent block flag
        this.binanceToFrontend = {};
        this.frontendToBinance = {};

        // Forex Polling State
        this.forexInterval = null;

        // Broadcasting Optimization
        this.broadcastInterval = 150; // ms
        this.broadcastTimer = null;

        this._initMappings();
        this._loadSymbolsFromDb();
        this._startBroadcastLoop();
    }

    async _loadSymbolsFromDb() {
        try {
            const db = require('../config/db');
            
            // Load Crypto
            const [cryptoRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi 
                JOIN market_groups mg ON mgi.group_id = mg.id 
                WHERE mg.name = 'CRYPTO'
            `);
            CRYPTO_SYMBOLS_LIST = cryptoRows.map(r => r.symbol);

            // Load Forex
            const [forexRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi 
                JOIN market_groups mg ON mgi.group_id = mg.id 
                WHERE mg.name = 'FOREX'
            `);
            FOREX_SYMBOLS_LIST = forexRows.map(r => r.symbol);

            // Load All Metadata
            const [metaRows] = await db.execute(`
                SELECT symbol, name, category FROM market_group_items 
                WHERE category IS NOT NULL
            `);
            const newMeta = {};
            metaRows.forEach(r => {
                newMeta[r.symbol] = { name: r.name, category: r.category };
            });
            SYMBOL_META = newMeta;

            console.log(`✅ Loaded ${CRYPTO_SYMBOLS_LIST.length} Crypto, ${FOREX_SYMBOLS_LIST.length} Forex, and ${Object.keys(SYMBOL_META).length} Meta entries from DB`);
            
            this._initMappings(); // Re-run mappings with new symbols
        } catch (err) {
            console.error('❌ Failed to load market data symbols from DB:', err.message);
        }
    }

    _initMappings() {
        CRYPTO_SYMBOLS_LIST.forEach(sym => {
            const bSym = sym.replace("/", "") + "T"; // BTC/USD -> BTCUSDT
            this.frontendToBinance[sym] = bSym.toLowerCase();
            this.binanceToFrontend[bSym.toUpperCase()] = sym;
        });
    }

    /**
     * Start the broadcasting loop to batch updates
     */
    _startBroadcastLoop() {
        if (this.broadcastTimer) return;
        this.broadcastTimer = setInterval(() => {
            if (this.dirtySymbols.size === 0) return;



            const updates = {};
            this.dirtySymbols.forEach(sym => {
                if (this.prices[sym]) {
                    updates[sym] = { ...this.prices[sym] };

                    // ✅ CHECK PRICE ALERTS FOR THIS SYMBOL
                    const ltp = this.prices[sym].ltp || this.prices[sym].price || 0;
                    if (ltp > 0) {
                        const cleanSymbol = sym.includes(':') ? sym.split(':')[1] : sym;
                        alertMonitor.checkAlerts(cleanSymbol, ltp);
                    }
                }
            });

            // ✅ REMOVED MOCK FLUCTUATOR - Only broadcast real API updates
            // This ensures data integrity and prevents price jumps from real-to-mock.

            this.dirtySymbols.clear();

            const io = socketManager.getIo();
            if (io) {
                io.emit('price_update', updates);
                // ✅ Initialize alert monitor with io instance (first time)
                if (!alertMonitor.io) {
                    alertMonitor.init(io);
                }
            }
            this.emit('update', updates);
        }, this.broadcastInterval);
    }

    // ══════════════════════════════════════════════════════
    //   ZERODHA (KITE) INTEGRATION
    // ══════════════════════════════════════════════════════

    async init(userId) {
        if (this.isConnecting) return;
        this.isConnecting = true;
        try {
            if (this.ticker) {
                try { this.ticker.disconnect(); } catch(e) {}
                this.ticker = null;
            }
            // Check if Zerodha is configured
            if (!process.env.KITE_API_KEY) {
                console.warn('⚠️ KITE_API_KEY not configured - Zerodha disabled');
                this.isConnecting = false;
                return;
            }

            const repo = require('../repositories/KiteRepository');
            const kiteService = require('../utils/kiteService');
            const userSession = await repo.getSessionByUserId(userId);
            const activeToken = kiteService.accessToken || (userSession ? userSession.access_token : null);

            if (!activeToken) {
                console.warn('⚠️ No valid Zerodha session found for user - using mock engine');
                this.isConnecting = false;
                return;
            }

            console.log(`🔌 Initializing KiteTicker with token: ${activeToken.substring(0, 6)}...`);
            this.ticker = new KiteTicker({
                api_key: process.env.KITE_API_KEY,
                access_token: activeToken
            });

            this.ticker.autoReconnect(false); // Disable auto-reconnect initially

            let errorOccurred = false;

            this.ticker.on('connect', () => {
                console.log('✅ Zerodha Ticker Connected');
                if (!this.ticker) return;

                // Always subscribe NSE Indices (hardcoded Zerodha tokens)
                const INDEX_TOKENS = [
                    { token: 256265, symbol: 'NSE:NIFTY 50' },
                    { token: 260105, symbol: 'NSE:NIFTY BANK' },
                    { token: 257801, symbol: 'NSE:NIFTY FIN SERVICE' },
                ];
                INDEX_TOKENS.forEach(i => {
                    const sToken = String(i.token);
                    if (!this.instrumentMap[sToken]) this.instrumentMap[sToken] = new Set();
                    this.instrumentMap[sToken].add(i.symbol);
                    this.subscribedTokens.add(sToken);
                });

                // Resubscribe all tracked tokens safely
                const tokenNums = Array.from(this.subscribedTokens).map(t => parseInt(t, 10)).filter(t => !isNaN(t));
                if (tokenNums.length > 0 && this.ticker) {
                    try {
                        this.ticker.subscribe(tokenNums);
                        this.ticker.setMode(this.ticker.modeFull, tokenNums);
                        console.log(`📊 Subscribed to ${tokenNums.length} tokens including NSE Indices`);
                    } catch (subErr) {
                        console.error('⚠️ Subscribe error on connect:', subErr.message);
                    }
                }
            });

            this.ticker.on('ticks', (ticks) => {
                this.handleTicks(ticks);
            });

            this.ticker.on('error', (err) => {
                const errMsg = err?.message || String(err);
                console.error('⚠️ Zerodha Ticker Error:', errMsg);

                // Handle 403 Forbidden — token expired
                if (errMsg.includes('403') || errMsg.includes('Forbidden')) {
                    console.error('❌ Zerodha 403 Forbidden - Access token expired or invalid');
                    console.log('💡 Solution: Need to login again at Zerodha');
                    errorOccurred = true;
                    try { this.ticker?.disconnect(); } catch(e) {}
                    this.ticker = null;
                    return;
                }

                // Other errors
                console.error('❌ Critical Zerodha Error:', errMsg);
                errorOccurred = true;
                this.ticker = null;
            });

            this.ticker.on('disconnect', () => {
                console.log('🔌 Zerodha Ticker Disconnected');
                if (this.ticker && !errorOccurred) {
                    this.ticker = null;
                }
            });

            this.ticker.on('noreconnect', () => {
                console.log('⛔ Zerodha Ticker: Max reconnect attempts reached');
                errorOccurred = true;
                this.ticker = null;
            });

            try {
                this.ticker.connect();
                // Give ticker 5 seconds to connect before timing out
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        if (!this.ticker || !this.ticker.connected) {
                            console.error('⏱️ Zerodha Ticker connection timeout');
                            errorOccurred = true;
                            this.ticker = null;
                        }
                        resolve();
                    }, 5000);
                });
            } catch (connectErr) {
                console.error('❌ Failed to connect Zerodha Ticker:', connectErr.message);
                errorOccurred = true;
                this.ticker = null;
            }
        } catch (err) {
            console.error('⚠️ Zerodha Ticker init failed:', err.message);
            this.ticker = null;
        } finally {
            this.isConnecting = false;
            if (this.ticker === null || !this.ticker?.connected) {
                console.log('ℹ️ Zerodha unavailable - will use mock engine for market data');
            }
        }
    }

    handleTicks(ticks) {
        // Index symbols that don't have order book depth
        const INDEX_SYMBOLS = new Set(['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY FIN SERVICE']);

        ticks.forEach(tick => {
            const token = String(tick.instrument_token);
            const symbols = this.instrumentMap[token] || new Set([token]);
            
            symbols.forEach(symbol => {
                const prev = this.prices[symbol] || {};

                const buy0 = tick.depth?.buy?.[0]?.price;
                const sell0 = tick.depth?.sell?.[0]?.price;
                const hasBid = buy0 != null && Number.isFinite(Number(buy0));
                const hasAsk = sell0 != null && Number.isFinite(Number(sell0));

                const ltp = tick.last_price != null ? tick.last_price : prev.ltp;
                const isIndex = INDEX_SYMBOLS.has(symbol);

                const data = {
                    ...prev,
                    symbol,
                    ltp,
                    // For indices: no order book, so bid = ask = ltp
                    bid: hasBid ? Number(buy0) : (isIndex ? ltp : (prev.bid || 0)),
                    ask: hasAsk ? Number(sell0) : (isIndex ? ltp : (prev.ask || 0)),
                    change: tick.net_change != null ? tick.net_change : prev.change,
                    volume: tick.volume_traded != null ? tick.volume_traded : prev.volume,
                    ohlc: tick.ohlc && Object.keys(tick.ohlc).length ? tick.ohlc : (prev.ohlc || {}),
                    depth: tick.depth && (tick.depth.buy?.length || tick.depth.sell?.length) ? tick.depth : (prev.depth || {}),
                    type: (symbol.startsWith('NSE') || symbol.startsWith('NFO') || symbol.startsWith('MCX')) ? symbol.split(':')[0] : (prev.type || 'NSE')
                };

                this.prices[symbol] = data;
                this.dirtySymbols.add(symbol);
            });
        });
    }

    subscribe(symbol, token) {
        if (!token) {
            this.subscribedSymbols.add(symbol);
            return;
        }

        const sToken = String(token);
        if (!this.instrumentMap[sToken]) this.instrumentMap[sToken] = new Set();
        this.instrumentMap[sToken].add(symbol);
        this.subscribedTokens.add(sToken);

        if (this.ticker && this.ticker.connected) {
            this.ticker.subscribe([parseInt(sToken)]);
            this.ticker.setMode(this.ticker.modeFull, [parseInt(sToken)]);
        }
    }

    bulkSubscribe(items = []) {
        if (!Array.isArray(items) || items.length === 0) return;

        const tokenNums = [];
        for (const item of items) {
            if (!item?.symbol) continue;
            if (!item.token) {
                this.subscribe(item.symbol);
                continue;
            }

            const sToken = String(item.token);
            if (!this.instrumentMap[sToken]) this.instrumentMap[sToken] = new Set();
            this.instrumentMap[sToken].add(item.symbol);
            this.subscribedTokens.add(sToken);
            tokenNums.push(parseInt(sToken, 10));
        }

        if (this.ticker && this.ticker.connected && tokenNums.length > 0) {
            this.ticker.subscribe(tokenNums);
            this.ticker.setMode(this.ticker.modeFull, tokenNums);
        }
    }

    startMockEngine() {
        console.log('ℹ️ Mock Engine requested but disabled in favor of real feeds.');
    }

    stopMockEngine() {
        // Placeholder
    }

    resubscribe() {
        if (!this.ticker || !this.ticker.connected) return;
        const tokens = Array.from(this.subscribedTokens).map(t => parseInt(t));
        if (tokens.length > 0) {
            this.ticker.subscribe(tokens);
            this.ticker.setMode(this.ticker.modeFull, tokens);
        }
    }

    // ══════════════════════════════════════════════════════
    //   BINANCE INTEGRATION (Crypto)
    // ══════════════════════════════════════════════════════

    async startCryptoForex() {
        if (this.isBinanceActive) return;
        this.isBinanceActive = true;
        console.log('🌐 Starting Optimized Binance (Crypto) + FastForex feeds');

        // 1. Snapshot via REST for initial LTP and 24h stats
        await this._fetchInitialBinanceData();

        // 2. Connect WebSocket for Real-time LTP/Bid/Ask
        this._connectBinanceWs();

        // 3. Start FastForex Integration Service
        fastForexService.start();
    }

    async _fetchInitialBinanceData() {
        try {
            this.binanceError = null; // Reset
            const bSymbols = CRYPTO_SYMBOLS_LIST.map(s => this.frontendToBinance[s].toUpperCase());
            const symbolsParam = JSON.stringify(bSymbols);
            const url = `${BINANCE_REST_BASE}/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`;

            const response = await axios.get(url);

            if (response.data && Array.isArray(response.data)) {
                response.data.forEach(item => {
                    const frontendSym = this.binanceToFrontend[item.symbol];
                    if (!frontendSym) return;

                    const symbolKey = `CRYPTO:${frontendSym}`;
                    const meta = SYMBOL_META[frontendSym] || { name: frontendSym, category: 'crypto' };

                    this.prices[symbolKey] = {
                        ...this.prices[symbolKey],
                        symbol: symbolKey,
                        name: meta.name,
                        category: meta.category,
                        type: 'CRYPTO',
                        ltp: parseFloat(item.lastPrice),
                        change: parseFloat(item.priceChange),
                        chg_pct: item.priceChangePercent,
                        direction: parseFloat(item.priceChange) >= 0 ? 'up' : 'down'
                    };
                    this.dirtySymbols.add(symbolKey);
                });
            }
        } catch (err) {
            this.binanceError = `Binance Blocked: ${err.message}`;
            console.error('⚠️ Binance Snapshot Error:', err.message);
        }
    }

    _connectBinanceWs() {
        if (!this.isBinanceActive) return;

        const bSymbols = CRYPTO_SYMBOLS_LIST.map(s => this.frontendToBinance[s]);
        const streams = bSymbols.map(s => `${s}@miniTicker/${s}@bookTicker`).join('/');
        const url = `${BINANCE_WS_BASE}${streams}`;

        if (this.binanceWs) {
            try { this.binanceWs.close(); } catch (e) { }
        }

        this.binanceWs = new WebSocket(url);

        this.binanceWs.on('open', () => {
            console.log('⚡ Binance WebSocket Connected');
            this.binanceReconnectAttempts = 0;
            this.isBinanceBlocked = false; // Reset if successful
        });

        this.binanceWs.on('message', (data) => {
            try {
                this._handleBinanceMessage(JSON.parse(data));
            } catch (e) {
                console.error('⚠️ Binance Msg Parse Error:', e.message);
            }
        });

        this.binanceWs.on('error', (err) => {
            const errMsg = err.message || String(err);
            console.error('⚠️ Binance WS Error:', errMsg);

            // Detect 451 (Unavailable For Legal Reasons) - Persistent block
            if (errMsg.includes('451')) {
                console.error('🚫 Binance is blocked in this region (Error 451). Switching to Twelve Data fallback for Crypto.');
                this.isBinanceBlocked = true;
                this.isBinanceActive = false; // Stop trying
                this.binanceWs.close();
            }
        });

        this.binanceWs.on('close', () => {
            if (this.isBinanceActive && !this.isBinanceBlocked) {
                const delay = Math.min(1000 * Math.pow(2, this.binanceReconnectAttempts), 30000);
                console.log(`🔄 Binance WS closed. Reconnecting in ${delay / 1000}s...`);
                setTimeout(() => {
                    this.binanceReconnectAttempts++;
                    this._connectBinanceWs();
                }, delay);
            } else if (this.isBinanceBlocked) {
                console.log('ℹ️ Binance WS closed due to regional block. Reconnection disabled.');
            }
        });
    }

    _handleBinanceMessage(msg) {
        if (!msg.data || !msg.stream) return;

        const streamParts = msg.stream.split('@');
        const bSymbol = streamParts[0].toUpperCase();
        const type = streamParts[1]; // miniTicker or bookTicker
        const frontendSym = this.binanceToFrontend[bSymbol];

        if (!frontendSym) return;

        const symbolKey = `CRYPTO:${frontendSym}`;
        const current = this.prices[symbolKey] || {
            symbol: symbolKey,
            type: 'CRYPTO',
            category: 'crypto',
            name: SYMBOL_META[frontendSym]?.name || frontendSym,
            ltp: 0, bid: 0, ask: 0, change: 0, chg_pct: '0.00'
        };

        const data = msg.data;
        let changed = false;

        if (type === 'miniTicker') {
            // Requirement 1: miniTicker for LTP and Change
            const ltp = parseFloat(data.c);
            const open = parseFloat(data.o);
            const change = ltp - open;
            const chg_pct = open !== 0 ? ((change / open) * 100).toFixed(2) : '0.00';

            if (current.ltp !== ltp || current.change !== change) {
                current.ltp = ltp;
                current.change = parseFloat(change.toFixed(4));
                current.chg_pct = chg_pct;
                current.direction = change >= 0 ? 'up' : 'down';
                changed = true;
            }
        } else if (type === 'bookTicker') {
            // Requirement 1: bookTicker for Bid/Ask
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);

            // Requirement 2: Ensure spread is correct (Ask > Bid)
            if (bid > 0 && ask > 0 && ask >= bid) {
                if (current.bid !== bid || current.ask !== ask) {
                    current.bid = bid;
                    current.ask = ask;
                    changed = true;
                }
            } else if (bid > 0 && ask > 0) {
                // Log invalid data cases
                console.warn(`[Binance] Invalid Spread for ${bSymbol}: Bid=${bid}, Ask=${ask}`);
            }
        }

        if (changed) {
            this.prices[symbolKey] = current;
            this.dirtySymbols.add(symbolKey);
        }
    }

    // ══════════════════════════════════════════════════════
    //   FOREX INTEGRATION
    // ══════════════════════════════════════════════════════

    async _fetchExternalData() {
        // Obsolete: Handled by FastForexService
    }

    // ══════════════════════════════════════════════════════
    //   PUBLIC GETTERS
    // ══════════════════════════════════════════════════════

    getPrice(symbol) {
        return this.prices[symbol] || null;
    }

    getPricesBatch(symbols) {
        const result = {};
        if (!Array.isArray(symbols)) return result;
        symbols.forEach(sym => {
            if (this.prices[sym]) result[sym] = this.prices[sym];
        });
        return result;
    }

    getCryptoPrices() {
        return CRYPTO_SYMBOLS_LIST.map(sym => this.prices[`CRYPTO:${sym}`]).filter(Boolean);
    }

    getBinanceError() {
        return this.binanceError;
    }

    getForexPrices() {
        return FOREX_SYMBOLS_LIST.map(sym => this.prices[`FOREX:${sym}`]).filter(Boolean);
    }

    stopCryptoForex() {
        this.isBinanceActive = false;
        if (this.binanceWs) {
            this.binanceWs.close();
            this.binanceWs = null;
        }
        fastForexService.stop();
        console.log('🛑 Stopped Binance + FastForex Integration');
    }

    shutdown() {
        if (this.ticker) {
            this.ticker.disconnect();
            this.ticker = null;
        }
        if (this.broadcastTimer) {
            clearInterval(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.stopCryptoForex();
    }
}

module.exports = new MarketDataService();
