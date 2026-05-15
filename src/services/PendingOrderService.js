const db = require('../config/db');
const marketDataService = require('./MarketDataService');
const { getIo } = require('../config/socket');
const { logAction } = require('../controllers/systemController');

/**
 * Pending Order Matching Service
 * Periodically checks if pending orders (is_pending = 1) match live prices.
 * If matched, moves trade to active (is_pending = 0).
 */
const monitorPendingOrders = async () => {
    try {
        // Fetch all trades that are OPEN and PENDING (is_pending = 1)
        const [pendingTrades] = await db.execute(
            "SELECT id, user_id, symbol, type, entry_price, market_type FROM trades WHERE status = 'OPEN' AND is_pending = 1"
        );

        if (pendingTrades.length === 0) return;

        for (const trade of pendingTrades) {
            try {
                // Normalize symbol for matching with live data
                const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
                const marketType = (trade.market_type || 'MCX').toUpperCase();

                // Determine the correct prefix for MarketDataService lookup
                let prefix = 'NSE';
                if (marketType === 'MCX') prefix = 'MCX';
                else if (marketType === 'NFO' || marketType === 'OPTIONS') prefix = 'NFO';
                else if (marketType === 'CRYPTO') prefix = 'CRYPTO';
                else if (marketType === 'FOREX') prefix = 'FOREX';

                let currentPrice = null;
                const possibleSymbols = [trade.symbol, `${prefix}:${cleanSymbol}`, cleanSymbol];

                for (const s of possibleSymbols) {
                    const data = marketDataService.getPrice(s);
                    if (data && data.ltp) {
                        currentPrice = data.ltp;
                        break;
                    }
                }

                if (!currentPrice) continue;

                const limitPrice = parseFloat(trade.entry_price);
                let shouldExecute = false;

                // 🎯 REVISED EXECUTION LOGIC:
                // User wants strict matching: Execute ONLY if market price hits the exact limit price.
                // This prevents immediate execution when the current price is already "better" than the limit.
                // We use a very small tolerance (0.0001% or 0.05 points) to handle decimal precision.
                const priceDiff = Math.abs(currentPrice - limitPrice);
                const tolerance = Math.max(limitPrice * 0.000001, 0.05);

                if (priceDiff <= tolerance) {
                    shouldExecute = true;
                }

                if (shouldExecute) {
                    console.log(`[PendingOrder] 🚀 EXECUTING Trade #${trade.id} (${trade.symbol}) at ${currentPrice} (Limit: ${limitPrice})`);

                    // 1. Update trade to ACTIVE (is_pending = 0) and refresh entry time
                    await db.execute(
                        'UPDATE trades SET is_pending = 0, executed_from_pending = 1, entry_time = NOW() WHERE id = ?',
                        [trade.id]
                    );

                    // 2. Log the execution
                    await logAction(trade.user_id, 'EXECUTE_PENDING', 'trades',
                        `Pending order #${trade.id} executed at market price ${currentPrice} (Limit: ${limitPrice})`);

                    // 3. Notify user via Socket for real-time UI update
                    const io = getIo();
                    if (io) {
                        // Notify user about execution
                        io.to(`user:${trade.user_id}`).emit('notification', {
                            message: `Order Executed! ${trade.type} ${trade.symbol} at ₹${currentPrice}`,
                            type: 'ORDER_EXECUTED',
                            tradeId: trade.id
                        });

                        // Force a refresh of trades in the app
                        io.to(`user:${trade.user_id}`).emit('trade_update', {
                            id: trade.id,
                            is_pending: 0,
                            status: 'OPEN'
                        });
                    }
                }
            } catch (tradeErr) {
                console.error(`[PendingOrder] Error processing trade #${trade.id}:`, tradeErr.message);
            }
        }
    } catch (err) {
        console.error('[PendingOrder] Monitor error:', err.message);
    }
};

let isMonitoring = false;
/**
 * Start the monitoring service
 * Checks every 3 seconds for price matches
 */
const startPendingOrderMonitoring = () => {
    setInterval(() => {
        if (isMonitoring) return;
        isMonitoring = true;
        monitorPendingOrders()
            .finally(() => { isMonitoring = false; });
    }, 3000);

    console.log('[PendingOrder] 🚀 Pending order matching service started (3s interval)');
};

module.exports = { startPendingOrderMonitoring };
