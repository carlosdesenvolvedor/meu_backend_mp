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

// O middleware express.json() é aplicado ANTES das rotas que o necessitam.
// A rota de webhook, que precisa do corpo "raw", é tratada de forma especial
// dentro do arquivo de rotas (mercadoPagoRoutes.js).
app.use(express.json());

// Rota de "saúde" do servidor
app.get("/", (req, res) => {
    res.send("Servidor do Mercado Pago está no ar! 🚀");
});

// NOVO ENDPOINT DE HEALTH CHECK
// Este endpoint não faz nada, apenas responde que o servidor está online.
// Use esta URL no seu serviço de Cron Job.
app.get('/api/v1/health', async (req, res) => {
    const startTime = Date.now();
    try {
        // 1. Simula uma operação real lendo um documento do Firestore.
        // Isso "aquece" a conexão com o banco de dados.
        const db = admin.firestore();
        // Faz uma consulta leve para buscar apenas 1 documento da coleção de vendedores.
        await db.collection('vendedores').limit(1).get();

        // 2. Adiciona um pequeno atraso intencional para garantir que a requisição não seja instantânea.
        await new Promise(resolve => setTimeout(resolve, 200)); // Atraso de 200ms

        const duration = Date.now() - startTime;
        console.log(`Health check "forte" bem-sucedido. Duração: ${duration}ms.`);
        res.status(200).send({ status: 'ok', message: 'Server is warm and alive.', duration_ms: duration });

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`ERRO no Health Check: ${error.message}. Duração: ${duration}ms.`);
        // Mesmo em caso de erro (ex: Firestore offline), responde com erro de servidor
        // mas não derruba a aplicação.
        res.status(500).send({ status: 'error', message: 'Health check failed.', error: error.message, duration_ms: duration });
    }
});

// Usar as rotas da API
// Todas as rotas aqui começarão com /api/v1
app.use("/api/v1", mercadoPagoRoutes);

// --- NOVO: Middleware de Tratamento de Erros Global ---
// Este middleware deve ser a ÚLTIMA coisa a ser adicionada com app.use().
// Ele captura qualquer erro que ocorra nas rotas acima.
app.use((error, req, res, next) => {
    // Loga o erro completo no console do seu servidor (Render)
    // Isso é crucial para a depuração.
    console.error("--- ERRO NÃO TRATADO CAPTURADO ---");
    console.error("Rota:", req.method, req.originalUrl);
    console.error("Corpo da Requisição:", req.body);
    console.error("Erro:", error); // Loga o objeto de erro completo
    console.error("Stack Trace:", error.stack); // Mostra a "pilha" de onde o erro veio
    console.error("--- FIM DO ERRO ---");

    // Envia uma resposta de erro genérica e segura para o cliente, sem travar o servidor.
    res.status(500).json({ error: "Ocorreu um erro interno no servidor." });
});

// Iniciar o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
