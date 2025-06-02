// src/services/campaignService.js
const { PrismaClient } = require('@prisma/client');
const { whatsappService } = require('./whatsapp');
const { notifyCompany } = require('./socket');
const logger = require('../utils/logger');
const { delay, formatPhone, isValidBrazilianPhone } = require('../utils/helpers');

const prisma = new PrismaClient();

class CampaignService {
    constructor() {
        this.runningCampaigns = new Map();
    }

    async createCampaign(companyId, campaignData) {
        try {
            const { name, content, recipients, scheduledAt } = campaignData;

            // Validar e formatar telefones
            const validRecipients = [];
            const invalidPhones = [];

            for (const recipient of recipients) {
                const formattedPhone = formatPhone(recipient.phone);

                if (isValidBrazilianPhone(formattedPhone)) {
                    validRecipients.push({
                        ...recipient,
                        phone: formattedPhone
                    });
                } else {
                    invalidPhones.push(recipient.phone);
                }
            }

            if (invalidPhones.length > 0) {
                throw new Error(`Telefones inválidos encontrados: ${invalidPhones.join(', ')}`);
            }

            // Criar campanha no banco
            const campaign = await prisma.campaign.create({
                data: {
                    name,
                    content,
                    recipients: validRecipients,
                    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
                    status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
                    companyId,
                    results: {
                        total: validRecipients.length,
                        sent: 0,
                        delivered: 0,
                        failed: 0,
                        errors: []
                    }
                }
            });

            // Se não foi agendada, iniciar envio imediatamente
            if (!scheduledAt) {
                await this.startCampaign(campaign.id);
            }

            return campaign;

        } catch (error) {
            logger.error('Error creating campaign:', error);
            throw error;
        }
    }

