// src/services/analyticsService.js
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

class AnalyticsService {
    async getDashboardStats(companyId, dateRange) {
        try {
            const startDate = new Date(Date.now() - dateRange * 24 * 60 * 60 * 1000);
            const endDate = new Date();

            const [
                totalConversations,
                openConversations,
                closedConversations,
                pendingConversations,
                totalMessages,
                avgResponseTime,
                agentStats,
                conversationsByDay,
                messagesByHour
            ] = await Promise.all([
                this.getTotalConversations(companyId, startDate, endDate),
                this.getConversationsByStatus(companyId, 'OPEN'),
                this.getConversationsByStatus(companyId, 'CLOSED', startDate, endDate),
                this.getConversationsByStatus(companyId, 'PENDING'),
                this.getTotalMessages(companyId, startDate, endDate),
                this.getAverageResponseTime(companyId, startDate, endDate),
                this.getAgentStats(companyId, startDate, endDate),
                this.getConversationsByDay(companyId, dateRange),
                this.getMessagesByHour(companyId, startDate, endDate)
            ]);

            return {
                overview: {
                    totalConversations,
                    openConversations,
                    closedConversations,
                    pendingConversations,
                    totalMessages,
                    avgResponseTime: Math.round(avgResponseTime / 60000) // Converter para minutos
                },
                agentStats,
                charts: {
                    conversationsByDay,
                    messagesByHour
                }
            };

        } catch (error) {
            logger.error('Error generating dashboard stats:', error);
            throw error;
        }
    }

    async getConversationsReport(companyId, options = {}) {
        try {
            const { startDate, endDate, departmentId, agentId } = options;

            const where = {
                companyId,
                ...(startDate && endDate && {
                    createdAt: {
                        gte: new Date(startDate),
                        lte: new Date(endDate)
                    }
                }),
                ...(departmentId && { departmentId }),
                ...(agentId && {
                    agents: {
                        some: { userId: agentId, isActive: true }
                    }
                })
            };

            const conversations = await prisma.conversation.findMany({
                where,
                include: {
                    contact: { select: { name: true, phone: true } },
                    agents: {
                        where: { isActive: true },
                        include: { user: { select: { name: true } } }
                    },
                    department: { select: { name: true } },
                    messages: { select: { id: true, timestamp: true } }
                },
                orderBy: { createdAt: 'desc' }
            });

            // Estatísticas
            const stats = {
                total: conversations.length,
                byStatus: {},
                byDepartment: {},
                avgMessagesPerConversation: 0,
                avgDuration: 0
            };

            let totalMessages = 0;
            let totalDuration = 0;

            conversations.forEach(conv => {
                // Por status
                stats.byStatus[conv.status] = (stats.byStatus[conv.status] || 0) + 1;

                // Por departamento
                const deptName = conv.department?.name || 'Não atribuído';
                stats.byDepartment[deptName] = (stats.byDepartment[deptName] || 0) + 1;

                // Mensagens
                totalMessages += conv.messages.length;

                // Duração (se fechada)
                if (conv.status === 'CLOSED' && conv.messages.length > 0) {
                    const firstMessage = conv.messages[0];
                    const lastMessage = conv.messages[conv.messages.length - 1];
                    const duration = new Date(lastMessage.timestamp) - new Date(firstMessage.timestamp);
                    totalDuration += duration;
                }
            });

            stats.avgMessagesPerConversation = conversations.length > 0
                ? Math.round(totalMessages / conversations.length)
                : 0;

            const closedConversations = conversations.filter(c => c.status === 'CLOSED').length;
            stats.avgDuration = closedConversations > 0
                ? Math.round(totalDuration / closedConversations / 60000) // minutos
                : 0;

            return {
                conversations: conversations.map(conv => ({
                    id: conv.id,
                    contact: conv.contact,
                    status: conv.status,
                    department: conv.department?.name,
                    agent: conv.agents[0]?.user?.name,
                    messagesCount: conv.messages.length,
                    createdAt: conv.createdAt,
                    updatedAt: conv.updatedAt
                })),
                stats
            };

        } catch (error) {
            logger.error('Error generating conversations report:', error);
            throw error;
        }
    }

