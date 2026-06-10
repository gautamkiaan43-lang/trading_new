const db = require('../src/config/db');
const TradeService = require('../src/services/TradeService');

async function run() {
    const [trades] = await db.execute(
        `SELECT t.*, cs.config_json 
         FROM trades t
         LEFT JOIN client_settings cs ON t.user_id = cs.user_id
         WHERE t.status = "CLOSED" 
           AND (t.market_type = "CRYPTO" OR t.market_type = "FOREX")
           AND t.brokerage = 0`
    );

    console.log(`Found ${trades.length} closed CRYPTO/FOREX trades with 0 brokerage`);

    for (const trade of trades) {
        try {
            const result = await TradeService.calculateBrokerageAndSwapForTrade(
                trade,
                parseFloat(trade.exit_price || 0),
                trade.exit_time || new Date(),
                db
            );

            const calculatedBrokerage = result.brokerage || 0;
            console.log(`Trade ID: ${trade.id} | Symbol: ${trade.symbol} | Market: ${trade.market_type} | Qty: ${trade.qty} | Calculated Brokerage: ${calculatedBrokerage}`);

            if (calculatedBrokerage > 0) {
                await db.execute('UPDATE trades SET brokerage = ? WHERE id = ?', [calculatedBrokerage, trade.id]);
                console.log(`✅ Updated trade ${trade.id} brokerage to ${calculatedBrokerage}`);
            }
        } catch (err) {
            console.error(`Error processing trade ${trade.id}:`, err.message);
        }
    }

    process.exit(0);
}

run();
