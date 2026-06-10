const db = require('c:/Users/amanp/Desktop/Aman_Trading/trading_new/src/config/db.js');

async function check() {
  try {
    const [rows] = await db.execute("SELECT id, user_id, symbol, status FROM trades WHERE user_id = 109 AND status = 'OPEN'");
    console.log("Total OPEN trades in DB for user 109:", rows.length);
    console.table(rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

check();
