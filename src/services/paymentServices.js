// src/services/paymentService.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { notifyCompany } = require('./socket');

const prisma = new PrismaClient();

// Definição dos planos disponíveis
const PLANS = {
    STARTER: {
        id: 'starter',
        name: 'Starter',
        price: 47,
        currency: 'BRL',
        features: {
            maxAgents: 3,
            maxMessages: 1000,
            hasAI: false,
            hasAnalytics: false,
            hasAPI: false,
            hasWhiteLabel: false,
            supportLevel: 'email'
        },
        stripeProductId: process.env.STRIPE_STARTER_PRODUCT_ID
    },
    BUSINESS: {
        id: 'business',
        name: 'Business',
        price: 97,
        currency: 'BRL',
        features: {
            maxAgents: 10,
            maxMessages: 5000,
            hasAI: true,
            hasAnalytics: true,
            hasAPI: false,
            hasWhiteLabel: false,
            supportLevel: 'chat'
        },
        stripeProductId: process.env.STRIPE_BUSINESS_PRODUCT_ID
    },
    ENTERPRISE: {
        id: 'enterprise',
        name: 'Enterprise',
        price: 197,
        currency: 'BRL',
        features: {
            maxAgents: 25,
            maxMessages: 15000,
            hasAI: true,
            hasAnalytics: true,
            hasAPI: true,
            hasWhiteLabel: false,
            supportLevel: 'priority'
        },
        stripeProductId: process.env.STRIPE_ENTERPRISE_PRODUCT_ID
    },
    CUSTOM: {
        id: 'custom',
        name: 'Custom',
        price: null, // Pricing on demand
        currency: 'BRL',
        features: {
            maxAgents: 999,
            maxMessages: 999999,
            hasAI: true,
            hasAnalytics: true,
            hasAPI: true,
            hasWhiteLabel: true,
            supportLevel: 'dedicated'
        },
        stripeProductId: null
    }
};

class PaymentService {
    constructor() {
        this.stripe = stripe;
        this.plans = PLANS;
    }

    async createCustomer(companyId, email, name) {
        try {
            const customer = await this.stripe.customers.create({
                email,
                name,
                metadata: {
                    companyId
                }
            });

            // Salvar customer ID no banco
            await prisma.company.update({
                where: { id: companyId },
                data: {
                    stripeCustomerId: customer.id
                }
            });

            return customer;
        } catch (error) {
            logger.error('Error creating Stripe customer:', error);
            throw error;
        }
    }

    async createSubscription(companyId, planId, paymentMethodId) {
        try {
            const plan = this.plans[planId.toUpperCase()];
            if (!plan || !plan.stripeProductId) {
                throw new Error('Plano inválido ou não disponível');
            }

            const company = await prisma.company.findUnique({
                where: { id: companyId }
            });

            if (!company) {
                throw new Error('Empresa não encontrada');
            }

            // Buscar ou criar customer no Stripe
            let customerId = company.stripeCustomerId;
            if (!customerId) {
                const customer = await this.createCustomer(companyId, company.email, company.name);
                customerId = customer.id;
            }

            // Anexar método de pagamento ao customer
            if (paymentMethodId) {
                await this.stripe.paymentMethods.attach(paymentMethodId, {
                    customer: customerId
                });

                await this.stripe.customers.update(customerId, {
                    invoice_settings: {
                        default_payment_method: paymentMethodId
                    }
                });
            }

            // Buscar preços do produto no Stripe
            const prices = await this.stripe.prices.list({
                product: plan.stripeProductId,
                active: true
            });

            if (prices.data.length === 0) {
                throw new Error('Preço não encontrado para o plano');
            }

            const price = prices.data[0];

            // Criar subscription
            const subscription = await this.stripe.subscriptions.create({
                customer: customerId,
                items: [{
                    price: price.id
                }],
                payment_behavior: 'default_incomplete',
                payment_settings: { save_default_payment_method: 'on_subscription' },
                expand: ['latest_invoice.payment_intent'],
                metadata: {
                    companyId,
                    planId: planId.toUpperCase()
                }
            });

            // Atualizar empresa no banco
            await prisma.company.update({
                where: { id: companyId },
                data: {
                    plan: planId.toUpperCase(),
                    stripeSubscriptionId: subscription.id,
                    ...plan.features
                }
            });

            return {
                subscription,
                clientSecret: subscription.latest_invoice.payment_intent.client_secret
            };

        } catch (error) {
            logger.error('Error creating subscription:', error);
            throw error;
        }
    }

