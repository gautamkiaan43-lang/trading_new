const db = require('../src/config/db');

async function checkKyc() {
    try {
        const [rows] = await db.execute('SELECT u.username, d.kyc_status FROM users u LEFT JOIN user_documents d ON u.id = d.user_id WHERE u.username = "trader"');
        console.log('KYC Status for trader:');
        console.table(rows);
    } catch (err) {
        console.error('Error fetching KYC:', err.message);
    } finally {
        process.exit();
    }
}

checkKyc();
