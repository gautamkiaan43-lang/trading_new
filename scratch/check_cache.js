const marketDataService = require('../src/services/MarketDataService');
const db = require('../src/config/db');

async function check() {
    try {
        console.log("Loading symbols from DB first...");
        await marketDataService._loadSymbolsFromDb();
        
        console.log("\nCurrent prices in cache:", Object.keys(marketDataService.prices));
        
        // Wait a few seconds for AllTicks/Zerodha connections to run if they are connected
        console.log("Waiting 3 seconds to let background processes populate data...");
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log("\nPrices in cache after wait:", Object.keys(marketDataService.prices));
        for (const [key, value] of Object.entries(marketDataService.prices)) {
            console.log(`- ${key}: LTP=${value.ltp}, Bid=${value.bid}, Ask=${value.ask}`);
        }
        
        // Query open trades from DB
        const [trades] = await db.execute("SELECT id, symbol, market_type, entry_price, status FROM trades WHERE status = 'OPEN'");
        console.log("\nOpen trades in DB:");
        for (const t of trades) {
            console.log(`- ID ${t.id} | ${t.symbol} | Market: ${t.market_type} | Entry: ${t.entry_price}`);
            
            // Replicate the lookup logic from dashboardController
            const mType = (t.market_type || '').toUpperCase();
            const prefix = mType === 'CRYPTO' ? 'CRYPTO' : (mType === 'FOREX' ? 'FOREX' : (mType === 'COMMODITY' ? 'COMMODITY' : (mType === 'MCX' ? 'MCX' : 'NSE')));
            const cleanSymbol = t.symbol;

            const searchPatterns = [
                `${prefix}:${cleanSymbol}`,
                `${prefix}:${cleanSymbol}`,
                cleanSymbol,
                cleanSymbol.replace(/FUT$/i, ''),
                `${prefix}:${cleanSymbol.replace(/FUT$/i, '')}`,
                `NSE:${cleanSymbol}`,
                `NFO:${cleanSymbol}`,
                `MCX:${cleanSymbol}`
            ];
            
            let foundKey = null;
            let foundVal = null;
            for (const pattern of searchPatterns) {
                foundVal = marketDataService.getPrice(pattern);
                if (foundVal) {
                    foundKey = pattern;
                    break;
                }
            }
            
            if (foundVal) {
                console.log(`  -> MATCHED pattern: "${foundKey}" | Price: ${foundVal.ltp}`);
            } else {
                console.log(`  -> NO EXACT MATCH under patterns:`, searchPatterns);
            }
        }
        
        process.exit(0);
    } catch (err) {
        console.error("Error in check script:", err);
        process.exit(1);
    }
}

check();
