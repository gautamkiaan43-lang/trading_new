const db = require('../src/config/db');

async function checkUsers() {
    try {
        const [rows] = await db.execute('SELECT id, username, role, status FROM users ORDER BY id ASC');
        console.log('Current Users in DB:');
        console.table(rows);
    } catch (err) {
        console.error('Error fetching users:', err.message);
    } finally {
        process.exit();
    }
}

checkUsers();
