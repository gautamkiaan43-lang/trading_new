const db = require('../src/config/db');
async function run() {
    try {
        const [kiteSessions] = await db.query("SELECT * FROM user_kite_sessions");
        console.log("USER KITE SESSIONS:", kiteSessions);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
