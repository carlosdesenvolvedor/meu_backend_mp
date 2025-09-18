// controllers/mercadoPagoController.js

const { MercadoPagoConfig, Payment, Preference, Point } = require("mercadopago");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const admin = require("firebase-admin");
const axios = require("axios");

// --- Helper para obter o cliente e segredos corretos ---
const getClientAndSecrets = (accountIdentifier) => {
    let accessToken;
    let webhookSecret;

    // Padrão é 'sjp' se o identificador for nulo, indefinido ou diferente de 'amarela'
    if (accountIdentifier === "amarela") {
        accessToken = process.env.MP_TOKEN_AMARELA;
        webhookSecret = process.env.MP_SECRET_AMARELA;
        console.log("INFO: Usando credenciais da conta AMARELA.");
    } else {
        accessToken = process.env.MP_TOKEN_SJP;
        webhookSecret = process.env.MP_SECRET_SJP;
        console.log("INFO: Usando credenciais da conta SJP (Padrão).");
    }

    if (!accessToken || !webhookSecret) {
        console.error(`ERRO: Credenciais não encontradas para a conta: ${accountIdentifier}`);
        return null;
    }

    const client = new MercadoPagoConfig({
        accessToken: accessToken,
        options: { timeout: 7000 },
    });

    return { client, webhookSecret, accountId: accountIdentifier };
};

// --- Funções do Controlador ---

exports.createDeviceOrder = async (req, res) => {
    try {
        const {
            amount,
            deviceId,
            externalReference,
            description = "Venda PDV",
            tipoPagamentoNaMaquininha,
            installments,
            metadata,
            accountIdentifier, // 'sjp' ou 'amarela'
        } = req.body;

        if (!amount || !deviceId || !externalReference || !tipoPagamentoNaMaquininha) {
            return res.status(400).json({ error: "Campos obrigatórios ausentes." });
        }

        const credentials = getClientAndSecrets(accountIdentifier);
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        const amountInCents = Math.round(parseFloat(amount) * 100);
        // Remover 'metadata' de 'additional_info' pois não é permitido pela API do Mercado Pago
        const paymentIntentRequest = {
            amount: amountInCents,
            description: description,
            additional_info: {
                external_reference: externalReference,
                print_on_terminal: true,
                // metadata removido para evitar erro 500
            },
            payment: {
                type: tipoPagamentoNaMaquininha === "Crédito" ? "credit_card" : "debit_card",
            },
        };
        // Se precisar passar account_identifier, pode adicionar em external_reference ou outro campo permitido

        if (paymentIntentRequest.payment.type === "credit_card") {
            paymentIntentRequest.payment.installments = (installments > 0) ? installments : 1;
        }

        const point = new Point(credentials.client);
        const mpResponse = await point.createPaymentIntent({
            device_id: deviceId,
            request: paymentIntentRequest,
            requestOptions: { idempotencyKey: uuidv4() },
        });

        res.status(201).json(mpResponse);
    } catch (error) {
        console.error("Erro em createDeviceOrder:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao criar ordem no dispositivo", details: error.cause?.body || error.message });
    }
};

exports.getDevicePaymentStatus = async (req, res) => {
    try {
        const { paymentIntentId, deviceId } = req.query;
        if (!paymentIntentId || !deviceId) {
            return res.status(400).json({ error: "Parâmetros 'paymentIntentId' e 'deviceId' são obrigatórios." });
        }

        // Identifica a conta pelo ID do dispositivo (adapte se necessário)
        const accountIdentifier = deviceId.startsWith("ID_DA_MAQUININHA_AMARELA") ? "amarela" : "sjp";
        const credentials = getClientAndSecrets(accountIdentifier);
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        const point = new Point(credentials.client);
        const intentDetails = await point.searchPaymentIntent({ payment_intent_id: paymentIntentId });

        const responseForClient = { status: intentDetails.state, payment: null };

        if (intentDetails.state === "FINISHED" && intentDetails.additional_info?.external_reference) {
            const paymentSearch = new Payment(credentials.client);
            const searchResult = await paymentSearch.search({
                options: {
                    external_reference: intentDetails.additional_info.external_reference,
                    sort: "date_created",
                    criteria: "desc",
                    limit: 1,
                },
            });
            if (searchResult?.results?.length > 0) {
                responseForClient.payment = searchResult.results[0];
            }
        }
        res.status(200).json(responseForClient);
    } catch (error) {
        console.error("Erro em getDevicePaymentStatus:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao buscar status", details: error.cause?.body || error.message });
    }
};

