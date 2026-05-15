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
