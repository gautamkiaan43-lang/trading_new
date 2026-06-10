const allTicksService = require('../src/services/allticks.service');
const marketDataService = require('../src/services/MarketDataService');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function test() {
    try {
        console.log("AllTicks API Key:", process.env.ALLTICKS_API_KEY ? "SET" : "NOT SET");
        
        console.log("Starting MarketDataService Crypto/Forex...");
        await marketDataService.startCryptoForex();
        
        console.log("Waiting 5 seconds to receive ticks...");
        for (let i = 1; i <= 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`Sec ${i}: Cache size = ${Object.keys(marketDataService.prices).length}`);
            if (Object.keys(marketDataService.prices).length > 0) {
                console.log("Prices in cache:");
                for (const [key, val] of Object.entries(marketDataService.prices)) {
                    console.log(`  - ${key}: Bid=${val.bid}, Ask=${val.ask}, LTP=${val.ltp}`);
                }
            }
        }
        
        marketDataService.shutdown();
        process.exit(0);
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

test();
