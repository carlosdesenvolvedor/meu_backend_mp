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
        // console.log("INFO: Usando credenciais da conta AMARELA.");
    } else {
        accessToken = process.env.MP_TOKEN_SJP;
        webhookSecret = process.env.MP_SECRET_SJP;
        // console.log("INFO: Usando credenciais da conta SJP (Padrão).");
    }

    if (!accessToken || !webhookSecret) {
        // console.error(`ERRO: Credenciais não encontradas para a conta: ${accountIdentifier}`);
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
        const accountIdentifier = deviceId.startsWith("NEWLAND") ? "amarela" : "sjp";
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

        const accountIdentifier = deviceId.startsWith("NEWLAND") ? "amarela" : "sjp";
        const credentials = getClientAndSecrets(accountIdentifier);
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        const point = new Point(credentials.client);
        const intentDetails = await point.searchPaymentIntent({ payment_intent_id: paymentIntentId });

        // --- LÓGICA DE VERIFICAÇÃO DE ESTADO APRIMORADA ---
        // Verifica se a ordem já está em um estado final que não permite cancelamento.
        const uncancellableStates = ["CANCELED", "FINISHED", "EXPIRED", "ON_TERMINAL"];
        if (uncancellableStates.includes(intentDetails.state)) {

            // Se o estado for 'ON_TERMINAL', é um conflito real. O app precisa saber disso.
            if (intentDetails.state === 'ON_TERMINAL') {
                return res.status(409).json({
                    error: "Conflito: A ordem já está sendo processada na maquininha e não pode ser cancelada agora.",
                    details: `Current state is ${intentDetails.state}`
                });
            }

            // Para outros estados finais (CANCELED, FINISHED, EXPIRED), o resultado é o desejado.
            // Retorna um status de sucesso para o app, pois o resultado final é o desejado (ordem não está mais ativa).
            // O 'already_canceled' pode ser interpretado como 'already_finalized' pelo app.
            return res.status(200).json({ id: paymentIntentId, status: "already_finalized" });
        }

        // Se a ordem estiver em um estado que permite cancelamento (ex: "OPEN"), prossegue.
        // console.log(`INFO: Ordem no estado '${intentDetails.state}'. Prosseguindo com o cancelamento.`);
        const mpResponse = await point.cancelPaymentIntent({
            device_id: deviceId,
            payment_intent_id: paymentIntentId,
        });

        res.status(200).json(mpResponse);
    } catch (error) {
        // --- MELHORIA NO LOG DE ERRO ---
        // Loga o erro completo para depuração no Render, similar ao middleware global.
        console.error("--- ERRO CAPTURADO EM cancelDeviceOrder ---");
        console.error("Rota:", req.method, req.originalUrl);
        console.error("Corpo da Requisição:", req.body);
        console.error("Mensagem do Erro:", error.message);
        console.error("Causa do Erro (SDK):", error.cause); // O mais importante para erros do Mercado Pago
        console.error("Stack Trace:", error.stack);
        console.error("--- FIM DO ERRO ---");

        const status = error.statusCode || error.cause?.statusCode || 500;
        if (status === 409) {
            return res.status(409).json({ error: "Conflito: A ordem não pode ser cancelada.", details: error.cause?.body || error.message });
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
        const { items, externalReference, payer, notification_url, issuer_id, back_urls, auto_return, ...rest } = req.body;

        // Validações básicas obrigatórias
        if (!items || !Array.isArray(items) || items.length === 0 || !externalReference) {
            return res.status(400).json({ error: "Campos 'items' e 'externalReference' são obrigatórios." });
        }

        // Validações recomendadas (payer.email é obrigatória pela pontuação)
        if (!payer || !payer.email) {
            return res.status(400).json({ error: "Campo obrigatório 'payer.email' ausente. Forneça o e-mail do comprador." });
        }

        const credentials = getClientAndSecrets("sjp");
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        // Normaliza e enriquece os items para garantir campos recomendados
        const normalizedItems = items.map((it, idx) => {
            const normalized = {
                id: it.id || (`item_${idx + 1}`),
                title: it.title || it.name || `Item ${idx + 1}`,
                description: it.description || it.title || "",
                category_id: it.category_id || it.category || undefined,
                quantity: (typeof it.quantity === 'number') ? it.quantity : parseInt(it.quantity, 10) || 1,
                unit_price: (typeof it.unit_price === 'number') ? it.unit_price : parseFloat(it.unit_price) || parseFloat(it.price) || 0.0,
            };
            // Remove chaves undefined para evitar payloads com valores inválidos
            Object.keys(normalized).forEach(k => normalized[k] === undefined && delete normalized[k]);
            return normalized;
        });

        // Monta o objeto payer com campos recomendados
        const payerPayload = {
            email: payer.email,
        };
        if (payer.first_name) payerPayload.first_name = payer.first_name;
        if (payer.last_name) payerPayload.last_name = payer.last_name;
        if (payer.phone) payerPayload.phone = payer.phone;
        if (payer.identification) payerPayload.identification = payer.identification;
        if (payer.address) payerPayload.address = payer.address;

        // notification_url é obrigatório para conciliação financeira
        const notificationUrlToUse = notification_url || process.env.DEFAULT_NOTIFICATION_URL || null;
        if (!notificationUrlToUse) {
            return res.status(400).json({ error: "Campo obrigatório 'notification_url' ausente. Defina no corpo ou na variável DEFAULT_NOTIFICATION_URL." });
        }

        // Monta o corpo da preferência, incluindo issuer_id quando fornecido
        const preference = new Preference(credentials.client);
        // Prepara metadata de forma segura (evita spread de undefined)
        const providedMetadata = rest.metadata || {};
        const metadataObj = {
            created_by: "meu-backend-mp",
            target_collection: providedMetadata.target_collection || providedMetadata.targetCollection || providedMetadata.target || null,
            ...providedMetadata,
        };

        // Se não houver target_collection, usa o padrão da variável de ambiente ou 'vendas'
        if (!metadataObj.target_collection) {
            metadataObj.target_collection = process.env.DEFAULT_TARGET_COLLECTION || 'vendas';
            // console.info("INFO: metadata.target_collection ausente — definindo padrão:", metadataObj.target_collection);
        }

        const body = {
            items: normalizedItems,
            external_reference: externalReference,
            payer: payerPayload,
            notification_url: notificationUrlToUse,
            back_urls: back_urls || {
                success: "https://loja-vendas-fazplay.web.app/success",
                failure: "https://loja-vendas-fazplay.web.app/failure",
                pending: "https://loja-vendas-fazplay.web.app/pending",
            },
            auto_return: auto_return || "approved",
            metadata: metadataObj,
            ...rest,
        };

        if (issuer_id) {
            // issuer_id faz sentido quando há um meio de pagamento selecionado; adiciona ao body para compatibilidade
            body.issuer_id = issuer_id;
        }

        // console.log("INFO: Criando preferência com payload:", { external_reference: externalReference, items_count: normalizedItems.length, payer: payerPayload.email, notification_url: notificationUrlToUse });

        if (process.env.MP_DEBUG === 'true') {
            // Loga o body completo (útil para debugging) - cuidado com dados sensíveis em produção
            console.log("MP_DEBUG: preference body:", JSON.stringify(body, null, 2));
        }

        const mpResponse = await preference.create({
            body,
            requestOptions: { idempotencyKey: uuidv4() },
        });

        if (process.env.MP_DEBUG === 'true') {
            console.log("MP_DEBUG: resposta do SDK preference.create:", JSON.stringify(mpResponse, null, 2));
        }

        // DIAGNÓSTICOS ADICIONAIS (logs que auxiliam a descoberta de falhas de medição)
        // 1) Aviso se notification_url for localhost (o Mercado Pago não consegue enviar webhook para localhost)
        if (/localhost|127\.0\.0\.1/.test(notificationUrlToUse)) {
            console.warn("WARN: notification_url aponta para localhost/127.0.0.1. O Mercado Pago não poderá enviar webhooks a URLs locais. Use uma URL pública (ngrok ou domínio).", { notification_url: notificationUrlToUse });
        }

        // 2) Aviso se payer faltar first_name/last_name (recomendado)
        if (!payer.first_name || !payer.last_name) {
            console.warn("WARN: payer.first_name ou payer.last_name ausente — campo recomendado para aumentar taxa de aprovação.", { first_name: payer.first_name, last_name: payer.last_name });
        }

        // 3) Para cada item, logar campos recomendados faltantes (categoria, descrição, id, title, unit_price)
        normalizedItems.forEach((it, idx) => {
            const missing = [];
            if (!it.category_id) missing.push('category_id');
            if (!it.description) missing.push('description');
            if (!it.id) missing.push('id');
            if (!it.title) missing.push('title');
            if (!it.unit_price || Number(it.unit_price) <= 0) missing.push('unit_price');
            if (missing.length > 0) {
                console.warn(`WARN: item[${idx}] está faltando campos recomendados: ${missing.join(', ')}`, { item: it });
            }
        });

        // 3b) Validação crítica: não permitimos items com unit_price <= 0 — isso prejudica aprovação
        const itemsWithInvalidPrice = normalizedItems.filter((it) => !it.unit_price || Number(it.unit_price) <= 0);
        if (itemsWithInvalidPrice.length > 0) {
            console.error('ERROR: Encontrados items com unit_price inválido (<=0). Abortando criação de preferência.', { invalid_items: itemsWithInvalidPrice });
            return res.status(400).json({ error: 'Alguns items possuem unit_price inválido (<=0). Envie preços válidos para todos os itens.', invalid_items: itemsWithInvalidPrice });
        }

        // 4) Aviso se metadata.target_collection ausente (o webhook depende dela para atualizar Firestore)
        if (!metadataObj.target_collection) {
            console.warn("WARN: metadata.target_collection ausente. O webhook pode não conseguir atualizar o Firestore sem essa informação.", { metadata: metadataObj });
        }

        // Retorna apenas campos essenciais ao cliente e loga o restante
        res.status(201).json({
            id: mpResponse.id,
            init_point: mpResponse.init_point || mpResponse.sandbox_init_point || null,
            status: mpResponse.status || 'created',
            preference: mpResponse,
        });
    } catch (error) {
        console.error("Erro em createPreference:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao criar preferência de pagamento", details: error.cause?.body || error.message });
    }
};

