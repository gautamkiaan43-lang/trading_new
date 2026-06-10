const db = require('../src/config/db');
async function run() {
    try {
        const [users] = await db.query("SELECT id, username, parent_id, role FROM users WHERE id IN (75, 119, 109, 17, 74)");
        console.log("USERS & BROKERS:", users);
        const [settings] = await db.query("SELECT user_id, broker_id FROM client_settings WHERE user_id IN (75, 119, 109)");
        console.log("CLIENT SETTINGS:", settings);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
