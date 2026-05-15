const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

async function resetPasswords() {
    try {
        const users = [
            { username: 'superadmin', password: 'superadmin123' },
            { username: 'admin', password: 'admin123' },
            { username: 'broker', password: 'broker123' },
            { username: 'trader', password: 'trader123' }
        ];

        for (const user of users) {
            const hashedPassword = await bcrypt.hash(user.password, 10);
            await db.execute('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, user.username]);
            console.log(`✅ Password reset for ${user.username} to ${user.password}`);
        }
    } catch (err) {
        console.error('Error resetting passwords:', err.message);
    } finally {
        process.exit();
    }
}

resetPasswords();