    async updateSubscription(companyId, newPlanId) {
        try {
            const company = await prisma.company.findUnique({
                where: { id: companyId }
            });

            if (!company || !company.stripeSubscriptionId) {
                throw new Error('Assinatura não encontrada');
            }

            const newPlan = this.plans[newPlanId.toUpperCase()];
            if (!newPlan || !newPlan.stripeProductId) {
                throw new Error('Novo plano inválido');
            }

            // Buscar subscription atual
            const subscription = await this.stripe.subscriptions.retrieve(
                company.stripeSubscriptionId
            );

            // Buscar novo preço
            const prices = await this.stripe.prices.list({
                product: newPlan.stripeProductId,
                active: true
            });

            if (prices.data.length === 0) {
                throw new Error('Preço não encontrado para o novo plano');
            }

            const newPrice = prices.data[0];

            // Atualizar subscription
            const updatedSubscription = await this.stripe.subscriptions.update(
                company.stripeSubscriptionId,
                {
                    items: [{
                        id: subscription.items.data[0].id,
                        price: newPrice.id
                    }],
                    proration_behavior: 'create_prorations',
                    metadata: {
                        companyId,
                        planId: newPlanId.toUpperCase()
                    }
                }
            );

            // Atualizar empresa no banco
            await prisma.company.update({
                where: { id: companyId },
                data: {
                    plan: newPlanId.toUpperCase(),
                    ...newPlan.features
                }
            });

            // Notificar usuários sobre mudança de plano
            await notifyCompany(companyId, 'plan:updated', {
                newPlan: newPlan.name,
                features: newPlan.features
            });

            return updatedSubscription;

        } catch (error) {
            logger.error('Error updating subscription:', error);
            throw error;
        }
    }

    async cancelSubscription(companyId, cancelAtPeriodEnd = true) {
        try {
            const company = await prisma.company.findUnique({
                where: { id: companyId }
            });

            if (!company || !company.stripeSubscriptionId) {
                throw new Error('Assinatura não encontrada');
            }

            const subscription = await this.stripe.subscriptions.update(
                company.stripeSubscriptionId,
                {
                    cancel_at_period_end: cancelAtPeriodEnd,
                    metadata: {
                        canceledAt: new Date().toISOString(),
                        canceledBy: 'user'
                    }
                }
            );

            if (!cancelAtPeriodEnd) {
                // Cancelamento imediato - mover para plano gratuito ou suspender
                await prisma.company.update({
                    where: { id: companyId },
                    data: {
                        plan: 'STARTER',
                        status: 'SUSPENDED',
                        ...this.plans.STARTER.features
                    }
                });
            }

            return subscription;

        } catch (error) {
            logger.error('Error canceling subscription:', error);
            throw error;
        }
    }

    async processInvoicePayment(invoice) {
        try {
            const companyId = invoice.metadata?.companyId;
            if (!companyId) {
                logger.warn('Invoice without companyId metadata:', invoice.id);
                return;
            }

            if (invoice.status === 'paid') {
                await prisma.company.update({
                    where: { id: companyId },
                    data: { status: 'ACTIVE' }
                });

                await notifyCompany(companyId, 'payment:success', {
                    amount: invoice.amount_paid / 100,
                    currency: invoice.currency
                });

                logger.info(`Payment successful for company ${companyId}`);

            } else if (invoice.status === 'payment_failed') {
                await prisma.company.update({
                    where: { id: companyId },
                    data: { status: 'SUSPENDED' }
                });

                await notifyCompany(companyId, 'payment:failed', {
                    amount: invoice.amount_due / 100,
                    currency: invoice.currency
                });

                logger.warn(`Payment failed for company ${companyId}`);
            }

        } catch (error) {
            logger.error('Error processing invoice payment:', error);
        }
    }

