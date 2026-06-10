const db = require('../src/config/db');
async function run() {
    try {
        const [trades] = await db.query("SELECT id, user_id, symbol, market_type, qty, entry_price, status FROM trades WHERE status = 'OPEN'");
        console.log("ACTIVE TRADES IN DB:", trades);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
