require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
    // 1. Local Connection
    try {
        const localConn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: process.env.DB_PORT || 3306,
            database: process.env.DB_NAME || 'traderdb'
        });
        console.log("Local Connected!");
        const [localCols] = await localConn.query("SHOW COLUMNS FROM trades LIKE 'market_type'");
        if (localCols && localCols[0]) {
            console.log("Local trades.market_type definition:", localCols[0].Type);
        } else {
            console.log("Local trades.market_type column not found!");
        }
        await localConn.end();
    } catch (e) {
        console.error("Local DB error:", e.message);
    }

    // 2. Railway Connection
    try {
        const remoteConn = await mysql.createConnection(process.env.DATABASE_URL || 'mysql://root:DKipKSrOzjHBeTSBOXlOSwchWbdDaxAh@crossover.proxy.rlwy.net:47646/railway');
        console.log("Railway Connected!");
        const [remoteCols] = await remoteConn.query("SHOW COLUMNS FROM trades LIKE 'market_type'");
        if (remoteCols && remoteCols[0]) {
            console.log("Railway trades.market_type definition:", remoteCols[0].Type);
        } else {
            console.log("Railway trades.market_type column not found!");
        }
        await remoteConn.end();
    } catch (e) {
        console.error("Railway DB error:", e.message);
    }
}
run();