exports.cancelDeviceOrder = async (req, res) => {
    try {
        const { deviceId, paymentIntentId } = req.body;
        if (!deviceId || !paymentIntentId) {
            return res.status(400).json({ error: "Campos 'deviceId' e 'paymentIntentId' são obrigatórios." });
        }

        const accountIdentifier = deviceId.startsWith("ID_DA_MAQUININHA_AMARELA") ? "amarela" : "sjp";
        const credentials = getClientAndSecrets(accountIdentifier);
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        const point = new Point(credentials.client);
        const intentDetails = await point.searchPaymentIntent({ payment_intent_id: paymentIntentId });

        if (intentDetails.state === "CANCELED") {
            return res.status(200).json({ id: paymentIntentId, status: "already_canceled" });
        }

        const mpResponse = await point.cancelPaymentIntent({
            device_id: deviceId,
            payment_intent_id: paymentIntentId,
        });

        res.status(200).json(mpResponse);
    } catch (error) {
        console.error("Erro em cancelDeviceOrder:", error.cause || error);
        const status = error.statusCode || 500;
        if (status === 409) {
            return res.status(409).json({ error: "Conflito: A ordem não pode ser cancelada.", details: error.cause?.body });
        }
        res.status(status).json({ error: "Falha ao cancelar ordem", details: error.cause?.body || error.message });
    }
};

// Adicione as outras funções (createPixOrder, getPixPaymentStatus, createPreference, webhookHandler)
// seguindo o mesmo padrão de adaptação. O código abaixo inclui todas elas.

exports.createPixOrder = async (req, res) => {
    try {
        const { transactionAmount, description, payerEmail, externalReference, ...rest } = req.body;
        if (!transactionAmount || !description || !payerEmail || !externalReference) {
            return res.status(400).json({ error: "Campos obrigatórios ausentes para Pix." });
        }

        const credentials = getClientAndSecrets("sjp"); // Pix geralmente usa uma conta principal
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        const paymentRequestBody = {
            transaction_amount: parseFloat(transactionAmount),
            description: description,
            payment_method_id: "pix",
            external_reference: externalReference,
            payer: {
                email: payerEmail,
                first_name: rest.payerFirstName,
                last_name: rest.payerLastName,
            },
            // ... outros campos que você envia
        };

        const payment = new Payment(credentials.client);
        const sdkResponse = await payment.create({
            body: paymentRequestBody,
            requestOptions: { idempotencyKey: uuidv4() },
        });

        if (sdkResponse?.id && sdkResponse.point_of_interaction?.transaction_data) {
            res.status(201).json({
                paymentId: sdkResponse.id,
                status: sdkResponse.status,
                qr_code: sdkResponse.point_of_interaction.transaction_data.qr_code,
                qr_code_base64: sdkResponse.point_of_interaction.transaction_data.qr_code_base64,
            });
        } else {
            throw new Error("Resposta do SDK para Pix com formato inesperado.");
        }
    } catch (error) {
        console.error("Erro em createPixOrder:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao criar ordem PIX", details: error.cause?.body || error.message });
    }
};

exports.getPixStatus = async (req, res) => {
    try {
        const { paymentId } = req.query;
        if (!paymentId) {
            return res.status(400).json({ error: "Parâmetro 'paymentId' ausente." });
        }
        const credentials = getClientAndSecrets("sjp");
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }
        const payment = new Payment(credentials.client);
        const mpResponse = await payment.get({ id: paymentId });
        res.status(200).json({ id: mpResponse.id, status: mpResponse.status });
    } catch (error) {
        console.error("Erro em getPixStatus:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao buscar status do PIX", details: error.cause?.body || error.message });
    }
};

exports.createPreference = async (req, res) => {
    try {
        const { items, externalReference, ...rest } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0 || !externalReference) {
            return res.status(400).json({ error: "Campos 'items' e 'externalReference' são obrigatórios." });
        }
        const credentials = getClientAndSecrets("sjp");
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }
        const preference = new Preference(credentials.client);
        const mpResponse = await preference.create({
            body: {
                items,
                external_reference: externalReference,
                back_urls: rest.back_urls || {
                    success: "https://loja-vendas-fazplay.web.app/success",
                    failure: "https://loja-vendas-fazplay.web.app/failure",
                    pending: "https://loja-vendas-fazplay.web.app/pending",
                },
                auto_return: rest.auto_return || "approved",
                ...rest,
            },
            requestOptions: { idempotencyKey: uuidv4() },
        });
        res.status(201).json(mpResponse);
    } catch (error) {
        console.error("Erro em createPreference:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao criar preferência de pagamento", details: error.cause?.body || error.message });
    }
};

