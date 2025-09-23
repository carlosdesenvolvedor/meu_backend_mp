// index.js

require("dotenv").config(); // Carrega as variáveis de .env
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const mercadoPagoRoutes = require("./routes/mercadoPagoRoutes");

// --- Inicialização do Firebase Admin SDK ---
if (!admin.apps.length) {
    try {
        const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
        if (!serviceAccountBase64) {
            throw new Error("A variável de ambiente FIREBASE_SERVICE_ACCOUNT_BASE64 não está definida.");
        }
        // Decodifica a chave da variável de ambiente
        const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
        const serviceAccount = JSON.parse(serviceAccountJson);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        console.log("Firebase Admin SDK inicializado com sucesso.");
    } catch (e) {
        console.error("ERRO CRÍTICO: Falha ao inicializar Firebase Admin SDK:", e);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors()); // Permite requisições de outras origens (seu app Flutter)

// ATENÇÃO: O middleware express.json() deve vir ANTES das rotas,
// mas o webhook precisa de uma exceção. O roteador cuidará disso.
app.use(express.json());

// Rota de "saúde" do servidor
app.get("/", (req, res) => {
    res.send("Servidor do Mercado Pago está no ar! 🚀");
});

// NOVO ENDPOINT DE HEALTH CHECK
// Este endpoint não faz nada, apenas responde que o servidor está online.
// Use esta URL no seu serviço de Cron Job.
app.get('/api/v1/health', (req, res) => {
    console.log('Health check endpoint foi chamado com sucesso.');
    res.status(200).send({ status: 'ok', message: 'Server is alive.' });
});

// Usar as rotas da API
// Todas as rotas aqui começarão com /api/v1
app.use("/api/v1", mercadoPagoRoutes);

// Iniciar o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