    async createPaymentIntent(companyId, amount, currency = 'brl') {
        try {
            const company = await prisma.company.findUnique({
                where: { id: companyId }
            });

            if (!company) {
                throw new Error('Empresa não encontrada');
            }

            const paymentIntent = await this.stripe.paymentIntents.create({
                amount: amount * 100, // Stripe usa centavos
                currency: currency.toLowerCase(),
                customer: company.stripeCustomerId,
                metadata: {
                    companyId
                }
            });

            return paymentIntent;

        } catch (error) {
            logger.error('Error creating payment intent:', error);
            throw error;
        }
    }

    async getBillingHistory(companyId, limit = 10) {
        try {
            const company = await prisma.company.findUnique({
                where: { id: companyId }
            });

            if (!company || !company.stripeCustomerId) {
                return [];
            }

            const invoices = await this.stripe.invoices.list({
                customer: company.stripeCustomerId,
                limit
            });

            return invoices.data.map(invoice => ({
                id: invoice.id,
                date: new Date(invoice.created * 1000),
                amount: invoice.amount_paid / 100,
                currency: invoice.currency.toUpperCase(),
                status: invoice.status,
                description: invoice.description || 'Assinatura ChatFlow',
                downloadUrl: invoice.invoice_pdf
            }));

        } catch (error) {
            logger.error('Error fetching billing history:', error);
            throw error;
        }
    }

    async getUsageStats(companyId) {
        try {
            const currentMonth = new Date();
            currentMonth.setDate(1);
            currentMonth.setHours(0, 0, 0, 0);

            const company = await prisma.company.findUnique({
                where: { id: companyId },
                include: {
                    users: {
                        where: {
                            status: 'ACTIVE',
                            role: { in: ['AGENT', 'MANAGER'] }
                        }
                    }
                }
            });

            const messageCount = await prisma.message.count({
                where: {
                    conversation: { companyId },
                    timestamp: { gte: currentMonth }
                }
            });

            const plan = this.plans[company.plan];

            return {
                currentPlan: plan.name,
                billing: {
                    amount: plan.price,
                    currency: plan.currency,
                    cycle: 'monthly'
                },
                usage: {
                    agents: {
                        current: company.users.length,
                        limit: plan.features.maxAgents,
                        percentage: Math.round((company.users.length / plan.features.maxAgents) * 100)
                    },
                    messages: {
                        current: messageCount,
                        limit: plan.features.maxMessages,
                        percentage: Math.round((messageCount / plan.features.maxMessages) * 100)
                    }
                },
                features: plan.features
            };

        } catch (error) {
            logger.error('Error fetching usage stats:', error);
            throw error;
        }
    }

    getAvailablePlans() {
        return Object.values(this.plans).map(plan => ({
            id: plan.id,
            name: plan.name,
            price: plan.price,
            currency: plan.currency,
            features: plan.features
        }));
    }
}

// Singleton instance
const paymentService = new PaymentService();

module.exports = { paymentService, PLANS };

// src/routes/billing.js
const express = require('express');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { paymentService } = require('../services/paymentService');

const router = express.Router();

router.use(authenticateToken);

// Listar planos disponíveis
router.get('/plans', async (req, res) => {
    try {
        const plans = paymentService.getAvailablePlans();
        res.json(plans);
    } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({ error: 'Erro ao buscar planos' });
    }
});

// Obter estatísticas de uso
router.get('/usage', async (req, res) => {
    try {
        const stats = await paymentService.getUsageStats(req.user.companyId);
        res.json(stats);
    } catch (error) {
        console.error('Error fetching usage stats:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas de uso' });
    }
});