exports.webhookHandler = async (req, res) => {
    console.log("INFO: Webhook recebido:", { headers: req.headers, body: req.body });

    // 1. Validação da Assinatura
    const signature = req.headers["x-signature"];
    const requestId = req.headers["x-request-id"];
    if (!signature) return res.status(400).send("Missing x-signature header.");

    const { ts, v1 } = signature.split(",").reduce((acc, part) => {
        const [key, value] = part.split("=");
        if (key && value) acc[key.trim()] = value.trim();
        return acc;
    }, {});
    if (!ts || !v1) return res.status(400).send("Malformed x-signature header.");

    const dataId = req.body?.data?.id;
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

    const hmacSJP = crypto.createHmac("sha256", process.env.MP_SECRET_SJP).update(manifest).digest("hex");
    const hmacAmarela = crypto.createHmac("sha256", process.env.MP_SECRET_AMARELA).update(manifest).digest("hex");

    const isValidSJP = crypto.timingSafeEqual(Buffer.from(hmacSJP), Buffer.from(v1));
    const isValidAmarela = crypto.timingSafeEqual(Buffer.from(hmacAmarela), Buffer.from(v1));

    if (!isValidSJP && !isValidAmarela) {
        console.error("ERRO: Falha na validação do HMAC do Webhook!");
        return res.status(403).send("Webhook signature verification failed.");
    }

    // 2. Responde OK imediatamente e processa em segundo plano
    res.status(200).send("OK");

    // 3. Processamento
    // Envolvemos em uma função assíncrona para o processamento em segundo plano
    (async () => {
        try {
            const topic = req.body.topic || req.body.type;
            if (!dataId || !topic) {
                console.warn("WARN: Webhook sem 'data.id' ou 'topic'.");
                return;
            }

            const accountIdentifier = isValidAmarela ? "amarela" : "sjp";
            const credentials = getClientAndSecrets(accountIdentifier);
            if (!credentials) {
                console.error(`ERRO: Não foi possível obter credenciais para a conta '${accountIdentifier}' no webhook.`);
                return;
            }

            let paymentData, externalReference, paymentStatus, firestoreCollection;

            if (topic === "payment") {
                console.log(`INFO: Processando notificação de PAGAMENTO para ID: ${dataId}`);
                const payment = new Payment(credentials.client);
                paymentData = await payment.get({ id: dataId });
                externalReference = paymentData.external_reference;
                paymentStatus = paymentData.status;
                firestoreCollection = paymentData.metadata?.target_collection;
            } else if (topic === "merchant_order") {
                console.log(`INFO: Processando notificação de ORDEM (Maquininha/CheckoutPro) para ID: ${dataId}`);
                const orderDetailsUrl = `https://api.mercadopago.com/merchant_orders/${dataId}`;
                const { data: orderData } = await axios.get(orderDetailsUrl, {
                    headers: { "Authorization": `Bearer ${credentials.client.config.accessToken}` },
                });
                paymentData = orderData;
                externalReference = orderData.external_reference;
                firestoreCollection = orderData.metadata?.target_collection;
                paymentStatus = (orderData.order_status === "paid") ? "approved" : (orderData.payments?.slice(-1)[0]?.status || "unknown");
            } else {
                console.log(`INFO: Tópico de webhook não processado: ${topic}.`);
                return;
            }

            if (!externalReference || !firestoreCollection) {
                console.error("ERRO: 'externalReference' ou 'firestoreCollection' não encontrados.", { dataId, topic, metadata: paymentData.metadata });
                return;
            }

            const saleDocRef = admin.firestore().collection(firestoreCollection).doc(externalReference);
            const saleDoc = await saleDocRef.get();
            if (!saleDoc.exists) {
                console.error(`ERRO: Documento da venda ${externalReference} não encontrado na coleção ${firestoreCollection}.`);
                return;
            }

            const updatePayload = {
                ultimaAtualizacaoWebhook: admin.firestore.FieldValue.serverTimestamp(),
                dadosWebhookCompletos: admin.firestore.FieldValue.arrayUnion(paymentData),
            };

            const normalizedStatus = (paymentStatus === "accredited") ? "approved" : paymentStatus;

            if (normalizedStatus === "approved") {
                updatePayload.statusPedidoGeral = "concluida";
            } else if (["rejected", "cancelled", "expired", "charged_back"].includes(normalizedStatus)) {
                updatePayload.statusPedidoGeral = "falha_pagamento_geral";
            }

            console.log(`INFO: Atualizando Firestore para venda ${externalReference} com payload:`, updatePayload);
            await saleDocRef.update(updatePayload);
            console.log(`INFO: Venda ${externalReference} atualizada com sucesso.`);

        } catch (error) {
            console.error("ERRO: Falha no processamento assíncrono do webhook:", error);
        }
    })();
};
