const db = require('../src/config/db');
const MarginUtils = require('../src/utils/MarginUtils');

async function run() {
    // 1. Fetch user 109 trades
    const [trades] = await db.execute('SELECT * FROM trades WHERE user_id = 109 AND status = "OPEN"');
    console.log(`Found ${trades.length} open trades for user 109`);

    // 2. Fetch user 109 config
    const [settings] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = 109');
    const clientConfig = JSON.parse(settings[0].config_json || '{}');

    // 3. Calculate dynamic margin
    trades.forEach(trade => {
        const margin = MarginUtils.calculateTotalRequiredHoldingMargin([trade], clientConfig);
        console.log(`Symbol: ${trade.symbol} | Market Type: ${trade.market_type} | Qty: ${trade.qty} | Calculated Margin: ${margin}`);
    });

    process.exit(0);
}
run();
