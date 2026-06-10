const db = require('../src/config/db');

async function run() {
    const [rows] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = 109');
    if (rows.length > 0) {
        const config = JSON.parse(rows[0].config_json);
        console.log('Top level keys:', Object.keys(config));
        console.log('comexBrokerage:', config.comexBrokerage);
        console.log('cryptoBrokerage:', config.cryptoBrokerage);
        console.log('forexBrokerage:', config.forexBrokerage);
        console.log('comexConfig:', config.comexConfig);
    }
    process.exit(0);
}
run();
