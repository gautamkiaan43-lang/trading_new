const db = require('../src/config/db');

async function main() {
    try {
        const [trades] = await db.execute(
            `SELECT * FROM trades WHERE id = 603`, 
            []
        );
        if (trades.length > 0) {
            console.log('TRADE 603 DETAIL:');
            console.log(JSON.stringify(trades[0], null, 2));
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
