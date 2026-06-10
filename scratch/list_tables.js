const db = require('../src/config/db');
async function run() {
    try {
        const [tables] = await db.query("SHOW TABLES");
        console.log("TABLES IN DB:", tables);
        
        // Check user_sessions table if it exists
        const [userSessions] = await db.query("SELECT * FROM user_sessions");
        console.log("USER SESSIONS:", userSessions);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