    async startCampaign(campaignId) {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                include: { company: { include: { whatsappAccounts: true } } }
            });

            if (!campaign) {
                throw new Error('Campanha não encontrada');
            }

            if (campaign.status === 'SENDING' || campaign.status === 'SENT') {
                throw new Error('Campanha já foi enviada');
            }

            // Verificar se há contas WhatsApp conectadas
            const connectedAccounts = campaign.company.whatsappAccounts.filter(
                acc => acc.status === 'CONNECTED'
            );

            if (connectedAccounts.length === 0) {
                throw new Error('Nenhuma conta WhatsApp conectada');
            }

            // Atualizar status para enviando
            await prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    status: 'SENDING',
                    sentAt: new Date()
                }
            });

            // Iniciar envio em background
            this.processCampaign(campaign, connectedAccounts[0]);

            return { message: 'Campanha iniciada com sucesso' };

        } catch (error) {
            logger.error('Error starting campaign:', error);
            throw error;
        }
    }

    async processCampaign(campaign, whatsappAccount) {
        const campaignId = campaign.id;
        this.runningCampaigns.set(campaignId, true);

        try {
            const recipients = campaign.recipients;
            const results = { ...campaign.results };

            logger.info(`Starting campaign ${campaignId} with ${recipients.length} recipients`);

            // Notificar início da campanha
            await notifyCompany(campaign.companyId, 'campaign:started', {
                campaignId: campaignId,
                recipientCount: recipients.length
            });

            // Processar em lotes para evitar spam
            const batchSize = 10;
            const delayBetweenMessages = 2000; // 2 segundos entre mensagens
            const delayBetweenBatches = 30000; // 30 segundos entre lotes

            for (let i = 0; i < recipients.length; i += batchSize) {
                // Verificar se a campanha foi cancelada
                if (!this.runningCampaigns.has(campaignId)) {
                    break;
                }

                const batch = recipients.slice(i, i + batchSize);

                for (const recipient of batch) {
                    try {
                        // Verificar se já existe uma conversa com este contato
                        let contact = await prisma.contact.findUnique({
                            where: { phone: recipient.phone }
                        });

                        if (!contact) {
                            contact = await prisma.contact.create({
                                data: {
                                    phone: recipient.phone,
                                    name: recipient.name || recipient.phone
                                }
                            });
                        }

                        // Criar ou buscar conversa
                        let conversation = await prisma.conversation.findFirst({
                            where: {
                                contactId: contact.id,
                                companyId: campaign.companyId,
                                status: { in: ['OPEN', 'PENDING'] }
                            }
                        });

                        if (!conversation) {
                            conversation = await prisma.conversation.create({
                                data: {
                                    contactId: contact.id,
                                    companyId: campaign.companyId,
                                    whatsappId: whatsappAccount.id,
                                    status: 'OPEN',
                                    channel: 'WHATSAPP'
                                }
                            });
                        }

                        // Enviar mensagem
                        const sendResult = await whatsappService.sendMessage(
                            whatsappAccount.id,
                            recipient.phone,
                            campaign.content
                        );

                        if (sendResult.success) {
                            // Salvar mensagem no banco
                            await prisma.message.create({
                                data: {
                                    content: campaign.content,
                                    type: 'TEXT',
                                    direction: 'OUTBOUND',
                                    status: 'DELIVERED',
                                    conversationId: conversation.id,
                                    metadata: {
                                        campaignId: campaignId,
                                        whatsappId: sendResult.messageId
                                    }
                                }
                            });

                            results.sent++;
                            results.delivered++;
                        } else {
                            results.failed++;
                            results.errors.push({
                                phone: recipient.phone,
                                error: 'Falha no envio'
                            });
                        }

                        // Delay entre mensagens
                        await delay(delayBetweenMessages);

                    } catch (error) {
                        logger.error(`Error sending to ${recipient.phone}:`, error);
                        results.failed++;
                        results.errors.push({
                            phone: recipient.phone,
                            error: error.message
                        });
                    }
                }

                // Atualizar progresso no banco
                await prisma.campaign.update({
                    where: { id: campaignId },
                    data: { results }
                });

                // Notificar progresso
                await notifyCompany(campaign.companyId, 'campaign:progress', {
                    campaignId: campaignId,
                    progress: {
                        sent: results.sent,
                        total: recipients.length,
                        percentage: Math.round((results.sent / recipients.length) * 100)
                    }
                });

                // Delay entre lotes (exceto no último)
                if (i + batchSize < recipients.length) {
                    await delay(delayBetweenBatches);
                }
            }

            // Finalizar campanha
            await prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    status: 'SENT',
                    results
                }
            });

            // Notificar conclusão
            await notifyCompany(campaign.companyId, 'campaign:completed', {
                campaignId: campaignId,
                results
            });

            logger.info(`Campaign ${campaignId} completed. Sent: ${results.sent}/${recipients.length}`);

        } catch (error) {
            logger.error(`Error processing campaign ${campaignId}:`, error);

            await prisma.campaign.update({
                where: { id: campaignId },
                data: { status: 'FAILED' }
            });

            await notifyCompany(campaign.companyId, 'campaign:failed', {
                campaignId: campaignId,
                error: error.message
            });

        } finally {
            this.runningCampaigns.delete(campaignId);
        }
    }

    async cancelCampaign(campaignId) {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId }
            });

            if (!campaign) {
                throw new Error('Campanha não encontrada');
            }

            if (campaign.status !== 'SENDING') {
                throw new Error('Apenas campanhas em envio podem ser canceladas');
            }

            // Remover da lista de campanhas em execução
            this.runningCampaigns.delete(campaignId);

            // Atualizar status
            await prisma.campaign.update({
                where: { id: campaignId },
                data: { status: 'CANCELLED' }
            });

            return { message: 'Campanha cancelada com sucesso' };

        } catch (error) {
            logger.error('Error cancelling campaign:', error);
            throw error;
        }
    }

    async getCampaigns(companyId, options = {}) {
        const { page = 1, limit = 20, status } = options;

        const where = {
            companyId,
            ...(status && { status })
        };

        const campaigns = await prisma.campaign.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: parseInt(limit)
        });

        const total = await prisma.campaign.count({ where });

        return {
            campaigns,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        };
    }

    // Verificar campanhas agendadas
    async checkScheduledCampaigns() {
        try {
            const now = new Date();
            const scheduledCampaigns = await prisma.campaign.findMany({
                where: {
                    status: 'SCHEDULED',
                    scheduledAt: { lte: now }
                }
            });

            for (const campaign of scheduledCampaigns) {
                try {
                    await this.startCampaign(campaign.id);
                    logger.info(`Started scheduled campaign ${campaign.id}`);
                } catch (error) {
                    logger.error(`Error starting scheduled campaign ${campaign.id}:`, error);
                }
            }

        } catch (error) {
            logger.error('Error checking scheduled campaigns:', error);
        }
    }
}

// Singleton instance
const campaignService = new CampaignService();

// Verificar campanhas agendadas a cada minuto
setInterval(() => {
    campaignService.checkScheduledCampaigns();
}, 60000);

module.exports = { campaignService };

// src/services/analyticsService.js
const { PrismaClient } = require('@prisma/client');
const { calculateAverageResponseTime } = require('../utils/helpers');

const prisma = new PrismaClient();

class AnalyticsService {
    async getDashboardStats(companyId, dateRange = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dateRange);

            // Conversas por período
            const conversations = await prisma.conversation.findMany({
                where: {
                    companyId,
                    createdAt: { gte: startDate }
                },
                include: {
                    messages: {
                        orderBy: { timestamp: 'asc' }
                    },
                    contact: true
                }
            });

