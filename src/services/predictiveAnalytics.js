// src/services/predictiveAnalytics.js
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

class PredictiveAnalyticsService {
    constructor() {
        this.models = new Map();
        this.predictionCache = new Map();
        this.initializeModels();
    }

    async initializeModels() {
        // Modelos de ML disponíveis
        this.models.set('churn_prediction', {
            name: 'Predição de Churn',
            type: 'classification',
            features: ['last_interaction_days', 'message_frequency', 'sentiment_score', 'resolution_rate', 'response_time'],
            accuracy: 0.87
        });

        this.models.set('sentiment_trends', {
            name: 'Tendências de Sentimento',
            type: 'time_series',
            features: ['sentiment_history', 'interaction_volume', 'resolution_time'],
            accuracy: 0.83
        });

        this.models.set('demand_forecasting', {
            name: 'Previsão de Demanda',
            type: 'regression',
            features: ['historical_volume', 'day_of_week', 'hour_of_day', 'seasonality'],
            accuracy: 0.79
        });

        this.models.set('campaign_optimization', {
            name: 'Otimização de Campanhas',
            type: 'optimization',
            features: ['send_time', 'content_type', 'audience_segment', 'channel'],
            accuracy: 0.91
        });
    }

    // Predição de Churn de Clientes
    async predictCustomerChurn(companyId, contactId = null) {
        try {
            const cacheKey = `churn_${companyId}_${contactId || 'all'}`;

            if (this.predictionCache.has(cacheKey)) {
                return this.predictionCache.get(cacheKey);
            }

            // Buscar dados dos clientes
            const customers = await this.getCustomerFeatures(companyId, contactId);
            const predictions = [];

            for (const customer of customers) {
                const features = this.extractChurnFeatures(customer);
                const churnProbability = await this.calculateChurnProbability(features);

                const prediction = {
                    contactId: customer.id,
                    contactName: customer.name,
                    churnProbability: churnProbability.probability,
                    riskLevel: this.categorizeRisk(churnProbability.probability),
                    factors: churnProbability.factors,
                    recommendedActions: this.getChurnPreventionActions(churnProbability),
                    lastInteraction: customer.lastInteraction,
                    predictionDate: new Date()
                };

                predictions.push(prediction);

                // Salvar predição no banco
                await this.saveChurnPrediction(prediction);
            }

            // Cache por 1 hora
            this.predictionCache.set(cacheKey, predictions);
            setTimeout(() => this.predictionCache.delete(cacheKey), 3600000);

            return predictions;

        } catch (error) {
            logger.error('Churn prediction error:', error);
            return [];
        }
    }

    // Análise de Comportamento do Cliente
    async analyzeCustomerBehavior(companyId, timeframe = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - timeframe);

            // Buscar dados de interação
            const interactions = await prisma.message.findMany({
                where: {
                    conversation: { companyId },
                    timestamp: { gte: startDate }
                },
                include: {
                    conversation: {
                        include: { contact: true }
                    }
                }
            });

            // Agrupar por cliente
            const customerBehavior = new Map();

            for (const interaction of interactions) {
                const contactId = interaction.conversation.contactId;

                if (!customerBehavior.has(contactId)) {
                    customerBehavior.set(contactId, {
                        contact: interaction.conversation.contact,
                        messageCount: 0,
                        avgResponseTime: 0,
                        channels: new Set(),
                        timePattern: {},
                        sentimentHistory: [],
                        topicsDiscussed: [],
                        satisfactionScores: []
                    });
                }

                const behavior = customerBehavior.get(contactId);
                behavior.messageCount++;

                // Padrão temporal
                const hour = interaction.timestamp.getHours();
                behavior.timePattern[hour] = (behavior.timePattern[hour] || 0) + 1;

                // Canal usado
                if (interaction.metadata?.channel) {
                    behavior.channels.add(interaction.metadata.channel);
                }
            }

            // Análise avançada de comportamento
            const behaviorAnalysis = [];

            for (const [contactId, data] of customerBehavior) {
                const analysis = {
                    contactId,
                    contactName: data.contact.name,
                    engagement: this.calculateEngagementScore(data),
                    preferredChannels: Array.from(data.channels),
                    communicationPattern: this.analyzeCommunicationPattern(data.timePattern),
                    behaviorSegment: this.segmentCustomerBehavior(data),
                    lifetimeValue: await this.estimateLifetimeValue(contactId),
                    nextBestAction: this.recommendNextAction(data),
                    personalizedOffers: await this.generatePersonalizedOffers(contactId, data)
                };

                behaviorAnalysis.push(analysis);
            }

