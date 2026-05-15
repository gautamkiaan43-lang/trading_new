const db = require('../src/config/db');

async function migrate() {
    try {
        console.log('Checking client_settings for watchlist_json column...');
        const [columns] = await db.execute('SHOW COLUMNS FROM client_settings');
        const hasColumn = columns.some(c => c.Field === 'watchlist_json');

        if (!hasColumn) {
            console.log('Adding watchlist_json column to client_settings...');
            await db.execute('ALTER TABLE client_settings ADD COLUMN watchlist_json JSON AFTER config_json');
            console.log('✅ Column added successfully.');
        } else {
            console.log('✅ Column already exists.');
        }
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
}

migrate();
