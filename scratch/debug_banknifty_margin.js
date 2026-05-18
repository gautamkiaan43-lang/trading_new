const db = require('../src/config/db');

async function main() {
    try {
        // Get the latest BANKNIFTY open trade
        const [trades] = await db.execute(
            `SELECT t.*, cs.config_json 
             FROM trades t
             JOIN client_settings cs ON t.user_id = cs.user_id
             WHERE (t.symbol LIKE '%BANKNIFTY%' OR t.symbol LIKE '%NIFTY%')
               AND t.status = 'OPEN'
             ORDER BY t.id DESC
             LIMIT 5`
        );

        if (!trades.length) {
            console.log('No open BANKNIFTY/NIFTY trades found.');
            return;
        }

        for (const trade of trades) {
            const config = JSON.parse(trade.config_json || '{}');
            const mType = (trade.market_type || '').toUpperCase();

            console.log('\n==== TRADE DETAIL ====');
            console.log('ID:', trade.id, '| Symbol:', trade.symbol);
            console.log('Type:', trade.type, '| Qty:', trade.qty, '| actual_qty:', trade.actual_qty);
            console.log('Entry Price:', trade.entry_price);
            console.log('market_type:', mType);
            console.log('margin_used (DB):', trade.margin_used);
            console.log('lot_size_at_entry:', trade.lot_size_at_entry);

            console.log('\n==== CLIENT CONFIG (Equity/Options) ====');
            console.log('equityHoldingMargin:', config.equityHoldingMargin);
            console.log('equityIntradayMargin:', config.equityIntradayMargin);
            console.log('optionsIndexHolding:', config.optionsIndexHolding);
            console.log('optionsIndexIntraday:', config.optionsIndexIntraday);
            console.log('mcxExposureType:', config.mcxExposureType);

            // Trace the holding margin calculation
            const entry = parseFloat(trade.entry_price);
            const qty = parseFloat(trade.qty);
            const actualQty = parseFloat(trade.actual_qty || trade.qty);
            const lotSize = parseFloat(trade.lot_size_at_entry || 1);

            console.log('\n==== HOLDING MARGIN TRACE ====');

            // ExpirySquareOffService uses: holdingDivisor = equityHoldingMargin, qty = actual_qty, turnover = entry * qty
            const holdingDivisor = parseFloat(config.equityHoldingMargin || 100);
            const turnoverByActual = entry * actualQty;
            const holdingMarginByActual = turnoverByActual / holdingDivisor;

            console.log(`Path 1 (NSE/ExpirySquareOff): entry(${entry}) * actual_qty(${actualQty}) / holdingDivisor(${holdingDivisor}) = ${holdingMarginByActual.toFixed(2)}`);

            // MarginUtils uses: trade.lot_size or trade.multiplier
            const lotSizeForMargin = parseFloat(trade.lot_size || trade.multiplier || 1);
            const turnoverByLot = entry * qty * lotSizeForMargin;
            const holdingMarginByLot = turnoverByLot / holdingDivisor;
            console.log(`Path 2 (MarginUtils): entry(${entry}) * qty(${qty}) * lot_size(${lotSizeForMargin}) / holdingDivisor(${holdingDivisor}) = ${holdingMarginByLot.toFixed(2)}`);

            // Options path: optionsIndexIntraday
            const optIntraday = parseFloat(config.optionsIndexIntraday || 5);
            const optHolding = parseFloat(config.optionsIndexHolding || 2);
            const turnoverOpt = entry * actualQty;
            const holdingOpt = turnoverOpt / optHolding;
            const intradayOpt = turnoverOpt / optIntraday;
            console.log(`Path 3 (Options Index): entry(${entry}) * actual_qty(${actualQty}) / optionsIndexHolding(${optHolding}) = ${holdingOpt.toFixed(2)}`);
            console.log(`Path 3b (Options Index Intraday): entry(${entry}) * actual_qty(${actualQty}) / optionsIndexIntraday(${optIntraday}) = ${intradayOpt.toFixed(2)}`);

            // Simple qty * entry / exposure
            const equityIntraday = parseFloat(config.equityIntradayMargin || 500);
            const holdingByEquityIntraday = (entry * qty) / equityIntraday;
            console.log(`Path 4 (Equity Intraday divisor): entry(${entry}) * qty(${qty}) / equityIntradayMargin(${equityIntraday}) = ${holdingByEquityIntraday.toFixed(2)}`);
        }

    } catch (e) {
        console.error(e);
    } finally {
        await db.end();
    }
}
main();
