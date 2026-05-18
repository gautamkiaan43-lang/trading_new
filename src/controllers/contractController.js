const fs = require('fs');
const path = require('path');
const kiteService = require('../utils/kiteService');

const EXCLUDED_FILE = path.join(__dirname, '../data/excluded_contracts.json');
const CONTRACTS_CACHE_FILE = path.join(__dirname, '../data/contracts_cache.json');
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Ensure data directory exists
const dataDir = path.dirname(EXCLUDED_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize or load excluded contracts
let excludedContracts = [];

async function initializeDefaultExclusions() {
    try {
        const allKite = await getAllContractsFromKite();
        // Exclude all NSE and NFO by default, keep MCX only
        const nseNfoSymbols = allKite
            .filter(c => c.segment === 'NSE' || c.segment === 'NFO')
            .map(c => c.symbol);

        excludedContracts = nseNfoSymbols;
        global.EXCLUDED_CONTRACTS = excludedContracts;

        console.log(`[contractController] Default exclusions initialized: ${nseNfoSymbols.length} NSE/NFO symbols disabled, MCX enabled`);

        // Save to file
        fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(excludedContracts, null, 2));
    } catch (err) {
        console.error('Error initializing default exclusions:', err.message);
    }
}

function loadExcludedContracts() {
    try {
        if (fs.existsSync(EXCLUDED_FILE)) {
            const data = fs.readFileSync(EXCLUDED_FILE, 'utf8');
            excludedContracts = JSON.parse(data) || [];
            global.EXCLUDED_CONTRACTS = excludedContracts;
            console.log(`[contractController] Loaded ${excludedContracts.length} excluded contracts`);
        } else {
            console.log('[contractController] No exclusion file found. Will initialize defaults on first API call.');
            excludedContracts = [];
            global.EXCLUDED_CONTRACTS = [];
        }
    } catch (err) {
        console.error('Error loading excluded contracts:', err.message);
        excludedContracts = [];
        global.EXCLUDED_CONTRACTS = [];
    }
}

// Cache for all contracts from Kite API
let allContractsCache = null;
let cacheTimestamp = 0;

/**
 * Parse FUT contracts from Kite instruments — MCX + NFO + NSE exchanges.
 */
function parseContractsFromKite(instruments) {
    const contracts = [];
    const seen = new Set();
    const SUPPORTED = new Set(['MCX', 'NFO', 'NSE']);

    instruments.forEach(instr => {
        if (!SUPPORTED.has(instr.exchange)) return;
        if (String(instr.instrument_type || '').toUpperCase() !== 'FUT') return;
        if (!instr.tradingsymbol) return;
        if (instr.expiry && new Date(instr.expiry) < new Date()) return;

        const symbol = `${instr.exchange}:${instr.tradingsymbol}`;
        if (seen.has(symbol)) return;
        seen.add(symbol);

        const match = instr.tradingsymbol.match(/^([A-Z&]+)(\d{1,2}[A-Z]{3}\d{0,2})FUT$/);
        if (match) {
            const [, name, expiry] = match;
            contracts.push({
                symbol,
                name: instr.name || name,
                trading_symbol: instr.tradingsymbol,
                expiry,
                segment: instr.exchange,
                instrument_token: instr.instrument_token,
                lot_size: instr.lot_size || null
            });
        }
    });

    const ORDER = { MCX: 0, NFO: 1, NSE: 2 };
    contracts.sort((a, b) => {
        const segDiff = (ORDER[a.segment] ?? 9) - (ORDER[b.segment] ?? 9);
        if (segDiff !== 0) return segDiff;
        return a.name.localeCompare(b.name) || a.expiry.localeCompare(b.expiry);
    });

    return contracts;
}

