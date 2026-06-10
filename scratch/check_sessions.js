const db = require('../src/config/db');

async function run() {
    try {
        const [sessions] = await db.query("SELECT * FROM user_kite_sessions");
        console.log("Kite Sessions in DB:", sessions);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
