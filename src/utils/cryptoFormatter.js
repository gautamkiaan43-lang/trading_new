/**
 * Crypto Formatter Utility
 * Formats raw AllTick data into the frontend-compatible object
 */

const formatCryptoData = (instrument, data) => {
    // Ensure instrument is in format like "BTC/USD"
    let formattedInstrument = instrument;
    if (instrument && !instrument.includes('/')) {
        // BTCUSD -> BTC/USD
        if (instrument.endsWith('USD')) {
            const base = instrument.replace(/USD$/, '');
            formattedInstrument = `${base}/USD`;
        }
    }

    const bid = parseFloat(data.bid || data.price || 0);
    const ask = parseFloat(data.ask || data.price || 0);
    const ltp = data.ltp || (bid + ask) / 2;
    
    // Change calculation if not provided directly
    let change = data.change || 0;
    if (data.previousClose && data.previousClose !== 0) {
        change = ((ltp - data.previousClose) / data.previousClose) * 100;
    }

    return {
        instrument: formattedInstrument,
        type: "CRYPTO",
        bid: parseFloat(bid.toFixed(2)),
        ask: parseFloat(ask.toFixed(2)),
        ltp: parseFloat(ltp.toFixed(2)),
        expiry: "-",
        strike: "-",
        opt: "-",
        change: parseFloat(change.toFixed(2)),
        volume: data.volume || "-"
    };
};

module.exports = { formatCryptoData };
