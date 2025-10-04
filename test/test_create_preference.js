// test_create_preference.js
// Executar: node test_create_preference.js

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

(async () => {
    try {
        const payloadPath = path.resolve(__dirname, 'payload.json');
        const raw = fs.readFileSync(payloadPath, 'utf8');
        const body = JSON.parse(raw);

        const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';
        console.log('INFO: Enviando create-preference para', baseUrl + '/api/v1/create-preference');

        const resp = await axios.post(baseUrl + '/api/v1/create-preference', body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
        });

        console.log('=== RESPONSE STATUS ===');
        console.log(resp.status, resp.statusText);
        console.log('=== RESPONSE DATA ===');
        console.log(JSON.stringify(resp.data, null, 2));

    } catch (err) {
        if (err.response) {
            console.error('=== ERROR RESPONSE ===');
            console.error(err.response.status, err.response.statusText);
            console.error(JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('=== REQUEST ERROR ===');
            console.error(err.message);
        }
        process.exit(1);
    }
})();
