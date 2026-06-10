const db = require('../src/config/db');
async function run() {
    const [rows] = await db.execute('SELECT user_id, config_json FROM client_settings');
    for (const r of rows) {
        try {
            const cfg = JSON.parse(r.config_json || '{}');
            if (cfg.comexConfig && (cfg.comexConfig.exposureType || cfg.comexConfig.lotMargins)) {
                console.log(`USER ID ${r.user_id}:`);
                console.log(`  exposureType:`, cfg.comexConfig.exposureType);
                console.log(`  lotMargins:`, JSON.stringify(cfg.comexConfig.lotMargins));
            }
        } catch(e) {
            console.error('Error parsing config for user', r.user_id, e.message);
        }
    }
    process.exit(0);
}
run();