    async getAgentsPerformanceReport(companyId, options = {}) {
        try {
            const { startDate, endDate, departmentId } = options;

            const where = {
                companyId,
                status: 'ACTIVE',
                role: { in: ['AGENT', 'MANAGER'] },
                ...(departmentId && { departmentId })
            };

            const agents = await prisma.user.findMany({
                where,
                include: {
                    agents: {
                        where: {
                            conversation: {
                                ...(startDate && endDate && {
                                    createdAt: {
                                        gte: new Date(startDate),
                                        lte: new Date(endDate)
                                    }
                                })
                            }
                        },
                        include: {
                            conversation: {
                                include: {
                                    messages: {
                                        where: {
                                            userId: true, // Mensagens enviadas pelo agente
                                            ...(startDate && endDate && {
                                                timestamp: {
                                                    gte: new Date(startDate),
                                                    lte: new Date(endDate)
                                                }
                                            })
                                        }
                                    }
                                }
                            }
                        }
                    },
                    department: { select: { name: true } }
                }
            });

            const performance = agents.map(agent => {
                const conversations = agent.agents.map(a => a.conversation);
                const allMessages = conversations.flatMap(c => c.messages);

                return {
                    id: agent.id,
                    name: agent.name,
                    department: agent.department?.name,
                    stats: {
                        conversationsHandled: conversations.length,
                        messagesExchanged: allMessages.length,
                        avgMessagesPerConversation: conversations.length > 0
                            ? Math.round(allMessages.length / conversations.length)
                            : 0,
                        closedConversations: conversations.filter(c => c.status === 'CLOSED').length,
                        resolutionRate: conversations.length > 0
                            ? Math.round((conversations.filter(c => c.status === 'CLOSED').length / conversations.length) * 100)
                            : 0
                    }
                };
            });

            return {
                agents: performance,
                summary: {
                    totalAgents: agents.length,
                    totalConversations: performance.reduce((sum, a) => sum + a.stats.conversationsHandled, 0),
                    totalMessages: performance.reduce((sum, a) => sum + a.stats.messagesExchanged, 0),
                    avgResolutionRate: performance.length > 0
                        ? Math.round(performance.reduce((sum, a) => sum + a.stats.resolutionRate, 0) / performance.length)
                        : 0
                }
            };

        } catch (error) {
            logger.error('Error generating agents performance report:', error);
            throw error;
        }
    }

    async getResponseTimeReport(companyId, options = {}) {
        try {
            const { startDate, endDate, groupBy = 'day' } = options;

            // Buscar conversas com primeira resposta do agente
            const conversations = await prisma.conversation.findMany({
                where: {
                    companyId,
                    ...(startDate && endDate && {
                        createdAt: {
                            gte: new Date(startDate),
                            lte: new Date(endDate)
                        }
                    })
                },
                include: {
                    messages: {
                        orderBy: { timestamp: 'asc' },
                        take: 10 // Primeiras mensagens para calcular tempo de resposta
                    }
                }
            });

            const responseTimes = [];

            conversations.forEach(conv => {
                const messages = conv.messages;
                if (messages.length < 2) return;

                // Encontrar primeira mensagem do cliente e primeira resposta do agente
                const firstInbound = messages.find(m => m.direction === 'INBOUND');
                const firstOutbound = messages.find(m =>
                    m.direction === 'OUTBOUND' &&
                    m.timestamp > firstInbound?.timestamp &&
                    m.userId // Mensagem de agente, não bot
                );

                if (firstInbound && firstOutbound) {
                    const responseTime = new Date(firstOutbound.timestamp) - new Date(firstInbound.timestamp);
                    responseTimes.push({
                        conversationId: conv.id,
                        responseTime: responseTime / 60000, // minutos
                        date: firstOutbound.timestamp
                    });
                }
            });

            // Agrupar por período
            const grouped = this.groupByPeriod(responseTimes, groupBy);

            return {
                data: grouped,
                summary: {
                    avgResponseTime: responseTimes.length > 0
                        ? Math.round(responseTimes.reduce((sum, rt) => sum + rt.responseTime, 0) / responseTimes.length)
                        : 0,
                    minResponseTime: Math.min(...responseTimes.map(rt => rt.responseTime)),
                    maxResponseTime: Math.max(...responseTimes.map(rt => rt.responseTime)),
                    totalConversations: responseTimes.length
                }
            };

        } catch (error) {
            logger.error('Error generating response time report:', error);
            throw error;
        }
    }

