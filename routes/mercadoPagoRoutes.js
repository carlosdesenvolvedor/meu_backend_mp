// routes/mercadoPagoRoutes.js

const express = require("express");
const router = express.Router();
const mpController = require("../controllers/mercadoPagoController");

// Middleware para o webhook que precisa do corpo "raw"
const rawBodyMiddleware = express.raw({ type: 'application/json' });

// Rotas para Maquininha (Point)
router.post("/create-device-order", mpController.createDeviceOrder);
router.get("/get-device-payment-status", mpController.getDevicePaymentStatus);
router.post("/cancel-device-order", mpController.cancelDeviceOrder);

// Rotas para PIX
router.post("/create-pix-order", mpController.createPixOrder);
router.get("/get-pix-status", mpController.getPixStatus);
router.post("/cancel-pix-order", mpController.cancelPixOrder); // <-- ADICIONE ESTA LINHA

// Rota para Checkout Pro (Pagamento Online)
router.post("/create-preference", mpController.createPreference);

// Rota para Webhook (com middleware especial)
router.post("/webhook", rawBodyMiddleware, mpController.webhookHandler);

module.exports = router;
