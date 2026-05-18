const db = require('../src/config/db');
const { getMcxBaseScrip, MCX_LOT_SIZES } = require('../src/utils/symbolHelper');

async function main() {
    try {
        const [tradeRows] = await db.execute(
            `SELECT t.*, cs.config_json 
             FROM trades t
             JOIN client_settings cs ON t.user_id = cs.user_id
             WHERE t.id = ?`,
            [603]
        );
        const trade = tradeRows[0];
        const clientConfig = JSON.parse(trade.config_json || '{}');
        const mType = (trade.market_type || '').toUpperCase();

        console.log('mType:', mType);
        
        let lotSize = 1;
        if (mType === 'MCX') {
            const base = getMcxBaseScrip(trade.symbol);
            const symTrimmed = (trade.symbol || '').toUpperCase().replace(/\d+.*/, '');

            console.log('base:', base);
            console.log('symTrimmed:', symTrimmed);
            console.log('MCX_LOT_SIZES[base]:', MCX_LOT_SIZES[base]);
            console.log('MCX_LOT_SIZES[symTrimmed]:', MCX_LOT_SIZES[symTrimmed]);

            if (base && MCX_LOT_SIZES[base]) {
                lotSize = MCX_LOT_SIZES[base];
            } else if (MCX_LOT_SIZES[symTrimmed]) {
                lotSize = MCX_LOT_SIZES[symTrimmed];
            }
        }
        console.log('Calculated lotSize in TradeService (line 120):', lotSize);

        // Wait, did we miss something? Let's check how the script calculates brokerage:
        const calcBrokerage = (brokerageVal, brokerageType, qty, exitPrice, entryPrice, multiplier = 1) => {
            const rate = Math.abs(parseFloat(brokerageVal || 0));
            if (rate <= 0) return 0;
            const type = (brokerageType || 'PER_LOT').toUpperCase();
            let result = 0;
            if (type === 'PER_LOT' || type === 'PER LOT') {
                result = qty * rate;
            } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                const turnover = (parseFloat(entryPrice) + parseFloat(exitPrice)) * qty * multiplier;
                result = (turnover / 10000000) * rate;
                console.log(`[calcBrokerage Trace] turnover: (${entryPrice} + ${exitPrice}) * ${qty} * ${multiplier} = ${turnover}`);
                console.log(`[calcBrokerage Trace] result: (${turnover} / 10000000) * ${rate} = ${result}`);
            }
            return Math.max(0, result);
        };

        const qtyForClientBrokerage = trade.qty;
        const multiplierForClientBrokerage = lotSize; // this is lotSize!
        const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
        let rate = parseFloat(clientConfig.mcxBrokerage || 0);
        const calcType = brokerageType === 'per_lot' ? 'PER_LOT' : 'PER_CRORE';
        
        console.log('mcxBrokerageType:', brokerageType);
        console.log('mcxBrokerage rate:', rate);
        
        const finalBrokerage = calcBrokerage(rate, calcType, qtyForClientBrokerage, trade.exit_price, trade.entry_price, multiplierForClientBrokerage);
        console.log('Calculated finalBrokerage using lotSize (100):', finalBrokerage);

    } catch (e) {
        console.error(e);
    } finally {
        await db.end();
    }
}
main();