    async getSatisfactionReport(companyId, options = {}) {
        try {
            // Implementar quando houver sistema de avaliação
            // Por enquanto, retornar dados mockados
            return {
                ratings: [
                    { rating: 5, count: 45, percentage: 45 },
                    { rating: 4, count: 30, percentage: 30 },
                    { rating: 3, count: 15, percentage: 15 },
                    { rating: 2, count: 7, percentage: 7 },
                    { rating: 1, count: 3, percentage: 3 }
                ],
                summary: {
                    avgRating: 4.1,
                    totalRatings: 100,
                    nps: 65 // Net Promoter Score
                }
            };

        } catch (error) {
            logger.error('Error generating satisfaction report:', error);
            throw error;
        }
    }

    async getMessageVolumeReport(companyId, options = {}) {
        try {
            const { startDate, endDate, groupBy = 'day' } = options;

            const messages = await prisma.message.findMany({
                where: {
                    conversation: { companyId },
                    ...(startDate && endDate && {
                        timestamp: {
                            gte: new Date(startDate),
                            lte: new Date(endDate)
                        }
                    })
                },
                select: {
                    direction: true,
                    timestamp: true,
                    type: true
                }
            });

            const grouped = this.groupMessagesByPeriod(messages, groupBy);

            return {
                data: grouped,
                summary: {
                    totalMessages: messages.length,
                    inboundMessages: messages.filter(m => m.direction === 'INBOUND').length,
                    outboundMessages: messages.filter(m => m.direction === 'OUTBOUND').length,
                    byType: messages.reduce((acc, msg) => {
                        acc[msg.type] = (acc[msg.type] || 0) + 1;
                        return acc;
                    }, {})
                }
            };

        } catch (error) {
            logger.error('Error generating message volume report:', error);
            throw error;
        }
    }

    async exportReport(companyId, reportType, options = {}) {
        try {
            let data;

            switch (reportType) {
                case 'conversations':
                    data = await this.getConversationsReport(companyId, options);
                    return this.convertToCSV(data.conversations, [
                        'id', 'contact.name', 'contact.phone', 'status',
                        'department', 'agent', 'messagesCount', 'createdAt'
                    ]);

                case 'agents-performance':
                    data = await this.getAgentsPerformanceReport(companyId, options);
                    return this.convertToCSV(data.agents, [
                        'name', 'department', 'stats.conversationsHandled',
                        'stats.messagesExchanged', 'stats.resolutionRate'
                    ]);

                default:
                    throw new Error(`Tipo de relatório não suportado: ${reportType}`);
            }

        } catch (error) {
            logger.error('Error exporting report:', error);
            throw error;
        }
    }

    // Métodos auxiliares
    async getTotalConversations(companyId, startDate, endDate) {
        return await prisma.conversation.count({
            where: {
                companyId,
                createdAt: { gte: startDate, lte: endDate }
            }
        });
    }

    async getConversationsByStatus(companyId, status, startDate = null, endDate = null) {
        return await prisma.conversation.count({
            where: {
                companyId,
                status,
                ...(startDate && endDate && {
                    createdAt: { gte: startDate, lte: endDate }
                })
            }
        });
    }

    async getTotalMessages(companyId, startDate, endDate) {
        return await prisma.message.count({
            where: {
                conversation: { companyId },
                timestamp: { gte: startDate, lte: endDate }
            }
        });
    }

    async getAverageResponseTime(companyId, startDate, endDate) {
        // Implementação simplificada - calcular tempo médio de resposta
        const conversations = await prisma.conversation.findMany({
            where: {
                companyId,
                createdAt: { gte: startDate, lte: endDate }
            },
            include: {
                messages: {
                    orderBy: { timestamp: 'asc' },
                    take: 5
                }
            }
        });

        let totalResponseTime = 0;
        let validResponses = 0;

        conversations.forEach(conv => {
            const messages = conv.messages;
            for (let i = 0; i < messages.length - 1; i++) {
                if (messages[i].direction === 'INBOUND' &&
                    messages[i + 1].direction === 'OUTBOUND' &&
                    messages[i + 1].userId) {
                    const responseTime = new Date(messages[i + 1].timestamp) - new Date(messages[i].timestamp);
                    totalResponseTime += responseTime;
                    validResponses++;
                    break;
                }
            }
        });

        return validResponses > 0 ? totalResponseTime / validResponses : 0;
    }

