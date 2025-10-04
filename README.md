# meu-backend-mp — instruções rápidas de teste e configuração

Este README descreve como configurar, executar e testar as rotas do backend (especialmente o endpoint `create-preference`) para melhorar a qualidade da integração com Mercado Pago.

## Objetivo
- Garantir que `createPreference` envie os campos obrigatórios e recomendados (payer.email, payer.first_name/last_name, items: id/title/description/category_id/quantity/unit_price, notification_url, metadata.target_collection).
- Receber webhooks corretamente em `notification_url` para conciliação financeira.

## Pré-requisitos
- Node.js (v16+ recomendado)
- npm
- (Opcional para testes locais) ngrok
- Variáveis de ambiente válidas (colocar em `meu-backend-mp/.env`):
  - `MP_TOKEN_SJP` (token Mercado Pago)
  - `MP_SECRET_SJP` (secret webhook)
  - `MP_TOKEN_AMARELA` / `MP_SECRET_AMARELA` (se usar conta AMARELA)
  - `PORT` (opcional, default 3000)
  - `DEFAULT_NOTIFICATION_URL` (URL pública que receberá webhooks — ex: https://abcd1234.ngrok.io/api/v1/webhook)
  - `DEFAULT_TARGET_COLLECTION` (opcional, default `vendas`)
  - `FIREBASE_SERVICE_ACCOUNT_BASE64` (se usar Firestore)

> Nota: o `.env` de exemplo já existe em `meu-backend-mp/.env`. Substitua os placeholders por valores reais.

## Passos para rodar localmente
1. Instalar dependências:

```powershell
npm --prefix .\meu-backend-mp install
```

2. (Opcional) Expor URL pública com ngrok (recomendado para testes de webhook):

```powershell
ngrok http 3000
```

- Copie a URL HTTPS fornecida pelo ngrok (ex: `https://abcd1234.ngrok.io`) e monte a URL de webhook completa — ex: `https://abcd1234.ngrok.io/api/v1/webhook`.
- Atualize `meu-backend-mp/.env` com `DEFAULT_NOTIFICATION_URL` apontando para essa URL (ou use a URL da sua instância hospedada).

3. Iniciar o servidor (com debug de preferência enquanto diagnostica):

```powershell
$env:MP_DEBUG='true'; npm --prefix .\meu-backend-mp run start
```

ou (se preferir executar o index diretamente):

```powershell
$env:MP_DEBUG='true'; node .\meu-backend-mp\index.js
```

## Rodar o script de teste (criado em `meu-backend-mp/test`)
O repositório contém um script de teste que envia um payload de exemplo para `/api/v1/create-preference`.

```powershell
# Teste contra a instância local
$env:TEST_BASE_URL='http://localhost:3000'; node .\meu-backend-mp\test\test_create_preference.js

# Ou teste contra a instância hospedada (ex: Render)
$env:TEST_BASE_URL='https://meu-backend-mp.onrender.com'; node .\meu-backend-mp\test\test_create_preference.js
```

- O script imprimirá status e o JSON de resposta. Se bem-sucedido, você verá `id` (preference id) e `init_point` (link do checkout).

## O que observar nos logs do servidor
- `MP_DEBUG: preference body:` — o payload final enviado ao Mercado Pago.
- `MP_DEBUG: resposta do SDK preference.create:` — resposta do Mercado Pago (contém `id` / `init_point`).
- `WARN: notification_url aponta para localhost` — significa que o webhook não será entregue; use URL pública.
- `WARN: payer.first_name ou payer.last_name ausente` — recomendado enviar estes campos.
- `WARN: item[...] está faltando campos recomendados` — corrija o item no frontend ou garanta que o backend preencha.
- `INFO: Webhook recebido:` — confirma que a URL pública está recebendo notificações do Mercado Pago.

## Checklist para aumentar a pontuação de integração (Mercado Pago)
- [x] Enviar `payer.email` (obrigatório)
- [x] Enviar `notification_url` público (obrigatório)
- [x] Enviar `items` com `id`, `title`, `description`, `category_id`, `quantity`, `unit_price` (recomendado)
- [x] Enviar `payer.first_name` e `payer.last_name` (recomendado)
- [x] Garantir `metadata.target_collection` para o webhook atualizar Firestore (agora preenchido com `DEFAULT_TARGET_COLLECTION` se ausente)
- [ ] Implementar device identifier via MercadoPago.JS v2 no frontend (se usar tokenização/site)

## Coletando evidências para reavaliação
1. Gere 1-3 pagamentos (sandbox ou produtivo conforme o processo de reavaliação do Mercado Pago) com os novos campos preenchidos.
2. Reúna:
   - Preference IDs e Payment IDs / merchant_order IDs
   - Prints dos logs do servidor mostrando `MP_DEBUG` body e SDK response
   - Print ou logs do webhook recebidos (`INFO: Webhook recebido:`)
3. Entre no painel do Mercado Pago e solicite nova medição (ou responda ao ticket de avaliação) anexando as evidências.

## Troubleshooting rápido
- Erro 400 com mensagem sobre `notification_url` ausente: verifique `DEFAULT_NOTIFICATION_URL` no `.env` ou envie `notification_url` no payload.
- Webhook não chega: verifique se URL é HTTPS pública; se usar ngrok, confirme que a URL atual é a mesma usada no `.env`.
- HMAC inválido no webhook: confirme `MP_SECRET_SJP` / `MP_SECRET_AMARELA` estão corretos e iguais aos configurados no painel do Mercado Pago.

---
Se quiser, eu:
- adiciono um exemplo de payload final (com todos campos) neste README;
- gero um pequeno script adicional que conclui o fluxo com um pagamento sandbox (depende de credenciais e ambiente sandbox).

Diga qual próximo artefato prefere que eu gere (ex: exemplo de payload final ou script de sandbox).

## Exemplo de payload final (com todos os campos recomendados)

Use este JSON como referência para enviar ao endpoint `create-preference`:

```json
{
  "externalReference": "VENDA_TEST_0001",
  "items": [
    {
      "id": "PROD_001",
      "title": "Camiseta Azul",
      "description": "Camiseta 100% algodão - Tamanho M",
      "category_id": "apparel",
      "quantity": 2,
      "unit_price": 49.9
    }
  ],
  "payer": {
    "email": "cliente+teste@example.com",
    "first_name": "João",
    "last_name": "Silva",
    "phone": { "area_code": "11", "number": "999999999" },
    "identification": { "type": "CPF", "number": "00000000000" },
    "address": { "zip_code": "01001000", "street_name": "Av. Exemplo", "street_number": 100 }
  },
  "notification_url": "https://meu-backend-mp.onrender.com/api/v1/webhook",
  "back_urls": {
    "success": "https://loja.example/success",
    "failure": "https://loja.example/failure",
    "pending": "https://loja.example/pending"
  },
  "auto_return": "approved",
  "metadata": { "target_collection": "vendas", "order_source": "checkout_pro" }
}
```

## Script opcional: fluxo sandbox (cria preferência e verifica pagamento)

Um script auxiliar foi adicionado em `meu-backend-mp/test/sandbox_flow.js`. Ele:

- cria uma preferência via backend (`/api/v1/create-preference`),
- imprime o `init_point` para abrir o checkout,
- consulta a API de pagamentos do Mercado Pago (usando `MP_TOKEN_SJP` do `.env`) para buscar pagamentos com o mesmo `external_reference` até encontrar um payment (polling).

Como usar:

```powershell
# 1) garanta que MP_TOKEN_SJP esteja definido em meu-backend-mp/.env
# 2) rode o script apontando para sua base URL (local ou hospedada)
$env:TEST_BASE_URL='http://localhost:3000'
node .\meu-backend-mp\test\sandbox_flow.js
```
