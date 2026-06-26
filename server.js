const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors()); // Permite que o seu site comunique com este servidor
app.use(express.json());

// 1. Iniciar o Firebase com as Variáveis de Ambiente Seguras
const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // O Render substitui "\\n" por quebras de linha reais
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Token do Mercado Pago (Seguro no Render)
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// ==========================================
// ROTA 1: GERAR PIX (Chamada pelo seu Jogo)
// ==========================================
app.post('/gerarPix', async (req, res) => {
    const { amount, cpf, name, playerId } = req.body;

    try {
        const respostaMP = await axios.post('[https://api.mercadopago.com/v1/payments](https://api.mercadopago.com/v1/payments)', {
            transaction_amount: Number(amount),
            payment_method_id: 'pix',
            description: 'Depósito Golden Pott',
            payer: {
                email: `pagamento_${Date.now()}@goldenpot.com`,
                first_name: name || 'Jogador',
                identification: { type: 'CPF', number: cpf.replace(/\D/g, '') }
            }
        }, {
            headers: {
                'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
                'X-Idempotency-Key': Date.now().toString()
            }
        });

        const pagamento = respostaMP.data;

        // Guarda transação como pendente na Base de Dados
        await db.collection('artifacts').doc('pote-de-ouro-v1')
            .collection('public').doc('data')
            .collection('transactions').doc(pagamento.id.toString()).set({
                type: 'deposit',
                amount: Number(amount),
                status: 'pending',
                playerNameUpper: (name || 'Jogador').toUpperCase(),
                userId: playerId || `temp_${Date.now()}`,
                mpPaymentId: pagamento.id,
                timestamp: Date.now()
            });

        // Envia QR Code para o site
        res.status(200).json({
            paymentId: pagamento.id,
            qrCodeBase64: pagamento.point_of_interaction.transaction_data.qr_code_base64,
            qrCodeCopy: pagamento.point_of_interaction.transaction_data.qr_code
        });

    } catch (error) {
        console.error("Erro MP:", error.response?.data || error.message);
        res.status(500).json({ error: "Falha ao gerar cobrança no Mercado Pago." });
    }
});

// ==========================================
// ROTA 2: WEBHOOK (Aviso do Mercado Pago)
// ==========================================
app.post('/webhook', async (req, res) => {
    const paymentId = req.query.id || req.body.data?.id;
    const topic = req.query.topic || req.body.type;

    if (topic === 'payment' && paymentId) {
        try {
            // Pergunta ao Mercado Pago se foi mesmo pago (Anti-Fraude)
            const verificarPagamento = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
            });

            const dadosPagamento = verificarPagamento.data;

            if (dadosPagamento.status === 'approved') {
                const txRef = db.collection('artifacts').doc('pote-de-ouro-v1')
                    .collection('public').doc('data')
                    .collection('transactions').doc(paymentId.toString());
                
                const txSnap = await txRef.get();

                if (txSnap.exists && txSnap.data().status === 'pending') {
                    const txData = txSnap.data();
                    const batch = db.batch();

                    // 1. Marca como aprovado
                    batch.update(txRef, { status: 'approved' });

                    // 2. Dá o saldo ao jogador
                    const refJogador = db.collection('artifacts').doc('pote-de-ouro-v1')
                        .collection('public').doc('data')
                        .collection('players').doc(txData.playerNameUpper);
                    
                    batch.update(refJogador, { balance: admin.firestore.FieldValue.increment(txData.amount) });

                    await batch.commit();
                    console.log(`Pagamento ${paymentId} creditado com sucesso!`);
                }
            }
            res.status(200).send('OK');
        } catch (error) {
            console.error("Erro no Webhook:", error.message);
            res.status(500).send('Erro');
        }
    } else {
        res.status(200).send('Ignorado');
    }
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});