            // Mensagens por período
            const messages = await prisma.message.findMany({
                where: {
                    conversation: { companyId },
                    timestamp: { gte: startDate }
                }
            });

            // Estatísticas básicas
            const totalConversations = conversations.length;
            const totalMessages = messages.length;
            const totalContacts = await prisma.contact.count({
                where: {
                    conversations: {
                        some: { companyId }
                    }
                }
            });

            // Conversas por status
            const conversationsByStatus = await prisma.conversation.groupBy({
                by: ['status'],
                where: {
                    companyId,
                    createdAt: { gte: startDate }
                },
                _count: true
            });

            // Mensagens por direção
            const messagesByDirection = messages.reduce((acc, msg) => {
                acc[msg.direction] = (acc[msg.direction] || 0) + 1;
                return acc;
            }, {});

            // Tempo médio de resposta
            const avgResponseTime = calculateAverageResponseTime(conversations);

            // Taxa de resolução
            const resolvedConversations = conversations.filter(c => c.status === 'CLOSED').length;
            const resolutionRate = totalConversations > 0
                ? Math.round((resolvedConversations / totalConversations) * 100)
                : 0;

            // Avaliações
            const ratings = conversations
                .filter(c => c.rating)
                .map(c => c.rating);

            const avgRating = ratings.length > 0
                ? (ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(1)
                : 0;

            // Conversas por dia (últimos 7 dias)
            const last7Days = Array.from({ length: 7 }, (_, i) => {
                const date = new Date();
                date.setDate(date.getDate() - i);
                return date.toISOString().split('T')[0];
            }).reverse();

            const conversationsByDay = await Promise.all(
                last7Days.map(async (date) => {
                    const startOfDay = new Date(date);
                    const endOfDay = new Date(date);
                    endOfDay.setHours(23, 59, 59, 999);

                    const count = await prisma.conversation.count({
                        where: {
                            companyId,
                            createdAt: {
                                gte: startOfDay,
                                lte: endOfDay
                            }
                        }
                    });

                    return { date, count };
                })
            );

            // Top agentes por conversas atendidas
            const topAgents = await prisma.user.findMany({
                where: {
                    companyId,
                    role: { in: ['AGENT', 'MANAGER'] }
                },
                include: {
                    conversations: {
                        where: {
                            conversation: {
                                createdAt: { gte: startDate },
                                status: 'CLOSED'
                            }
                        },
                        select: {
                            conversation: {
                                select: {
                                    id: true,
                                    rating: true
                                }
                            }
                        }
                    }
                }
            });

            const agentStats = topAgents.map(agent => {
                const conversations = agent.conversations;
                const totalConvs = conversations.length;
                const ratings = conversations
                    .map(c => c.conversation.rating)
                    .filter(r => r !== null);

                const avgRating = ratings.length > 0
                    ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(1)
                    : 0;

                return {
                    id: agent.id,
                    name: agent.name,
                    totalConversations: totalConvs,
                    avgRating: parseFloat(avgRating)
                };
            }).sort((a, b) => b.totalConversations - a.totalConversations);

            return {
                overview: {
                    totalConversations,
                    totalMessages,
                    totalContacts,
                    avgResponseTime,
                    resolutionRate,
                    avgRating: parseFloat(avgRating)
                },
                conversationsByStatus,
                messagesByDirection,
                conversationsByDay,
                topAgents: agentStats.slice(0, 5),
                dateRange: {
                    start: startDate.toISOString(),
                    end: new Date().toISOString()
                }
            };

        } catch (error) {
            logger.error('Error generating dashboard stats:', error);
            throw error;
        }
    }

    async getConversationReport(companyId, options = {}) {
        try {
            const {
                startDate,
                endDate,
                departmentId,
                agentId,
                status,
                page = 1,
                limit = 50
            } = options;

            const where = {
                companyId,
                ...(startDate && { createdAt: { gte: new Date(startDate) } }),
                ...(endDate && { createdAt: { lte: new Date(endDate) } }),
                ...(departmentId && { departmentId }),
                ...(status && { status }),
                ...(agentId && {
                    agents: {
                        some: { userId: agentId, isActive: true }
                    }
                })
            };

            const conversations = await prisma.conversation.findMany({
                where,
                include: {
                    contact: true,
                    agents: {
                        where: { isActive: true },
                        include: { user: { select: { id: true, name: true } } }
                    },
                    department: true,
                    messages: {
                        select: {
                            id: true,
                            direction: true,
                            timestamp: true,
                            isFromBot: true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: parseInt(limit)
            });

            const total = await prisma.conversation.count({ where });

            // Calcular métricas por conversa
            const conversationMetrics = conversations.map(conv => {
                const messages = conv.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                let firstResponse = null;
                let responseTime = null;

                // Encontrar primeira resposta humana
                for (let i = 0; i < messages.length; i++) {
                    if (messages[i].direction === 'INBOUND' && i + 1 < messages.length) {
                        const nextMsg = messages[i + 1];
                        if (nextMsg.direction === 'OUTBOUND' && !nextMsg.isFromBot) {
                            firstResponse = nextMsg;
                            responseTime = new Date(nextMsg.timestamp) - new Date(messages[i].timestamp);
                            break;
                        }
                    }
                }

                return {
                    ...conv,
                    metrics: {
                        totalMessages: messages.length,
                        inboundMessages: messages.filter(m => m.direction === 'INBOUND').length,
                        outboundMessages: messages.filter(m => m.direction === 'OUTBOUND').length,
                        botMessages: messages.filter(m => m.isFromBot).length,
                        firstResponseTime: responseTime ? Math.round(responseTime / 1000 / 60) : null, // em minutos
                        duration: conv.closedAt
                            ? Math.round((new Date(conv.closedAt) - new Date(conv.createdAt)) / 1000 / 60)
                            : null
                    }
                };
            });

            return {
                conversations: conversationMetrics,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / limit)
                }
            };

        } catch (error) {
            logger.error('Error generating conversation report:', error);
            throw error;
        }
    }

    async getCampaignReport(companyId, campaignId) {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId, companyId }
            });

            if (!campaign) {
                throw new Error('Campanha não encontrada');
            }

            // Buscar mensagens relacionadas à campanha
            const campaignMessages = await prisma.message.findMany({
                where: {
                    metadata: {
                        path: ['campaignId'],
                        equals: campaignId
                    }
                },
                include: {
                    conversation: {
                        include: {
                            contact: true
                        }
                    }
                }
            });

            // Calcular métricas detalhadas
            const deliveryRate = campaign.results.total > 0
                ? Math.round((campaign.results.delivered / campaign.results.total) * 100)
                : 0;

            const failureRate = campaign.results.total > 0
                ? Math.round((campaign.results.failed / campaign.results.total) * 100)
                : 0;

            // Analisar respostas dos clientes
            const responses = await prisma.message.findMany({
                where: {
                    direction: 'INBOUND',
                    conversation: {
                        messages: {
                            some: {
                                metadata: {
                                    path: ['campaignId'],
                                    equals: campaignId
                                }
                            }
                        }
                    }
                },
                include: {
                    conversation: {
                        include: {
                            contact: true
                        }
                    }
                }
            });

            const responseRate = campaign.results.delivered > 0
                ? Math.round((responses.length / campaign.results.delivered) * 100)
                : 0;

            return {
                campaign,
                metrics: {
                    deliveryRate,
                    failureRate,
                    responseRate,
                    totalResponses: responses.length
                },
                responses: responses.slice(0, 20), // Primeiras 20 respostas
                errors: campaign.results.errors || []
            };

        } catch (error) {
            logger.error('Error generating campaign report:', error);
            throw error;
        }
    }

    async getAgentPerformance(companyId, agentId, dateRange = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dateRange);

            const agent = await prisma.user.findUnique({
                where: { id: agentId, companyId },
                include: {
                    conversations: {
                        where: {
                            conversation: {
                                createdAt: { gte: startDate }
                            }
                        },
                        include: {
                            conversation: {
                                include: {
                                    messages: true,
                                    contact: true
                                }
                            }
                        }
                    }
                }
            });

            if (!agent) {
                throw new Error('Agente não encontrado');
            }

            const conversations = agent.conversations.map(ca => ca.conversation);

            // Calcular métricas
            const totalConversations = conversations.length;
            const closedConversations = conversations.filter(c => c.status === 'CLOSED').length;
            const avgResponseTime = calculateAverageResponseTime(conversations);

            const ratings = conversations
                .filter(c => c.rating)
                .map(c => c.rating);

            const avgRating = ratings.length > 0
                ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(1)
                : 0;

            const resolutionRate = totalConversations > 0
                ? Math.round((closedConversations / totalConversations) * 100)
                : 0;

            return {
                agent: {
                    id: agent.id,
                    name: agent.name,
                    email: agent.email,
                    role: agent.role
                },
                metrics: {
                    totalConversations,
                    closedConversations,
                    resolutionRate,
                    avgResponseTime,
                    avgRating: parseFloat(avgRating),
                    totalRatings: ratings.length
                },
                recentConversations: conversations
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .slice(0, 10)
            };

        } catch (error) {
            logger.error('Error generating agent performance:', error);
            throw error;
        }
    }
}

const analyticsService = new AnalyticsService();

module.exports = { analyticsService };