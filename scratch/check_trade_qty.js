const db = require('../src/config/db');

async function run() {
    try {
        const [trades] = await db.query("SELECT * FROM trades WHERE status = 'OPEN'");
        console.log("Open Trades database fields:");
        trades.forEach(t => {
            console.log({
                id: t.id,
                symbol: t.symbol,
                qty: t.qty,
                actual_qty: t.actual_qty,
                type: t.type,
                entry_price: t.entry_price
            });
        });
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
