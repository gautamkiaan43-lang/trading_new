const db = require('../src/config/db');

async function run() {
    const [rows] = await db.execute('SELECT id, symbol, market_type, status, pnl, brokerage FROM trades WHERE user_id = 109 AND status = "CLOSED" LIMIT 20');
    console.log('Closed trades for user 109:');
    rows.forEach(r => {
        console.log(`ID: ${r.id} | Symbol: ${r.symbol} | Market: ${r.market_type} | PnL: ${r.pnl} | Brokerage: ${r.brokerage}`);
    });
    process.exit(0);
}
run();
