// src/routes/campaigns.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, requireRole, checkPlanLimits } = require('../middleware/auth');
const { validate, schemas } = require('../utils/validation');
const { campaignService } = require('../services/campaignService');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticateToken);

// Listar campanhas
router.get('/', async (req, res) => {
    try {
        const { page, limit, status } = req.query;
        const result = await campaignService.getCampaigns(
            req.user.companyId,
            { page, limit, status }
        );
        res.json(result);
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        res.status(500).json({ error: 'Erro ao buscar campanhas' });
    }
});

// Buscar campanha específica
router.get('/:id', async (req, res) => {
    try {
        const campaign = await prisma.campaign.findUnique({
            where: {
                id: req.params.id,
                companyId: req.user.companyId
            }
        });

        if (!campaign) {
            return res.status(404).json({ error: 'Campanha não encontrada' });
        }

        res.json(campaign);
    } catch (error) {
        console.error('Error fetching campaign:', error);
        res.status(500).json({ error: 'Erro ao buscar campanha' });
    }
});

// Criar nova campanha
router.post('/',
    requireRole('OWNER', 'ADMIN', 'MANAGER'),
    validate(schemas.createCampaign),
    checkPlanLimits('messages'),
    async (req, res) => {
        try {
            const campaign = await campaignService.createCampaign(
                req.user.companyId,
                req.body
            );
            res.status(201).json(campaign);
        } catch (error) {
            console.error('Error creating campaign:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Iniciar campanha
router.post('/:id/start',
    requireRole('OWNER', 'ADMIN', 'MANAGER'),
    async (req, res) => {
        try {
            const result = await campaignService.startCampaign(req.params.id);
            res.json(result);
        } catch (error) {
            console.error('Error starting campaign:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Cancelar campanha
router.post('/:id/cancel',
    requireRole('OWNER', 'ADMIN', 'MANAGER'),
    async (req, res) => {
        try {
            const result = await campaignService.cancelCampaign(req.params.id);
            res.json(result);
        } catch (error) {
            console.error('Error cancelling campaign:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

// Deletar campanha
router.delete('/:id',
    requireRole('OWNER', 'ADMIN'),
    async (req, res) => {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: {
                    id: req.params.id,
                    companyId: req.user.companyId
                }
            });

            if (!campaign) {
                return res.status(404).json({ error: 'Campanha não encontrada' });
            }

            if (campaign.status === 'SENDING') {
                return res.status(400).json({
                    error: 'Não é possível deletar uma campanha em envio'
                });
            }

            await prisma.campaign.delete({
                where: { id: req.params.id }
            });

            res.json({ message: 'Campanha deletada com sucesso' });
        } catch (error) {
            console.error('Error deleting campaign:', error);
            res.status(500).json({ error: 'Erro ao deletar campanha' });
        }
    }
);

module.exports = router;

// src/routes/analytics.js
const express = require('express');
const { authenticateToken, requirePlan } = require('../middleware/auth');
const { analyticsService } = require('../services/analyticsService');

const router = express.Router();

router.use(authenticateToken);
router.use(requirePlan('BUSINESS', 'ENTERPRISE', 'CUSTOM'));

// Dashboard principal
router.get('/dashboard', async (req, res) => {
    try {
        const { dateRange = 30 } = req.query;
        const stats = await analyticsService.getDashboardStats(
            req.user.companyId,
            parseInt(dateRange)
        );
        res.json(stats);
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
});

// Relatório de conversas
router.get('/conversations', async (req, res) => {
    try {
        const options = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            departmentId: req.query.departmentId,
            agentId: req.query.agentId,
            status: req.query.status,
            page: req.query.page,
            limit: req.query.limit
        };

        const report = await analyticsService.getConversationReport(
            req.user.companyId,
            options
        );
        res.json(report);
    } catch (error) {
        console.error('Error generating conversation report:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório de conversas' });
    }
});

// Relatório de campanha
router.get('/campaigns/:id', async (req, res) => {
    try {
        const report = await analyticsService.getCampaignReport(
            req.user.companyId,
            req.params.id
        );
        res.json(report);
    } catch (error) {
        console.error('Error generating campaign report:', error);
        res.status(500).json({ error: error.message });
    }
});

// Performance de agente
router.get('/agents/:id', async (req, res) => {
    try {
        const { dateRange = 30 } = req.query;
        const performance = await analyticsService.getAgentPerformance(
            req.user.companyId,
            req.params.id,
            parseInt(dateRange)
        );
        res.json(performance);
    } catch (error) {
        console.error('Error generating agent performance:', error);
        res.status(500).json({ error: error.message });
    }
});

// Exportar relatórios (CSV)
router.get('/export/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { startDate, endDate } = req.query;

        // Implementar exportação para CSV
        // Por simplicidade, retornando JSON por enquanto
        let data;

        switch (type) {
            case 'conversations':
                data = await analyticsService.getConversationReport(
                    req.user.companyId,
                    { startDate, endDate, limit: 10000 }
                );
                break;
            case 'dashboard':
                data = await analyticsService.getDashboardStats(req.user.companyId);
                break;
            default:
                return res.status(400).json({ error: 'Tipo de relatório inválido' });
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${type}_report.json"`);
        res.json(data);

    } catch (error) {
        console.error('Error exporting report:', error);
        res.status(500).json({ error: 'Erro ao exportar relatório' });
    }
});

module.exports = router;

// src/routes/webhooks.js
const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Middleware para verificar assinatura do webhook
const verifyWebhookSignature = (req, res, next) => {
    const signature = req.headers['x-webhook-signature'];
    const payload = JSON.stringify(req.body);
    const secret = process.env.WEBHOOK_SECRET;

    if (!signature || !secret) {
        return res.status(401).json({ error: 'Assinatura não fornecida' });
    }

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    if (signature !== `sha256=${expectedSignature}`) {
        return res.status(401).json({ error: 'Assinatura inválida' });
    }

    next();
};

// Webhook para WhatsApp Business API
router.post('/whatsapp', verifyWebhookSignature, async (req, res) => {
    try {
        const { entry } = req.body;

        for (const entryItem of entry) {
            const { changes } = entryItem;

            for (const change of changes) {
                if (change.field === 'messages') {
                    const { value } = change;

                    // Processar mensagens recebidas
                    if (value.messages) {
                        for (const message of value.messages) {
                            await processWhatsAppMessage(message, value.metadata);
                        }
                    }

                    // Processar status de mensagens
                    if (value.statuses) {
                        for (const status of value.statuses) {
                            await processMessageStatus(status);
                        }
                    }
                }
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        logger.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Erro no processamento do webhook' });
    }
});

// Webhook para pagamentos (Stripe, PagSeguro, etc.)
router.post('/payment', verifyWebhookSignature, async (req, res) => {
    try {
        const { type, data } = req.body;

        switch (type) {
            case 'invoice.payment_succeeded':
                await handlePaymentSuccess(data.object);
                break;
            case 'invoice.payment_failed':
                await handlePaymentFailed(data.object);
                break;
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(data.object);
                break;
            default:
                logger.info(`Unhandled webhook event: ${type}`);
        }

        res.status(200).json({ received: true });
    } catch (error) {
        logger.error('Payment webhook error:', error);
        res.status(500).json({ error: 'Erro no processamento do pagamento' });
    }
});

async function processWhatsAppMessage(message, metadata) {
    // Implementar processamento de mensagem do WhatsApp Business API
    logger.info('Processing WhatsApp message:', {
        messageId: message.id,
        from: message.from
    });
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
    } catch (error) {
        logger.error('Error updating message status:', error);
    }
}

async function handlePaymentSuccess(invoice) {
    try {
        const companyId = invoice.metadata.companyId;

        await prisma.company.update({
            where: { id: companyId },
            data: {
                status: 'ACTIVE',
                plan: invoice.metadata.plan
            }
        });

        logger.info(`Payment successful for company ${companyId}`);
    } catch (error) {
        logger.error('Error handling payment success:', error);
    }
}

async function handlePaymentFailed(invoice) {
    try {
        const companyId = invoice.metadata.companyId;

        await prisma.company.update({
            where: { id: companyId },
            data: { status: 'SUSPENDED' }
        });

        logger.info(`Payment failed for company ${companyId}`);
    } catch (error) {
        logger.error('Error handling payment failure:', error);
    }
}

async function handleSubscriptionUpdated(subscription) {
    try {
        const companyId = subscription.metadata.companyId;

        await prisma.company.update({
            where: { id: companyId },
            data: {
                plan: subscription.metadata.plan,
                status: subscription.status === 'active' ? 'ACTIVE' : 'SUSPENDED'
            }
        });

        logger.info(`Subscription updated for company ${companyId}`);
    } catch (error) {
        logger.error('Error handling subscription update:', error);
    }
}

module.exports = router;

// src/routes/admin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validate, schemas } = require('../utils/validation');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticateToken);

// Gerenciar usuários da empresa
router.get('/users', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: { companyId: req.user.companyId },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                isOnline: true,
                lastSeen: true,
                createdAt: true,
                department: {
                    select: { id: true, name: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Erro ao buscar usuários' });
    }
});

// Criar novo usuário
router.post('/users',
    requireRole('OWNER', 'ADMIN'),
    validate(schemas.createUser),
    async (req, res) => {
        try {
            const { email, name, password, role, phone, departmentId } = req.body;

            // Verificar se email já existe
            const existingUser = await prisma.user.findUnique({ where: { email } });
            if (existingUser) {
                return res.status(400).json({ error: 'Email já cadastrado' });
            }

            // Verificar limites do plano
            const company = await prisma.company.findUnique({
                where: { id: req.user.companyId },
                include: {
                    users: {
                        where: {
                            status: 'ACTIVE',
                            role: { in: ['AGENT', 'MANAGER'] }
                        }
                    }
                }
            });

            if (company.users.length >= company.maxAgents) {
                return res.status(403).json({
                    error: 'Limite de agentes atingido para seu plano'
                });
            }

            const hashedPassword = await bcrypt.hash(password, 12);

            const user = await prisma.user.create({
                data: {
                    email,
                    name,
                    password: hashedPassword,
                    role,
                    phone,
                    companyId: req.user.companyId,
                    departmentId
                },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    status: true,
                    createdAt: true
                }
            });

            res.status(201).json(user);
        } catch (error) {
            console.error('Error creating user:', error);
            res.status(500).json({ error: 'Erro ao criar usuário' });
        }
    }
);

// Atualizar usuário
router.put('/users/:id',
    requireRole('OWNER', 'ADMIN'),
    validate(schemas.updateUser),
    async (req, res) => {
        try {
            const { id } = req.params;

            const user = await prisma.user.findUnique({
                where: { id, companyId: req.user.companyId }
            });

            if (!user) {
                return res.status(404).json({ error: 'Usuário não encontrado' });
            }

            const updatedUser = await prisma.user.update({
                where: { id },
                data: req.body,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    status: true,
                    phone: true,
                    department: {
                        select: { id: true, name: true }
                    }
                }
            });

            res.json(updatedUser);
        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).json({ error: 'Erro ao atualizar usuário' });
        }
    }
);

// Deletar usuário
router.delete('/users/:id',
    requireRole('OWNER', 'ADMIN'),
    async (req, res) => {
        try {
            const { id } = req.params;

            if (id === req.user.id) {
                return res.status(400).json({ error: 'Você não pode deletar sua própria conta' });
            }

            const user = await prisma.user.findUnique({
                where: { id, companyId: req.user.companyId }
            });

            if (!user) {
                return res.status(404).json({ error: 'Usuário não encontrado' });
            }

            await prisma.user.delete({ where: { id } });

            res.json({ message: 'Usuário deletado com sucesso' });
        } catch (error) {
            console.error('Error deleting user:', error);
            res.status(500).json({ error: 'Erro ao deletar usuário' });
        }
    }
);

// Gerenciar departamentos
router.get('/departments', async (req, res) => {
    try {
        const departments = await prisma.department.findMany({
            where: { companyId: req.user.companyId },
            include: {
                users: {
                    select: { id: true, name: true }
                },
                _count: {
                    select: { conversations: true }
                }
            },
            orderBy: { name: 'asc' }
        });

        res.json(departments);
    } catch (error) {
        console.error('Error fetching departments:', error);
        res.status(500).json({ error: 'Erro ao buscar departamentos' });
    }
});

// Criar departamento
router.post('/departments',
    requireRole('OWNER', 'ADMIN'),
    validate(schemas.createDepartment),
    async (req, res) => {
        try {
            const department = await prisma.department.create({
                data: {
                    ...req.body,
                    companyId: req.user.companyId
                }
            });

            res.status(201).json(department);
        } catch (error) {
            console.error('Error creating department:', error);
            res.status(500).json({ error: 'Erro ao criar departamento' });
        }
    }
);

// Configurações da empresa
router.get('/company', async (req, res) => {
    try {
        const company = await prisma.company.findUnique({
            where: { id: req.user.companyId },
            select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                plan: true,
                status: true,
                maxAgents: true,
                maxMessages: true,
                hasAI: true,
                hasAnalytics: true,
                createdAt: true
            }
        });

        res.json(company);
    } catch (error) {
        console.error('Error fetching company:', error);
        res.status(500).json({ error: 'Erro ao buscar dados da empresa' });
    }
});

// Atualizar configurações da empresa
router.put('/company',
    requireRole('OWNER'),
    async (req, res) => {
        try {
            const { name, email, phone } = req.body;

            const company = await prisma.company.update({
                where: { id: req.user.companyId },
                data: { name, email, phone },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    plan: true,
                    status: true
                }
            });

            res.json(company);
        } catch (error) {
            console.error('Error updating company:', error);
            res.status(500).json({ error: 'Erro ao atualizar empresa' });
        }
    }
);

module.exports = router;