async function getAllContractsFromKite() {
    try {
        if (allContractsCache && (Date.now() - cacheTimestamp) < CACHE_DURATION) {
            return allContractsCache;
        }
        const instruments = await kiteService.getInstruments();
        const contracts = parseContractsFromKite(instruments);
        allContractsCache = contracts;
        cacheTimestamp = Date.now();
        try {
            fs.writeFileSync(CONTRACTS_CACHE_FILE, JSON.stringify({ timestamp: cacheTimestamp, data: contracts }, null, 2));
        } catch (e) { }
        return contracts;
    } catch (err) {
        try {
            if (fs.existsSync(CONTRACTS_CACHE_FILE)) {
                const cached = JSON.parse(fs.readFileSync(CONTRACTS_CACHE_FILE, 'utf8'));
                allContractsCache = cached.data;
                cacheTimestamp = cached.timestamp;
                return cached.data;
            }
        } catch (e) { }
        return [];
    }
}

loadExcludedContracts();

// Returns array of excluded symbols
function getExcludedSymbols() {
    return excludedContracts.slice();
}

// ─── Cache Versioning ───
// This is tracked globally to force watchlist refresh when selection changes
global.WATCHLIST_CONFIG_VERSION = Date.now();

function _bustWatchlistCache() {
    global.WATCHLIST_CONFIG_VERSION = Date.now();
    console.log('🔄 Watchlist Config Version Updated:', global.WATCHLIST_CONFIG_VERSION);
}

