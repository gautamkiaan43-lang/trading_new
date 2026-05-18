const mysql = require('mysql2/promise');

async function run() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        database: 'traderdb'
    });

    try {
        console.log('Querying database for recent trades...');
        const [rows] = await connection.execute(
            "SELECT * FROM trades ORDER BY id DESC LIMIT 10"
        );
        console.log('--- RECENT TRADES ---');
        console.log(JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await connection.end();
    }
}

run();
