const db = require('../src/config/db');

async function main() {
    try {
        const [trades] = await db.execute(
            `SELECT t.id, t.user_id, t.symbol, t.qty, t.entry_price, t.exit_price, t.brokerage, t.market_type, cs.config_json FROM trades t 
             LEFT JOIN client_settings cs ON t.user_id = cs.user_id
             WHERE t.id = ?`, 
            [603]
        );
        if (trades.length > 0) {
            const trade = trades[0];
            console.log('TRADE DETAIL:');
            console.log('ID:', trade.id);
            console.log('User ID:', trade.user_id);
            console.log('Symbol:', trade.symbol);
            console.log('Qty:', trade.qty);
            console.log('Entry Price:', trade.entry_price);
            console.log('Exit Price:', trade.exit_price);
            console.log('Brokerage:', trade.brokerage);
            console.log('Market Type:', trade.market_type);
            
            console.log('CONFIG JSON:');
            const config = JSON.parse(trade.config_json || '{}');
            console.log('mcxLotMargins:', JSON.stringify(config.mcxLotMargins, null, 2));
            console.log('mcxBrokerageType:', config.mcxBrokerageType);
            console.log('mcxBrokerage:', config.mcxBrokerage);
        } else {
            console.log('Trade 603 not found!');
        }
    } catch (e) {
        console.error(e);
    } finally {
        await db.end();
    }
}

main();
