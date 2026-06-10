const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../src/config/db');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function run() {
    try {
        // Find an admin user to generate token
        const [users] = await db.query("SELECT id, username, role FROM users WHERE role = 'SUPERADMIN' LIMIT 1");
        if (users.length === 0) {
            console.error("No SUPERADMIN user found!");
            process.exit(1);
        }
        const admin = users[0];
        console.log("Found admin:", admin);
        
        // Generate JWT token
        const token = jwt.sign({ id: admin.id, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
        
        // Get list of open trades to see which trader to query
        const [openTrades] = await db.query("SELECT DISTINCT user_id FROM trades WHERE status = 'OPEN'");
        if (openTrades.length === 0) {
            console.log("No open trades found.");
            process.exit(0);
        }
        
        const targetUserId = openTrades[0].user_id;
        console.log(`Querying M2M for user ID: ${targetUserId}`);
        
        const res = await axios.get(`http://localhost:5000/api/dashboard/live-m2m?userId=${targetUserId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log("\nAPI Response Status:", res.status);
        console.log("API Clients count:", res.data.clients?.length);
        if (res.data.clients && res.data.clients.length > 0) {
            const client = res.data.clients[0];
            console.log("\nClient details:", {
                id: client.id,
                username: client.username,
                activePL: client.activePL,
                activeTrades: client.activeTrades,
                margin: client.margin,
                marginUsed: client.marginUsed
            });
            console.log("\nClient positions:");
            console.log(JSON.stringify(client.positions, null, 2));
        }
        
    } catch (e) {
        console.error("API Call error:", e.message || e);
        if (e.response) {
            console.error("Response data:", e.response.data);
        }
    } finally {
        process.exit(0);
    }
}
run();
