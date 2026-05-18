const db = require('../src/config/db');
const { getMcxBaseScrip, MCX_LOT_SIZES } = require('../src/utils/symbolHelper');

async function main() {
    try {
        // Get trade + client config
        const [tradeRows] = await db.execute(
            `SELECT t.*, cs.config_json, cs.broker_id
             FROM trades t
             JOIN client_settings cs ON t.user_id = cs.user_id
             WHERE t.id = 603`
        );
        const trade = tradeRows[0];
        const clientConfig = JSON.parse(trade.config_json || '{}');
        const mType = (trade.market_type || '').toUpperCase();

        console.log('\n==== TRADE 603 INFO ====');
        console.log('Symbol:', trade.symbol);
        console.log('Qty:', trade.qty, '| actual_qty:', trade.actual_qty);
        console.log('Entry:', trade.entry_price, '| Exit:', trade.exit_price);
        console.log('market_type:', mType);
        console.log('lot_size_at_entry:', trade.lot_size_at_entry);
        console.log('DB stored brokerage:', trade.brokerage);
        console.log('DB stored pnl:', trade.pnl);

        console.log('\n==== CLIENT CONFIG (MCX) ====');
        console.log('mcxBrokerageType:', clientConfig.mcxBrokerageType);
        console.log('mcxBrokerage:', clientConfig.mcxBrokerage);
        console.log('mcxLotMargins.GOLD:', clientConfig.mcxLotMargins?.GOLD);

        // Lot size resolution
        const base = getMcxBaseScrip(trade.symbol);
        let lotSize = 1;
        if (base && MCX_LOT_SIZES[base]) lotSize = MCX_LOT_SIZES[base];
        console.log('\n==== LOT SIZE RESOLUTION ====');
        console.log('Base scrip:', base);
        console.log('MCX_LOT_SIZES[base]:', MCX_LOT_SIZES[base]);
        console.log('Resolved lotSize:', lotSize);

        // user_segments check
        const [segRows] = await db.execute(
            'SELECT * FROM user_segments WHERE user_id = ? AND segment = ?',
            [trade.user_id, trade.market_type]
        );
        console.log('\n==== USER_SEGMENTS ====');
        if (segRows.length > 0) {
            const seg = segRows[0];
            console.log('Found segment row:', JSON.stringify(seg));
            const bType = (seg.brokerage_type || 'PER_LOT').toUpperCase();
            const rate = parseFloat(seg.brokerage_value);
            const qty = parseFloat(trade.qty);
            const entry = parseFloat(trade.entry_price);
            const exit = parseFloat(trade.exit_price);

            if (bType === 'PER_LOT') {
                const calc = qty * rate;
                console.log(`PER_LOT calc: ${qty} * ${rate} = ${calc}`);
            } else if (bType === 'PER_CRORE') {
                const turnover = (entry + exit) * qty * lotSize;
                const calc = (turnover / 10000000) * rate;
                console.log(`PER_CRORE calc: (${entry}+${exit}) * ${qty} * ${lotSize} = turnover ${turnover}`);
                console.log(`Result: (${turnover} / 1Cr) * ${rate} = ${calc}`);
            }
        } else {
            console.log('No user_segments row found → falling back to client_settings');

            // Fallback: client_settings MCX brokerage
            const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
            const rate = parseFloat(clientConfig.mcxBrokerage || 0);
            const qty = parseFloat(trade.qty);
            const entry = parseFloat(trade.entry_price);
            const exit = parseFloat(trade.exit_price);

            console.log(`mcxBrokerageType: ${brokerageType} | rate: ${rate}`);

            if (brokerageType === 'per_lot') {
                const calc = qty * rate;
                console.log(`PER_LOT: ${qty} * ${rate} = ${calc}`);
            } else {
                const turnover = (entry + exit) * qty * lotSize;
                const calc = (turnover / 10000000) * rate;
                console.log(`PER_CRORE: (${entry}+${exit}) * ${qty} * ${lotSize} = turnover ${turnover}`);
                console.log(`Result: (${turnover}/10000000) * ${rate} = ${calc}`);
            }
        }

        // What lotSize=2 gives (old behavior)
        console.log('\n==== REVERSE ENGINEERING DB BROKERAGE ₹51.20 ====');
        const entry = parseFloat(trade.entry_price);
        const exit = parseFloat(trade.exit_price);
        const qty = parseFloat(trade.qty);
        const rate = parseFloat(clientConfig.mcxBrokerage || 0);
        // b = (entry+exit)*qty*L/1Cr * rate => L = b*1Cr/(rate*(entry+exit)*qty)
        const impliedLot = (51.20 * 10000000) / (rate * (entry + exit) * qty);
        console.log(`Stored brokerage=51.20, rate=${rate}`);
        console.log(`Implied lotSize used = ${impliedLot}`);

    } catch (e) {
        console.error(e);
    } finally {
        await db.end();
    }
}
main();
