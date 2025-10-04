// sandbox_flow.js
// Uso: node sandbox_flow.js
// Depende de: meu-backend-mp/test/payload.json e MP_TOKEN_SJP no meu-backend-mp/.env

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const MP_API = 'https://api.mercadopago.com';

(async () => {
    try {
        const payloadPath = path.resolve(__dirname, 'payload.json');
        const raw = fs.readFileSync(payloadPath, 'utf8');
        const body = JSON.parse(raw);

        const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';
        console.log('INFO: Enviando create-preference para', baseUrl + '/api/v1/create-preference');

        const resp = await axios.post(baseUrl + '/api/v1/create-preference', body, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        console.log('Resposta create-preference:', resp.status);
        console.log(JSON.stringify(resp.data, null, 2));

        const preferenceId = resp.data?.id;
        const initPoint = resp.data?.init_point;
        if (!preferenceId) {
            console.error('Erro: resposta não contém preference id. Abortando.');
            process.exit(1);
        }

        console.log('Abra o init_point no browser para concluir o pagamento (sandbox/prod):', initPoint);

        // Polling para encontrar um pagamento com external_reference igual ao enviado
        const externalReference = body.externalReference;
        if (!externalReference) {
            console.error('externalReference ausente no payload. Abortando polling.');
            process.exit(1);
        }

        if (!process.env.MP_TOKEN_SJP) {
            console.error('MP_TOKEN_SJP ausente no .env do backend. Cannot poll MercadoPago API.');
            process.exit(1);
        }

        console.log('Aguardando pagamento para external_reference=', externalReference);

        const authHeader = { Authorization: `Bearer ${process.env.MP_TOKEN_SJP}` };

        const start = Date.now();
        const timeoutMs = 10 * 60 * 1000; // 10 minutos
        while (Date.now() - start < timeoutMs) {
            // Usa endpoint de busca de pagamentos do Mercado Pago
            const searchUrl = `${MP_API}/v1/payments/search`;
            const q = `external_reference:${encodeURIComponent(externalReference)}`;
            try {
                const r = await axios.get(searchUrl, { headers: authHeader, params: { limit: 10, q } });
                const results = r.data?.results || r.data;
                if (results && results.length > 0) {
                    console.log('Pagamento encontrado!');
                    console.log(JSON.stringify(results[0], null, 2));
                    process.exit(0);
                } else {
                    console.log('Ainda não encontrado. Rechecando em 5s...');
                }
            } catch (err) {
                console.error('Erro ao consultar Mercado Pago:', err.response?.data || err.message);
            }

            await new Promise((r) => setTimeout(r, 5000));
        }

        console.error('Timeout aguardando pagamento (10min).');
        process.exit(2);
    } catch (err) {
        console.error('Erro no sandbox_flow:', err.response?.data || err.message || err);
        process.exit(1);
    }
})();