    async getAgentStats(companyId, startDate, endDate) {
        const agents = await prisma.user.findMany({
            where: {
                companyId,
                role: { in: ['AGENT', 'MANAGER'] },
                status: 'ACTIVE'
            },
            include: {
                agents: {
                    where: {
                        conversation: {
                            createdAt: { gte: startDate, lte: endDate }
                        }
                    }
                }
            }
        });

        return {
            totalAgents: agents.length,
            onlineAgents: agents.filter(a => a.isOnline).length,
            agentsWithConversations: agents.filter(a => a.agents.length > 0).length
        };
    }

    async getConversationsByDay(companyId, days) {
        const dates = Array.from({ length: days }, (_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - i);
            return date.toISOString().split('T')[0];
        }).reverse();

        const data = await Promise.all(
            dates.map(async (date) => {
                const startOfDay = new Date(`${date}T00:00:00.000Z`);
                const endOfDay = new Date(`${date}T23:59:59.999Z`);

                const count = await prisma.conversation.count({
                    where: {
                        companyId,
                        createdAt: { gte: startOfDay, lte: endOfDay }
                    }
                });

                return { date, count };
            })
        );

        return data;
    }

    async getMessagesByHour(companyId, startDate, endDate) {
        const messages = await prisma.message.findMany({
            where: {
                conversation: { companyId },
                timestamp: { gte: startDate, lte: endDate }
            },
            select: { timestamp: true }
        });

        const hourlyData = Array.from({ length: 24 }, (_, hour) => ({
            hour,
            count: 0
        }));

        messages.forEach(msg => {
            const hour = new Date(msg.timestamp).getHours();
            hourlyData[hour].count++;
        });

        return hourlyData;
    }

    groupByPeriod(data, groupBy) {
        // Implementar agrupamento por dia/semana/mês
        return data.reduce((acc, item) => {
            const date = new Date(item.date);
            let key;

            switch (groupBy) {
                case 'hour':
                    key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}`;
                    break;
                case 'day':
                    key = date.toISOString().split('T')[0];
                    break;
                case 'week':
                    const weekStart = new Date(date);
                    weekStart.setDate(date.getDate() - date.getDay());
                    key = weekStart.toISOString().split('T')[0];
                    break;
                case 'month':
                    key = `${date.getFullYear()}-${date.getMonth() + 1}`;
                    break;
                default:
                    key = date.toISOString().split('T')[0];
            }

            if (!acc[key]) {
                acc[key] = { period: key, values: [] };
            }
            acc[key].values.push(item.responseTime);

            return acc;
        }, {});
    }

    groupMessagesByPeriod(messages, groupBy) {
        const grouped = messages.reduce((acc, msg) => {
            const date = new Date(msg.timestamp);
            let key;

            switch (groupBy) {
                case 'hour':
                    key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}`;
                    break;
                case 'day':
                    key = date.toISOString().split('T')[0];
                    break;
                default:
                    key = date.toISOString().split('T')[0];
            }

            if (!acc[key]) {
                acc[key] = { period: key, inbound: 0, outbound: 0, total: 0 };
            }

            acc[key][msg.direction.toLowerCase()]++;
            acc[key].total++;

            return acc;
        }, {});

        return Object.values(grouped).sort((a, b) => a.period.localeCompare(b.period));
    }

    convertToCSV(data, fields) {
        const headers = fields.join(',');
        const rows = data.map(item => {
            return fields.map(field => {
                const value = field.split('.').reduce((obj, key) => obj?.[key], item);
                return `"${String(value || '').replace(/"/g, '""')}"`;
            }).join(',');
        });

        return [headers, ...rows].join('\n');
    }
}

module.exports = {
    analyticsService: new AnalyticsService()
};