// Criar nova assinatura
router.post('/subscription',
    requireRole('OWNER'),
    async (req, res) => {
        try {
            const { planId, paymentMethodId } = req.body;

            const result = await paymentService.createSubscription(
                req.user.companyId,
                planId,
                paymentMethodId
            );

            res.json(result);
        } catch (error) {
            console.error('Error creating subscription:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Atualizar assinatura
router.put('/subscription',
    requireRole('OWNER'),
    async (req, res) => {
        try {
            const { planId } = req.body;

            const subscription = await paymentService.updateSubscription(
                req.user.companyId,
                planId
            );

            res.json(subscription);
        } catch (error) {
            console.error('Error updating subscription:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Cancelar assinatura
router.delete('/subscription',
    requireRole('OWNER'),
    async (req, res) => {
        try {
            const { immediate = false } = req.body;

            const subscription = await paymentService.cancelSubscription(
                req.user.companyId,
                !immediate
            );

            res.json(subscription);
        } catch (error) {
            console.error('Error canceling subscription:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Histórico de cobrança
router.get('/history', async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        const history = await paymentService.getBillingHistory(
            req.user.companyId,
            parseInt(limit)
        );

        res.json(history);
    } catch (error) {
        console.error('Error fetching billing history:', error);
        res.status(500).json({ error: 'Erro ao buscar histórico de cobrança' });
    }
});

// Criar payment intent para pagamento único
router.post('/payment-intent',
    requireRole('OWNER'),
    async (req, res) => {
        try {
            const { amount, currency = 'brl' } = req.body;

            const paymentIntent = await paymentService.createPaymentIntent(
                req.user.companyId,
                amount,
                currency
            );

            res.json({
                clientSecret: paymentIntent.client_secret
            });

        } catch (error) {
            console.error('Error creating payment intent:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

module.exports = router;

// src/components/PricingPlans.jsx - Componente React para planos
import React, { useState, useEffect } from 'react';
import { Check, Zap, Crown, Star, ArrowRight } from 'lucide-react';

const PricingPlans = ({ currentPlan = 'STARTER', onSelectPlan }) => {
    const [plans, setPlans] = useState([]);
    const [isLoading, setIsLoading] = useState(false);

    const planIcons = {
        STARTER: Zap,
        BUSINESS: Star,
        ENTERPRISE: Crown,
        CUSTOM: Crown
    };

    const planColors = {
        STARTER: 'blue',
        BUSINESS: 'purple',
        ENTERPRISE: 'green',
        CUSTOM: 'yellow'
    };

    useEffect(() => {
        fetchPlans();
    }, []);

    const fetchPlans = async () => {
        try {
            const response = await fetch('/api/billing/plans');
            const data = await response.json();
            setPlans(data);
        } catch (error) {
            console.error('Error fetching plans:', error);
        }
    };

    const handleSelectPlan = async (planId) => {
        if (planId === currentPlan) return;

        setIsLoading(true);
        try {
            await onSelectPlan(planId);
        } catch (error) {
            console.error('Error selecting plan:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const formatFeature = (key, value) => {
        switch (key) {
            case 'maxAgents':
                return `Até ${value} agentes`;
            case 'maxMessages':
                return `${value.toLocaleString()} mensagens/mês`;
            case 'hasAI':
                return value ? 'IA Conversacional' : null;
            case 'hasAnalytics':
                return value ? 'Analytics Avançado' : null;
            case 'hasAPI':
                return value ? 'API de Integração' : null;
            case 'hasWhiteLabel':
                return value ? 'White Label' : null;
            case 'supportLevel':
                return {
                    'email': 'Suporte por Email',
                    'chat': 'Suporte por Chat',
                    'priority': 'Suporte Prioritário',
                    'dedicated': 'Suporte Dedicado'
                }[value];
            default:
                return null;
        }
    };

    return (
        <div className="py-12">
            <div className="text-center mb-12">
                <h2 className="text-3xl font-bold text-gray-900 mb-4">
                    Escolha o Plano Ideal para sua Empresa
                </h2>
                <p className="text-lg text-gray-600 max-w-2xl mx-auto">
                    Todos os planos incluem WhatsApp Business API, multi-atendimento e suporte técnico
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
                {plans.map((plan) => {
                    const Icon = planIcons[plan.id.toUpperCase()] || Zap;
                    const color = planColors[plan.id.toUpperCase()] || 'blue';
                    const isCurrentPlan = plan.id.toUpperCase() === currentPlan;
                    const isPopular = plan.id.toUpperCase() === 'BUSINESS';

                    return (
                        <div
                            key={plan.id}
                            className={`relative bg-white rounded-2xl shadow-lg border-2 transition-all duration-300 hover:shadow-xl ${
                                isCurrentPlan
                                    ? `border-${color}-500`
                                    : 'border-gray-200 hover:border-gray-300'
                            }`}
                        >
                            {isPopular && (
                                <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
                  <span className="bg-purple-600 text-white px-4 py-1 rounded-full text-sm font-medium">
                    Mais Popular
                  </span>
                                </div>
                            )}

                            <div className="p-8">
                                {/* Header */}
                                <div className="text-center mb-8">
                                    <div className={`inline-flex items-center justify-center w-12 h-12 bg-${color}-100 rounded-xl mb-4`}>
                                        <Icon className={`w-6 h-6 text-${color}-600`} />
                                    </div>

                                    <h3 className="text-xl font-bold text-gray-900 mb-2">
                                        {plan.name}
                                    </h3>

                                    <div className="flex items-baseline justify-center gap-1">
                                        {plan.price ? (
                                            <>
                        <span className="text-4xl font-bold text-gray-900">
                          R$ {plan.price}
                        </span>
                                                <span className="text-gray-600">/mês</span>
                                            </>
                                        ) : (
                                            <span className="text-2xl font-bold text-gray-900">
                        Sob Consulta
                      </span>
                                        )}
                                    </div>
                                </div>

                                {/* Features */}
                                <div className="space-y-4 mb-8">
                                    {Object.entries(plan.features).map(([key, value]) => {
                                        const featureText = formatFeature(key, value);
                                        if (!featureText) return null;

                                        return (
                                            <div key={key} className="flex items-center gap-3">
                                                <Check className={`w-5 h-5 text-${color}-600`} />
                                                <span className="text-gray-700">{featureText}</span>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* CTA Button */}
                                <button
                                    onClick={() => handleSelectPlan(plan.id)}
                                    disabled={isCurrentPlan || isLoading}
                                    className={`w-full py-3 px-6 rounded-xl font-semibold transition-all duration-200 ${
                                        isCurrentPlan
                                            ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                                            : plan.id.toUpperCase() === 'CUSTOM'
                                                ? 'bg-gray-900 text-white hover:bg-gray-800'
                                                : `bg-${color}-600 text-white hover:bg-${color}-700`
                                    }`}
                                >
                                    {isCurrentPlan ? (
                                        'Plano Atual'
                                    ) : plan.id.toUpperCase() === 'CUSTOM' ? (
                                        <>
                                            Entrar em Contato
                                            <ArrowRight className="w-4 h-4 inline ml-2" />
                                        </>
                                    ) : (
                                        <>
                                            Escolher {plan.name}
                                            <ArrowRight className="w-4 h-4 inline ml-2" />
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* FAQ Section */}
            <div className="mt-16 text-center">
                <h3 className="text-xl font-bold text-gray-900 mb-4">
                    Dúvidas sobre os Planos?
                </h3>
                <p className="text-gray-600 mb-6">
                    Nossa equipe está pronta para ajudar você a escolher o melhor plano
                </p>
                <button className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors">
                    Falar com Especialista
                </button>
            </div>
        </div>
    );
};

export default PricingPlans;

// Adicionar ao src/server.js - rotas de billing
app.use('/api/billing', require('./routes/billing'));