const mysql = require('mysql2/promise');

async function run() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        port: 3308,
        user: 'root',
        password: '',
        database: 'traderdb'
    });

    try {
        console.log('Querying database for pending trades...');
        const [rows] = await connection.execute(
            "SELECT id, user_id, symbol, type, entry_price, market_type, status, is_pending FROM trades WHERE status = 'OPEN' AND is_pending = 1"
        );
        console.log('--- OPEN PENDING TRADES ---');
        console.log(JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await connection.end();
    }
}

run();