            return behaviorAnalysis;

        } catch (error) {
            logger.error('Customer behavior analysis error:', error);
            return [];
        }
    }

    // Otimização Automática de Campanhas
    async optimizeCampaign(campaignId, optimizationGoal = 'conversion') {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                include: { company: true }
            });

            if (!campaign) {
                throw new Error('Campaign not found');
            }

            // Analisar performance histórica de campanhas similares
            const historicalData = await this.getCampaignHistoricalData(campaign.companyId);

            // Segmentar audiência baseado em comportamento
            const audienceSegments = await this.segmentAudience(campaign.recipients);

            // Otimizar timing
            const optimalTiming = await this.optimizeSendTiming(campaign.companyId, audienceSegments);

            // Otimizar conteúdo
            const contentOptimizations = await this.optimizeContent(campaign.content, historicalData);

            // Otimizar canal
            const channelOptimizations = await this.optimizeChannelSelection(audienceSegments);

            const optimization = {
                campaignId,
                originalCampaign: {
                    recipients: campaign.recipients.length,
                    content: campaign.content,
                    scheduledAt: campaign.scheduledAt
                },
                optimizations: {
                    timing: optimalTiming,
                    content: contentOptimizations,
                    channels: channelOptimizations,
                    audience: audienceSegments
                },
                expectedImprovements: {
                    openRate: optimalTiming.expectedOpenRateIncrease,
                    clickRate: contentOptimizations.expectedClickRateIncrease,
                    conversionRate: channelOptimizations.expectedConversionIncrease
                },
                confidence: this.calculateOptimizationConfidence([
                    optimalTiming.confidence,
                    contentOptimizations.confidence,
                    channelOptimizations.confidence
                ])
            };

            // Salvar otimização
            await this.saveCampaignOptimization(optimization);

            return optimization;

        } catch (error) {
            logger.error('Campaign optimization error:', error);
            throw error;
        }
    }

    // Previsão de Demanda de Atendimento
    async forecastDemand(companyId, forecastDays = 7) {
        try {
            // Buscar dados históricos
            const historicalData = await this.getHistoricalDemandData(companyId, 90);

            // Extrair features
            const features = this.extractDemandFeatures(historicalData);

            // Gerar previsões
            const forecasts = [];
            const baseDate = new Date();

            for (let i = 1; i <= forecastDays; i++) {
                const forecastDate = new Date(baseDate);
                forecastDate.setDate(baseDate.getDate() + i);

                const dayFeatures = this.generateDayFeatures(forecastDate, features);
                const prediction = await this.predictDayDemand(dayFeatures);

                // Previsão por hora
                const hourlyForecasts = [];
                for (let hour = 0; hour < 24; hour++) {
                    const hourFeatures = { ...dayFeatures, hour };
                    const hourlyPrediction = await this.predictHourlyDemand(hourFeatures);

                    hourlyForecasts.push({
                        hour,
                        expectedMessages: Math.round(hourlyPrediction.messages),
                        expectedConversations: Math.round(hourlyPrediction.conversations),
                        confidence: hourlyPrediction.confidence
                    });
                }

                forecasts.push({
                    date: forecastDate,
                    dayOfWeek: forecastDate.getDay(),
                    expectedMessages: Math.round(prediction.messages),
                    expectedConversations: Math.round(prediction.conversations),
                    peakHours: this.identifyPeakHours(hourlyForecasts),
                    requiredAgents: this.calculateRequiredAgents(prediction),
                    hourlyBreakdown: hourlyForecasts,
                    confidence: prediction.confidence,
                    factors: prediction.factors
                });
            }

            // Salvar previsões
            await this.saveDemandForecasts(companyId, forecasts);

            return {
                companyId,
                forecastPeriod: forecastDays,
                generatedAt: new Date(),
                forecasts,
                summary: this.generateForecastSummary(forecasts),
                recommendations: this.generateStaffingRecommendations(forecasts)
            };

        } catch (error) {
            logger.error('Demand forecasting error:', error);
            throw error;
        }
    }

    // Análise de Tendências de Sentimento
    async analyzeSentimentTrends(companyId, timeframe = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - timeframe);

            // Buscar análises de sentimento
            const sentimentData = await prisma.sentimentAnalysis.findMany({
                where: {
                    conversation: { companyId },
                    createdAt: { gte: startDate }
                },
                include: {
                    conversation: {
                        include: { contact: true, department: true }
                    }
                }
            });

            // Agrupar por dia
            const dailyTrends = {};
            const departmentTrends = {};
            const topicTrends = {};

            for (const data of sentimentData) {
                const date = data.createdAt.toISOString().split('T')[0];
                const department = data.conversation.department?.name || 'Geral';

                // Tendência diária
                if (!dailyTrends[date]) {
                    dailyTrends[date] = {
                        positive: 0,
                        negative: 0,
                        neutral: 0,
                        total: 0,
                        avgConfidence: 0
                    };
                }

                dailyTrends[date][data.sentiment]++;
                dailyTrends[date].total++;
                dailyTrends[date].avgConfidence += data.confidence;

                // Tendência por departamento
                if (!departmentTrends[department]) {
                    departmentTrends[department] = {
                        positive: 0,
                        negative: 0,
                        neutral: 0,
                        total: 0
                    };
                }

                departmentTrends[department][data.sentiment]++;
                departmentTrends[department].total++;

                // Tendências por tópico
                for (const keyword of data.keywords || []) {
                    if (!topicTrends[keyword]) {
                        topicTrends[keyword] = {
                            positive: 0,
                            negative: 0,
                            neutral: 0,
                            total: 0
                        };
                    }

                    topicTrends[keyword][data.sentiment]++;
                    topicTrends[keyword].total++;
                }
            }

            // Calcular médias e tendências
            Object.keys(dailyTrends).forEach(date => {
                const trend = dailyTrends[date];
                trend.avgConfidence = trend.avgConfidence / trend.total;
                trend.positiveRate = trend.positive / trend.total;
                trend.negativeRate = trend.negative / trend.total;
            });

            // Detectar mudanças significativas
            const alerts = this.detectSentimentAlerts(dailyTrends, departmentTrends);

            // Predizer tendências futuras
            const predictions = await this.predictSentimentTrends(dailyTrends);

            return {
                period: { start: startDate, end: new Date() },
                dailyTrends,
                departmentTrends,
                topicTrends,
                alerts,
                predictions,
                insights: this.generateSentimentInsights(dailyTrends, departmentTrends, topicTrends),
                recommendations: this.generateSentimentRecommendations(alerts, predictions)
            };

        } catch (error) {
            logger.error('Sentiment trends analysis error:', error);
            throw error;
        }
    }

    // Análise de Eficiência de Agentes
    async analyzeAgentEfficiency(companyId, timeframe = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - timeframe);

            const agents = await prisma.user.findMany({
                where: {
                    companyId,
                    role: { in: ['AGENT', 'MANAGER'] }
                },
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

            const efficiencyAnalysis = [];

            for (const agent of agents) {
                const conversations = agent.conversations.map(ca => ca.conversation);

                const metrics = {
                    totalConversations: conversations.length,
                    avgResponseTime: this.calculateAvgResponseTime(conversations),
                    resolutionRate: this.calculateResolutionRate(conversations),
                    customerSatisfaction: this.calculateAvgSatisfaction(conversations),
                    messageThroughput: this.calculateMessageThroughput(conversations),
                    workloadDistribution: this.analyzeWorkloadDistribution(conversations),
                    peakPerformanceTimes: this.identifyPeakPerformanceTimes(conversations),
                    improvementAreas: []
                };

                // Identificar áreas de melhoria
                metrics.improvementAreas = this.identifyImprovementAreas(metrics);

                // Calcular score de eficiência
                metrics.efficiencyScore = this.calculateEfficiencyScore(metrics);

                // Predizer performance futura
                metrics.performancePrediction = await this.predictAgentPerformance(agent.id, metrics);

                // Recomendações personalizadas
                metrics.recommendations = this.generateAgentRecommendations(metrics);

                efficiencyAnalysis.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    metrics,
                    ranking: 0, // Será calculado depois
                    trends: await this.getAgentTrends(agent.id, timeframe)
                });
            }

            // Rankear agentes por eficiência
            efficiencyAnalysis.sort((a, b) => b.metrics.efficiencyScore - a.metrics.efficiencyScore);
            efficiencyAnalysis.forEach((analysis, index) => {
                analysis.ranking = index + 1;
            });

            return {
                companyId,
                period: { start: startDate, end: new Date() },
                agentAnalysis: efficiencyAnalysis,
                teamInsights: this.generateTeamInsights(efficiencyAnalysis),
                recommendations: this.generateTeamRecommendations(efficiencyAnalysis)
            };

        } catch (error) {
            logger.error('Agent efficiency analysis error:', error);
            throw error;
        }
    }

    // ROI de Campanhas em Tempo Real
    async calculateCampaignROI(campaignId, includeProjections = true) {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                include: { company: true }
            });

            if (!campaign) {
                throw new Error('Campaign not found');
            }

            // Calcular custos
            const costs = {
                messageCost: campaign.recipients.total * 0.05, // R$ 0,05 por mensagem
                operationalCost: this.calculateOperationalCost(campaign),
                opportunityCost: 0, // Custo de oportunidade
                totalCost: 0
            };
            costs.totalCost = costs.messageCost + costs.operationalCost + costs.opportunityCost;

            // Rastrear conversões
            const conversions = await this.trackCampaignConversions(campaignId);

            // Calcular receita
            const revenue = {
                directRevenue: conversions.reduce((sum, conv) => sum + conv.value, 0),
                indirectRevenue: await this.calculateIndirectRevenue(campaignId),
                projectedRevenue: 0,
                totalRevenue: 0
            };

            if (includeProjections) {
                revenue.projectedRevenue = await this.projectFutureRevenue(campaignId, conversions);
            }

            revenue.totalRevenue = revenue.directRevenue + revenue.indirectRevenue + revenue.projectedRevenue;

            // Calcular ROI
            const roi = {
                absolute: revenue.totalRevenue - costs.totalCost,
                percentage: costs.totalCost > 0 ? ((revenue.totalRevenue - costs.totalCost) / costs.totalCost) * 100 : 0,
                paybackPeriod: this.calculatePaybackPeriod(costs.totalCost, conversions),
                confidenceLevel: this.calculateROIConfidence(conversions, revenue.projectedRevenue)
            };

            // Comparar com benchmarks
            const benchmarks = await this.getCampaignBenchmarks(campaign.companyId);

            return {
                campaignId,
                campaign: {
                    name: campaign.name,
                    status: campaign.status,
                    sentAt: campaign.sentAt,
                    recipients: campaign.recipients.total
                },
                costs,
                revenue,
                roi,
                benchmarks,
                conversions: conversions.length,
                conversionRate: campaign.recipients.total > 0 ? (conversions.length / campaign.recipients.total) * 100 : 0,
                insights: this.generateROIInsights(roi, benchmarks),
                recommendations: this.generateROIRecommendations(roi, costs, revenue)
            };

        } catch (error) {
            logger.error('Campaign ROI calculation error:', error);
            throw error;
        }
    }

    // Métodos auxiliares para cálculos complexos
    async calculateChurnProbability(features) {
        // Algoritmo simplificado - em produção usaria modelo treinado
        let probability = 0;
        const factors = [];

        // Dias desde última interação (peso: 30%)
        if (features.lastInteractionDays > 30) {
            probability += 0.3;
            factors.push('Sem interação recente');
        }

        // Frequência de mensagens (peso: 25%)
        if (features.messageFrequency < 2) {
            probability += 0.25;
            factors.push('Baixa frequência de mensagens');
        }

        // Score de sentimento (peso: 25%)
        if (features.sentimentScore < 0.4) {
            probability += 0.25;
            factors.push('Sentimento negativo');
        }

        // Taxa de resolução (peso: 20%)
        if (features.resolutionRate < 0.7) {
            probability += 0.2;
            factors.push('Baixa taxa de resolução');
        }

        return {
            probability: Math.min(probability, 1),
            factors,
            confidence: 0.85
        };
    }

    extractChurnFeatures(customer) {
        const now = new Date();
        const lastInteraction = customer.lastInteraction ? new Date(customer.lastInteraction) : now;

        return {
            lastInteractionDays: (now - lastInteraction) / (1000 * 60 * 60 * 24),
            messageFrequency: customer.messageCount || 0,
            sentimentScore: customer.avgSentiment || 0.5,
            resolutionRate: customer.resolutionRate || 0,
            responseTime: customer.avgResponseTime || 0
        };
    }

    categorizeRisk(probability) {
        if (probability > 0.7) return 'HIGH';
        if (probability > 0.4) return 'MEDIUM';
        return 'LOW';
    }

    getChurnPreventionActions(prediction) {
        const actions = [];

        if (prediction.probability > 0.7) {
            actions.push('Contato imediato com gerente de conta');
            actions.push('Oferta personalizada ou desconto');
            actions.push('Pesquisa de satisfação urgente');
        } else if (prediction.probability > 0.4) {
            actions.push('Campanha de reengajamento');
            actions.push('Check-in proativo');
            actions.push('Conteúdo educativo personalizado');
        } else {
            actions.push('Manter engajamento regular');
            actions.push('Newsletter com novidades');
        }

        return actions;
    }

    // Salvar predições no banco para histórico
    async saveChurnPrediction(prediction) {
        try {
            await prisma.churnPrediction.create({
                data: {
                    contactId: prediction.contactId,
                    probability: prediction.churnProbability,
                    riskLevel: prediction.riskLevel,
                    factors: prediction.factors,
                    recommendations: prediction.recommendedActions,
                    predictionDate: prediction.predictionDate
                }
            });
        } catch (error) {
            logger.error('Error saving churn prediction:', error);
        }
    }

    async getCustomerFeatures(companyId, contactId = null) {
        const where = contactId
            ? { id: contactId }
            : { conversations: { some: { companyId } } };

        return await prisma.contact.findMany({
            where,
            include: {
                conversations: {
                    where: { companyId },
                    include: {
                        messages: true
                    }
                }
            }
        });
    }
}

module.exports = { PredictiveAnalyticsService };