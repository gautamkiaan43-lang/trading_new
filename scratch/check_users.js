const db = require('../src/config/db');
async function run() {
    try {
        const [users] = await db.query("SELECT id, username, full_name, role FROM users WHERE username LIKE '%shree%' OR full_name LIKE '%shree%' OR username LIKE '%vikram%' OR full_name LIKE '%vikram%' OR role = 'BROKER'");
        console.log("USERS FOUND:", users);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
