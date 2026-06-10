const db = require('c:/Users/amanp/Desktop/Aman_Trading/trading_new/src/config/db.js');
const { getClientLiveM2M } = require('c:/Users/amanp/Desktop/Aman_Trading/trading_new/src/controllers/dashboardController.js');

async function check() {
  try {
    const req = {
      user: { id: 1, role: 'SUPERADMIN' },
      query: { userId: '17' } // Broker ID
    };

    const res = {
      json: function(data) {
        console.log("--- API RESPONSE DATA ---");
        console.log(JSON.stringify(data, null, 2));
      },
      status: function(code) {
        console.log("HTTP STATUS:", code);
        return this;
      }
    };

    await getClientLiveM2M(req, res);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

check();