exports.cancelPixOrder = async (req, res) => {
    try {
        const { paymentId } = req.body;
        if (!paymentId) {
            return res.status(400).json({ error: "Campo 'paymentId' é obrigatório." });
        }

        // PIX geralmente usa uma conta principal, mas pode ser adaptado se necessário
        const credentials = getClientAndSecrets("sjp");
        if (!credentials) {
            return res.status(500).json({ error: "Falha na configuração do servidor." });
        }

        const payment = new Payment(credentials.client);

        // 1. Busca o pagamento para verificar o status atual
        const currentPayment = await payment.get({ id: paymentId });

        // 2. Verifica se o pagamento pode ser cancelado
        if (currentPayment.status === 'cancelled') {
            // console.log(`INFO: Tentativa de cancelar pagamento PIX ${paymentId} que já está cancelado.`);
            return res.status(200).json({ id: currentPayment.id, status: 'cancelled', message: 'Pagamento já estava cancelado.' });
        }

        if (currentPayment.status !== 'pending') {
            // console.warn(`WARN: Tentativa de cancelar pagamento PIX ${paymentId} com status '${currentPayment.status}'.`);
            return res.status(409).json({ error: "Conflito: O pagamento não está pendente e não pode ser cancelado.", current_status: currentPayment.status });
        }

        // 3. Procede com o cancelamento
        console.log(`INFO: Cancelando pagamento PIX ${paymentId} com status '${currentPayment.status}'.`);
        const mpResponse = await payment.cancel({ id: paymentId });

        res.status(200).json(mpResponse);
    } catch (error) {
        console.error("Erro em cancelPixOrder:", error.cause || error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: "Falha ao cancelar ordem PIX", details: error.cause?.body || error.message });
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
