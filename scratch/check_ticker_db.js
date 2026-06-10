const db = require('../src/config/db');
async function run() {
    try {
        const [scripRows] = await db.query("SELECT * FROM scrip_data LIMIT 10");
        console.log("scrip_data (first 10):", scripRows);
        const [tickerRows] = await db.query("SELECT * FROM tickers LIMIT 10");
        console.log("tickers (first 10):", tickerRows);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
