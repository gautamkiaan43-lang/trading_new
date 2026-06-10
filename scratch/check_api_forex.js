const db = require('../src/config/db');
const jwt = require('jsonwebtoken');
const axios = require('axios');

async function test() {
    try {
        const [users] = await db.execute("SELECT id, role, username FROM users LIMIT 1");
        if (users.length === 0) {
            console.log('No user found');
            process.exit(1);
        }
        const user = users[0];
        console.log('Using user:', user);

        const token = jwt.sign(
            { id: user.id, role: user.role, username: user.username },
            'your_jwt_secret_key_123',
            { expiresIn: '1d' }
        );

        console.log('Calling /api/market-data/forex ...');
        const resForex = await axios.get('http://localhost:5000/api/market-data/forex', {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Forex count:', resForex.data.count);
        console.log('Forex data (first 3):', resForex.data.data.slice(0, 3));

        console.log('Calling /api/market-data/crypto ...');
        const resCrypto = await axios.get('http://localhost:5000/api/market-data/crypto', {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Crypto count:', resCrypto.data.count);
        console.log('Crypto data (first 3):', resCrypto.data.data.slice(0, 3));

        process.exit(0);
    } catch (err) {
        console.error('API call error:', err.message);
        if (err.response) {
            console.error('Response data:', err.response.data);
        }
        process.exit(1);
    }
}

test();