// Get all available contracts
exports.getAllContracts = async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(403).json({
                status: 'error',
                message: 'Kite not connected. Please login first to manage contracts.'
            });
        }
        const allContracts = await getAllContractsFromKite();
        const contracts = allContracts.map(contract => ({
            ...contract,
            isSelected: !excludedContracts.includes(contract.symbol)
        }));
        res.json({ status: 'success', total: contracts.length, data: contracts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Get selected contracts only (for backward compat if needed)
exports.getSelectedContracts = async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(403).json({
                status: 'error',
                message: 'Kite not connected.'
            });
        }
        const allContracts = await getAllContractsFromKite();
        const selected = allContracts.filter(contract => !excludedContracts.includes(contract.symbol));
        res.json({ status: 'success', count: selected.length, data: selected.map(c => c.symbol) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Save selection
exports.saveContractSelection = async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(403).json({
                status: 'error',
                message: 'Kite not connected. Action denied.'
            });
        }
        const { contracts } = req.body; // symbols that WERE SELECTED (checked)
        if (!Array.isArray(contracts)) {
            return res.status(400).json({ error: 'contracts must be an array' });
        }
        const allContracts = await getAllContractsFromKite();
        const allSymbols = allContracts.map(c => c.symbol);

        // Excluded = All - Selected
        const excluded = allSymbols.filter(sym => !contracts.includes(sym));
        excludedContracts = excluded;
        global.EXCLUDED_CONTRACTS = excluded;
        fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(excluded, null, 2));
        _bustWatchlistCache();

        // Broadcast to all connected users to refresh their snapshot (and exclusions)
        try {
            const socketManager = require('../websocket/SocketManager');
            socketManager.broadcastMarketSnapshotRefresh();
        } catch (err) {
            console.error('Failed to broadcast snapshot refresh:', err.message);
        }

        res.json({ status: 'success', message: 'Selection updated', excluded_count: excluded.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.searchContracts = async (req, res) => {
    try {
        const { q } = req.query;
        const searchTerm = (q || '').toLowerCase();

        // Initialize default exclusions on first call
        if (excludedContracts.length === 0 && !fs.existsSync(EXCLUDED_FILE)) {
            await initializeDefaultExclusions();
        }

        let kiteContracts = [];
        // Only fetch Kite contracts if authenticated, otherwise return empty for Kite part
        if (kiteService.isAuthenticated()) {
            const allKite = await getAllContractsFromKite();
            kiteContracts = allKite.filter(c =>
                c.name.toLowerCase().includes(searchTerm) ||
                c.symbol.toLowerCase().includes(searchTerm)
            ).map(c => ({
                ...c,
                isSelected: !excludedContracts.includes(c.symbol)
            }));
        }

        // --- Include Crypto & Forex from MarketDataService ---
        const marketDataService = require('../services/MarketDataService');
        const cryptoData = marketDataService.getCryptoPrices().filter(c =>
            c.symbol.toLowerCase().includes(searchTerm) || (c.name || '').toLowerCase().includes(searchTerm)
        ).map(c => ({
            symbol: c.symbol,
            name: c.name,
            segment: 'CRYPTO',
            type: 'CRYPTO',
            isSelected: false
        }));

        const forexData = marketDataService.getForexPrices().filter(f =>
            f.symbol.toLowerCase().includes(searchTerm) || (f.name || '').toLowerCase().includes(searchTerm)
        ).map(f => ({
            symbol: f.symbol,
            name: f.name,
            segment: 'FOREX',
            type: 'FOREX',
            isSelected: false
        }));

        const combined = [...kiteContracts, ...cryptoData, ...forexData];

        res.json({
            status: 'success',
            total: combined.length,
            data: combined,
            kite_connected: kiteService.isAuthenticated()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getExcludedSymbols = getExcludedSymbols;

// ════════════════════════════════════════════════════════════════════════════
// SMART ROLLOVER SUGGESTION SYSTEM
// These handlers extend the existing contract management without touching any
// existing logic, socket flow, watchlist behavior, or trading calculations.
// ════════════════════════════════════════════════════════════════════════════

const rolloverService = require('../services/rolloverSuggestionService');

/**
 * GET /api/contracts/rollover/suggestions
 * Returns current rollover config + suggestions (if enabled).
 */
exports.getRolloverSuggestions = async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.json({ status: 'success', enabled: rolloverService.isEnabled(), suggestions: [] });
        }
        const instruments = await kiteService.getInstruments().catch(() => []);
        const allContracts = getMarketWatchContracts(instruments);
        const result = rolloverService.getSuggestions(allContracts, excludedContracts);
        res.json({ status: 'success', ...result });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
};

/**
 * POST /api/contracts/rollover/config
 * Body: { enabled: true | false }
 * Enables or disables the Smart Rollover system.
 * Does NOT affect live quotes, sockets, search, order flow, or watchlists.
 */
exports.setRolloverConfig = (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ status: 'error', error: '"enabled" must be a boolean' });
        }
        const cfg = rolloverService.setEnabled(enabled);
        res.json({ status: 'success', config: cfg, message: enabled ? 'Smart Rollover enabled' : 'Smart Rollover disabled' });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
};

/**
 * POST /api/contracts/rollover/enable-next
 * Body: { next_contract: "NFO:NIFTY25JUNFUT", current_contract: "NFO:NIFTY28MAYFUT" }
 *
 * One-click rollover action:
 *   1. Removes next_contract from excluded list (enables it)
 *   2. Keeps current_contract active (until its own expiry)
 *   3. Updates WATCHLIST_CONFIG_VERSION
 *   4. Broadcasts socket refresh to all connected clients
 */
exports.enableNextContract = async (req, res) => {
    try {
        const { next_contract, current_contract } = req.body;
        if (!next_contract) {
            return res.status(400).json({ status: 'error', error: 'next_contract is required' });
        }

        // Remove next_contract from excluded list (activate it)
        const newExcluded = excludedContracts.filter(sym => sym !== next_contract);
        excludedContracts = newExcluded;
        global.EXCLUDED_CONTRACTS = newExcluded;

        const fs = require('fs');
        const path = require('path');
        const EXCLUDED_FILE = path.join(__dirname, '../data/excluded_contracts.json');
        fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(newExcluded, null, 2));

        _bustWatchlistCache();

        // Broadcast socket refresh (same as save-selection)
        try {
            const socketManager = require('../websocket/SocketManager');
            socketManager.broadcastMarketSnapshotRefresh();
        } catch (sockErr) {
            console.error('Rollover socket broadcast failed:', sockErr.message);
        }

        res.json({
            status: 'success',
            message: `✅ ${next_contract} is now active. ${current_contract ? current_contract + ' remains active.' : ''}`,
            enabled_contract: next_contract,
            excluded_count: newExcluded.length
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
};

/**
 * POST /api/contracts/rollover/complete
 * Body: { next_contract: "NFO:NIFTY25JUNFUT", current_contract: "NFO:NIFTY28MAYFUT" }
 * Enables the next contract AND disables the current expiring contract in one click.
 */
exports.completeRollover = async (req, res) => {
    try {
        const { next_contract, current_contract } = req.body;
        if (!next_contract || !current_contract) {
            return res.status(400).json({ status: 'error', error: 'Both next_contract and current_contract are required' });
        }

        // 1. Remove next_contract from excluded list (enable it)
        // 2. Add current_contract to excluded list (disable it)
        let newExcluded = excludedContracts.filter(sym => sym !== next_contract);
        if (!newExcluded.includes(current_contract)) {
            newExcluded.push(current_contract);
        }
        excludedContracts = newExcluded;
        global.EXCLUDED_CONTRACTS = newExcluded;

        const fs = require('fs');
        const path = require('path');
        const EXCLUDED_FILE = path.join(__dirname, '../data/excluded_contracts.json');
        fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(newExcluded, null, 2));

        _bustWatchlistCache();

        // Broadcast socket refresh
        try {
            const socketManager = require('../websocket/SocketManager');
            socketManager.broadcastMarketSnapshotRefresh();
        } catch (sockErr) {
            console.error('Rollover complete socket broadcast failed:', sockErr.message);
        }

        res.json({
            status: 'success',
            message: `✅ Rollover successful! ${next_contract} is active, and expiring ${current_contract} has been disabled.`,
            excluded_count: newExcluded.length
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
};

/**
 * POST /api/contracts/rollover/disable-current
 * Body: { current_contract: "NFO:NIFTY28MAYFUT" }
 * Disables only the expiring contract (if the next contract is already active).
 */
exports.disableCurrentContract = async (req, res) => {
    try {
        const { current_contract } = req.body;
        if (!current_contract) {
            return res.status(400).json({ status: 'error', error: 'current_contract is required' });
        }

        // Add current_contract to excluded list (disable it)
        let newExcluded = excludedContracts.slice();
        if (!newExcluded.includes(current_contract)) {
            newExcluded.push(current_contract);
        }
        excludedContracts = newExcluded;
        global.EXCLUDED_CONTRACTS = newExcluded;

        const fs = require('fs');
        const path = require('path');
        const EXCLUDED_FILE = path.join(__dirname, '../data/excluded_contracts.json');
        fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(newExcluded, null, 2));

        _bustWatchlistCache();

        // Broadcast socket refresh
        try {
            const socketManager = require('../websocket/SocketManager');
            socketManager.broadcastMarketSnapshotRefresh();
        } catch (sockErr) {
            console.error('Disable current socket broadcast failed:', sockErr.message);
        }

        res.json({
            status: 'success',
            message: `✅ Expired/Expiring contract ${current_contract} has been disabled.`,
            excluded_count: newExcluded.length
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/contracts/market-watch-expiries
//
// Returns ALL expiry contracts from Zerodha ONLY for the scripts that are
// actually used in Market Watch (MCX bases + NFO indices + NSE futures).
// This replaces the generic /all endpoint for Contract Management UI so that
// admins only see/manage scripts relevant to the live market watch feed.
//
// Each contract has:
//   isSelected  = true  → currently active (NOT in excluded list)
//   isSelected  = false → excluded / disabled
// ════════════════════════════════════════════════════════════════════════════

// Mirrors the same bases used by kiteRoutes.js buildFutSymbols
const MCX_WATCH_BASES = [
    'GOLD', 'SILVER', 'CRUDEOIL', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NATURALGAS',
    'NICKEL', 'GOLDPETAL', 'GOLDGUINEA', 'COTTON', 'COTTONCNDY', 'MENTHAOIL',
    'GOLDM', 'SILVERM', 'CRUDEOILM', 'ZINCMINI', 'LEADMINI', 'COPPERM', 'NATURALGASMINI',
    'ALUMINI', 'NICKELMINI',
    'MGOLD', 'MCRUDEOIL', 'MSILVER', 'MNATURALGAS', 'MCOPPER', 'MLEAD', 'MZINC', 'MALUMINIUM'
];

const NFO_WATCH_BASES = [
    'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
    // Common NFO stock futures
    'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'AXISBANK', 'SBIN',
    'BAJFINANCE', 'TATAMOTORS', 'TATASTEEL', 'WIPRO', 'HDFC', 'HINDUNILVR',
    'MARUTI', 'SUNPHARMA', 'ONGC', 'POWERGRID', 'NTPC', 'COALINDIA',
    'BPCL', 'HCLTECH', 'LT', 'ITC', 'KOTAKBANK', 'ULTRACEMCO'
];

function getMarketWatchContracts(instruments) {
    const now = new Date();

    // Major option parameters
    const OPTION_STEPS = {
        NIFTY: 50,
        BANKNIFTY: 100,
        FINNIFTY: 50,
        MIDCPNIFTY: 50,
        CRUDEOIL: 100,
        NATURALGAS: 5,
        GOLD: 100,
        SILVER: 250
    };

    const OPTION_DEFAULTS = {
        NIFTY: 22500,
        BANKNIFTY: 48000,
        FINNIFTY: 21500,
        MIDCPNIFTY: 11000,
        CRUDEOIL: 6500,
        NATURALGAS: 160,
        GOLD: 72000,
        SILVER: 82000
    };

    // Cache live prices if available from MarketDataService
    let marketDataService = null;
    try {
        marketDataService = require('../services/MarketDataService');
    } catch (_) {}

    const getLtp = (underlying) => {
        const defaults = OPTION_DEFAULTS[underlying] || 500;
        if (marketDataService) {
            try {
                let key = '';
                if (underlying === 'NIFTY') key = 'NSE:NIFTY 50';
                else if (underlying === 'BANKNIFTY') key = 'NSE:NIFTY BANK';
                else if (underlying === 'FINNIFTY') key = 'NSE:NIFTY FIN SERVICE';
                else if (underlying === 'MIDCPNIFTY') key = 'NSE:NIFTY MID SELECT';
                else key = `MCX:${underlying}FUT`;

                const priceObj = marketDataService.getPrice(key) || marketDataService.getPrice(underlying);
                if (priceObj && priceObj.ltp > 0) return priceObj.ltp;
            } catch (_) {}
        }
        return defaults;
    };

    // Build sets of known bases for fast lookup
    const mcxBaseSet = new Set(MCX_WATCH_BASES.map(b => b.toUpperCase()));
    const nfoBaseSet = new Set(NFO_WATCH_BASES.map(b => b.toUpperCase()));

    // Group unique expiries per exchange + base name + type to restrict option expiries
    const uniqueExpiriesMap = {};
    instruments.forEach(instr => {
        const ex = (instr.exchange || '').toUpperCase();
        const type = (instr.instrument_type || '').toUpperCase();
        const baseName = (instr.name || '').toUpperCase();
        if (!instr.expiry) return;

        const key = `${ex}:${baseName}:${type}`;
        if (!uniqueExpiriesMap[key]) {
            uniqueExpiriesMap[key] = new Set();
        }
        uniqueExpiriesMap[key].add(instr.expiry);
    });

    // Convert sets to sorted arrays
    for (const key of Object.keys(uniqueExpiriesMap)) {
        uniqueExpiriesMap[key] = Array.from(uniqueExpiriesMap[key]).sort((a, b) => new Date(a) - new Date(b));
    }

    const contracts = [];
    const seen = new Set();

    instruments.forEach(instr => {
        const ex = (instr.exchange || '').toUpperCase();
        const type = (instr.instrument_type || '').toUpperCase();
        const sym = (instr.tradingsymbol || '').toUpperCase();
        const baseName = (instr.name || '').toUpperCase();

        if (!instr.tradingsymbol || !instr.expiry) return;

        const expiryDate = new Date(instr.expiry);
        if (isNaN(expiryDate.getTime())) return;
        if (expiryDate < now) return; // skip expired

        let included = false;

        // MCX: Futures & Options for our watch bases
        if (ex === 'MCX') {
            const isWatchBase = mcxBaseSet.has(baseName) || MCX_WATCH_BASES.some(b => sym.startsWith(b.toUpperCase()));
            if (isWatchBase && (type === 'FUT' || type === 'CE' || type === 'PE')) {
                included = true;
            }
        }

        // NFO: Futures & Options for index/stock bases
        if (ex === 'NFO') {
            const isWatchBase = nfoBaseSet.has(baseName) || NFO_WATCH_BASES.some(b => sym.startsWith(b.toUpperCase()));
            if (isWatchBase && (type === 'FUT' || type === 'CE' || type === 'PE')) {
                included = true;
            }
        }

        // NSE: Only Futures for known NFO bases (NSE-listed stock futures)
        if (ex === 'NSE' && type === 'FUT') {
            if (nfoBaseSet.has(baseName)) included = true;
        }

        if (!included) return;

        // Strict Filter for Options to prevent lag (limit to nearest 2 expiries + ATM ±5 strikes)
        if (type === 'CE' || type === 'PE') {
            // Limit options only to major underlyings
            const step = OPTION_STEPS[baseName];
            if (!step) return; // skip non-major options (e.g. stock options)

            // Limit to nearest 2 active expiries
            const expKey = `${ex}:${baseName}:${type}`;
            const expList = uniqueExpiriesMap[expKey] || [];
            const allowedExpiries = expList.slice(0, 2);
            if (!allowedExpiries.includes(instr.expiry)) return;

            // Limit to ATM ± 5 strikes
            const ltp = getLtp(baseName);
            const atm = Math.round(ltp / step) * step;
            const strikeNum = Number(instr.strike);
            const maxRange = step * 5;
            if (Math.abs(strikeNum - atm) > maxRange) return;
        }

        const fullSymbol = `${ex}:${instr.tradingsymbol}`;
        if (seen.has(fullSymbol)) return;
        seen.add(fullSymbol);

        contracts.push({
            symbol: fullSymbol,
            name: instr.name || baseName,
            trading_symbol: instr.tradingsymbol,
            expiry: instr.expiry, // ISO date string from Kite
            segment: ex,
            instrument_type: type,
            lot_size: instr.lot_size || null,
            isSelected: !excludedContracts.includes(fullSymbol)
        });
    });

    // Sort: segment MCX→NFO→NSE, then base name, then expiry asc
    const ORDER = { MCX: 0, NFO: 1, NSE: 2 };
    contracts.sort((a, b) => {
        const segDiff = (ORDER[a.segment] ?? 9) - (ORDER[b.segment] ?? 9);
        if (segDiff !== 0) return segDiff;
        const nameDiff = a.name.localeCompare(b.name);
        if (nameDiff !== 0) return nameDiff;
        return new Date(a.expiry) - new Date(b.expiry);
    });

    return contracts;
}

exports.getMarketWatchExpiries = async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(403).json({
                status: 'error',
                message: 'Kite not connected. Please login first to manage contracts.'
            });
        }

        const instruments = await kiteService.getInstruments();
        const contracts = getMarketWatchContracts(instruments);

        res.json({
            status: 'success',
            total: contracts.length,
            data: contracts
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
};

