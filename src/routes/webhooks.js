// src/routes/webhooks.js
const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Middleware para verificar webhook do Stripe
const verifyStripeWebhook = (req, res, next) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        req.stripeEvent = event;
        next();
    } catch (err) {
        logger.error('Stripe webhook signature verification failed:', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
};

// Webhook do Stripe para pagamentos
router.post('/stripe', express.raw({ type: 'application/json' }), verifyStripeWebhook, async (req, res) => {
    const event = req.stripeEvent;

    try {
        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                await handleSubscriptionChange(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionCancellation(event.data.object);
                break;

            case 'invoice.payment_succeeded':
                await handlePaymentSuccess(event.data.object);
                break;

            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;

            default:
                logger.info(`Unhandled Stripe event type: ${event.type}`);
        }

        res.json({ received: true });
    } catch (error) {
        logger.error('Error processing Stripe webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

async function handleSubscriptionChange(subscription) {
    try {
        const customerId = subscription.customer;

        // Buscar empresa pelo customer ID do Stripe
        const company = await prisma.company.findFirst({
            where: {
                metadata: {
                    path: ['stripeCustomerId'],
                    equals: customerId
                }
            }
        });

        if (!company) {
            logger.error(`Company not found for Stripe customer: ${customerId}`);
            return;
        }

        // Mapear plano do Stripe para plano interno
        const planMapping = {
            'price_starter': 'STARTER',
            'price_professional': 'PROFESSIONAL',
            'price_enterprise': 'ENTERPRISE'
        };

        const priceId = subscription.items.data[0].price.id;
        const plan = planMapping[priceId] || 'STARTER';

        // Definir limites baseados no plano
        const planLimits = {
            'STARTER': { maxAgents: 5, maxMessages: 1000, hasAI: false },
            'PROFESSIONAL': { maxAgents: 15, maxMessages: 5000, hasAI: true },
            'ENTERPRISE': { maxAgents: 50, maxMessages: 20000, hasAI: true }
        };

        const limits = planLimits[plan];

        await prisma.company.update({
            where: { id: company.id },
            data: {
                plan,
                status: subscription.status === 'active' ? 'ACTIVE' : 'SUSPENDED',
                maxAgents: limits.maxAgents,
                maxMessages: limits.maxMessages,
                hasAI: limits.hasAI,
                metadata: {
                    ...company.metadata,
                    stripeSubscriptionId: subscription.id
                }
            }
        });

        logger.info(`Updated company ${company.id} subscription to ${plan}`);
    } catch (error) {
        logger.error('Error handling subscription change:', error);
    }
}

async function handleSubscriptionCancellation(subscription) {
    try {
        const customerId = subscription.customer;

        const company = await prisma.company.findFirst({
            where: {
                metadata: {
                    path: ['stripeCustomerId'],
                    equals: customerId
                }
            }
        });

        if (company) {
            await prisma.company.update({
                where: { id: company.id },
                data: {
                    status: 'CANCELED',
                    plan: 'STARTER' // Downgrade to starter
                }
            });

            logger.info(`Canceled subscription for company ${company.id}`);
        }
    } catch (error) {
        logger.error('Error handling subscription cancellation:', error);
    }
}

async function handlePaymentSuccess(invoice) {
    try {
        const customerId = invoice.customer;

        const company = await prisma.company.findFirst({
            where: {
                metadata: {
                    path: ['stripeCustomerId'],
                    equals: customerId
                }
            }
        });

        if (company) {
            // Registrar pagamento bem-sucedido
            logger.info(`Payment succeeded for company ${company.id}: ${invoice.amount_paid / 100}`);

            // Reativar conta se estava suspensa por falta de pagamento
            if (company.status === 'SUSPENDED') {
                await prisma.company.update({
                    where: { id: company.id },
                    data: { status: 'ACTIVE' }
                });
            }
        }
    } catch (error) {
        logger.error('Error handling payment success:', error);
    }
}

async function handlePaymentFailed(invoice) {
    try {
        const customerId = invoice.customer;

        const company = await prisma.company.findFirst({
            where: {
                metadata: {
                    path: ['stripeCustomerId'],
                    equals: customerId
                }
            }
        });

        if (company) {
            logger.warn(`Payment failed for company ${company.id}`);

            // Suspender conta após falha de pagamento (implementar lógica de retry se necessário)
            await prisma.company.update({
                where: { id: company.id },
                data: { status: 'SUSPENDED' }
            });
        }
    } catch (error) {
        logger.error('Error handling payment failure:', error);
    }
}

// Webhook para WhatsApp Business API (se usando)
router.post('/whatsapp', express.json(), async (req, res) => {
    try {
        const { entry } = req.body;

        if (!entry || !entry[0]) {
            return res.status(400).json({ error: 'Invalid webhook payload' });
        }

        const changes = entry[0].changes;
        if (!changes || !changes[0]) {
            return res.status(200).json({ status: 'ok' });
        }

        const change = changes[0];

        if (change.field === 'messages') {
            const messages = change.value.messages;

            if (messages && messages.length > 0) {
                for (const message of messages) {
                    await processWhatsAppMessage(message, change.value.metadata);
                }
            }

            // Processar status de mensagens
            const statuses = change.value.statuses;
            if (statuses && statuses.length > 0) {
                for (const status of statuses) {
                    await processMessageStatus(status);
                }
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        logger.error('Error processing WhatsApp webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

async function processWhatsAppMessage(message, metadata) {
    try {
        // Processar mensagem recebida via WhatsApp Business API
        logger.info('Processing WhatsApp message:', { messageId: message.id, from: message.from });

        // Implementar lógica de processamento específica para WhatsApp Business API
        // Similar ao que já temos no whatsapp-web.js mas adaptado para a API oficial

    } catch (error) {
        logger.error('Error processing WhatsApp message:', error);
    }
}

async function processMessageStatus(status) {
    try {
        // Atualizar status da mensagem no banco
        await prisma.message.updateMany({
            where: {
                metadata: {
                    path: ['whatsappId'],
                    equals: status.id
                }
            },
            data: {
                status: status.status.toUpperCase()
            }
        });

        logger.info('Updated message status:', { messageId: status.id, status: status.status });
    } catch (error) {
        logger.error('Error updating message status:', error);
    }
}

// Webhook genérico para integrações
router.post('/integration/:integrationId', express.json(), async (req, res) => {
    try {
        const { integrationId } = req.params;
        const payload = req.body;

        // Buscar configuração da integração
        const integration = await prisma.integration.findUnique({
            where: { id: integrationId }
        });

        if (!integration) {
            return res.status(404).json({ error: 'Integration not found' });
        }

        // Processar webhook baseado no tipo de integração
        switch (integration.type) {
            case 'CRM':
                await processCRMWebhook(payload, integration);
                break;
            case 'EMAIL':
                await processEmailWebhook(payload, integration);
                break;
            default:
                logger.warn(`Unknown integration type: ${integration.type}`);
        }

        res.json({ status: 'processed' });
    } catch (error) {
        logger.error('Error processing integration webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

async function processCRMWebhook(payload, integration) {
    // Implementar processamento de webhook do CRM
    logger.info('Processing CRM webhook:', { integrationId: integration.id });
}

async function processEmailWebhook(payload, integration) {
    // Implementar processamento de webhook de email
    logger.info('Processing email webhook:', { integrationId: integration.id });
}

module.exports = router;