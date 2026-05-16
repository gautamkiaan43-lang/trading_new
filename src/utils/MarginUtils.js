const MarginUtils = {
    /**
     * Calculates the total holding margin required for a list of open trades.
     * Uses segments-specific logic (MCX, Equity, Options, Comex, etc.)
     */
    calculateTotalRequiredHoldingMargin(trades, clientConfig) {
        let totalMargin = 0;

        for (const trade of trades) {
            const qtyNum = parseFloat(trade.qty || 0);
            const entryPrice = parseFloat(trade.entry_price || 0);
            const lotSize = parseFloat(trade.lot_size || trade.multiplier || 1);
            const turnover = entryPrice * qtyNum * lotSize;
            let tradeMargin = 0;

            const mType = (trade.market_type || '').toUpperCase();

            if (mType === 'MCX') {
                const brokerMargins = clientConfig.mcxLotMargins || {};
                const upperSym = (trade.symbol || '').toUpperCase();
                const baseScrip = this.getMcxBaseScrip(trade.symbol, brokerMargins);

                // Priority 1: Scrip-specific Lot-wise HOLDING Margin (Fixed Amount or Exposure)
                const scripConfig = brokerMargins[upperSym] || brokerMargins[baseScrip];
                const holdingMarginValue = parseFloat(scripConfig?.HOLDING || scripConfig?.holding_exposure || 0);

                if (holdingMarginValue > 0) {
                    // If it's a fixed amount per lot (usually > 1000) or exposure divisor (usually 100)
                    if (holdingMarginValue > 500) {
                        // Fixed Amount per lot
                        tradeMargin = holdingMarginValue * qtyNum;
                    } else {
                        // Exposure Divisor
                        tradeMargin = turnover / holdingMarginValue;
                    }
                } else {
                    // Priority 2: Global Exposure-based Calculation (HOLDING)
                    const holdingExposure = parseFloat(clientConfig.mcxHoldingMargin || clientConfig.mcx_holding_exposure || 100);
                    tradeMargin = turnover / (holdingExposure || 1);
                }
            } else if (mType === 'EQUITY') {
                const holdingExposure = parseFloat(clientConfig.equityIntradayMargin || clientConfig.equityHoldingMargin || 500);
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (mType === 'OPTIONS') {
                // Options typically use a divisor of 1 or a small value
                tradeMargin = turnover / 1;
            } else if (mType === 'COMEX' || mType === 'FOREX' || mType === 'CRYPTO') {
                const segConfig = clientConfig[`${mType.toLowerCase()}Config`] || {};
                const holdingExposure = parseFloat(segConfig.holdingMargin || segConfig.intradayMargin || 100);
                tradeMargin = turnover / (holdingExposure || 1);
            }

            // Fallback for any missed segments or 0 results
            if (tradeMargin <= 0 && turnover > 0) {
                tradeMargin = turnover / 100; // 1% fallback
            }

            totalMargin += tradeMargin;
        }

        return totalMargin;
    },

    getMcxBaseScrip(symbol, configKeys) {
        if (!symbol) return '';
        const s = symbol.split(':').pop().toUpperCase();
        const cleanS = s.replace(/\s+/g, '');

        // 1. Try to match keys in the config directly (Longest match first)
        // This handles cases like "CRUDEOIL MINI" vs "CRUDEOIL"
        if (configKeys) {
            const sortedKeys = Object.keys(configKeys).sort((a, b) => b.length - a.length);
            for (const key of sortedKeys) {
                const cleanKey = key.replace(/\s+/g, '').toUpperCase();
                if (cleanS.startsWith(cleanKey)) return key;
            }
        }

        // 2. Generic prefix match
        const match = s.match(/^([A-Z]+)/);
        return match ? match[1] : s;
    }
};

module.exports = MarginUtils;
