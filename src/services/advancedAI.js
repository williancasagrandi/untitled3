// src/services/advancedAI.js
const OpenAI = require('openai');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const prisma = new PrismaClient();

class AdvancedAIService {
    constructor() {
        this.sentimentCache = new Map();
        this.intentCache = new Map();
        this.responseTemplates = new Map();
    }

    // Análise de Sentimento em Tempo Real
    async analyzeSentiment(text, conversationId) {
        try {
            const cacheKey = `${conversationId}_${text.slice(0, 50)}`;

            if (this.sentimentCache.has(cacheKey)) {
                return this.sentimentCache.get(cacheKey);
            }

            const completion = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: `Analise o sentimento da mensagem em português brasileiro.
            Retorne JSON com:
            {
              "sentiment": "positive|negative|neutral",
              "confidence": 0-1,
              "emotions": ["joy", "anger", "sadness", "fear", "surprise"],
              "urgency": "low|medium|high",
              "intent": "complaint|question|praise|request|other",
              "keywords": ["palavra1", "palavra2"],
              "suggested_response": "resposta sugerida",
              "escalate": boolean
            }`
                    },
                    { role: "user", content: text }
                ],
                temperature: 0.3,
                max_tokens: 500
            });

            const analysis = JSON.parse(completion.choices[0].message.content);

            // Cache por 1 hora
            this.sentimentCache.set(cacheKey, analysis);
            setTimeout(() => this.sentimentCache.delete(cacheKey), 3600000);

            // Salvar no banco para analytics
            await this.saveSentimentAnalysis(conversationId, text, analysis);

            return analysis;

        } catch (error) {
            logger.error('Sentiment analysis error:', error);
            return {
                sentiment: 'neutral',
                confidence: 0.5,
                emotions: [],
                urgency: 'medium',
                intent: 'other',
                keywords: [],
                suggested_response: '',
                escalate: false
            };
        }
    }

    // Análise de Imagens com GPT-4 Vision
    async analyzeImage(imageUrl, conversationId, context = '') {
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4-vision-preview",
                messages: [
                    {
                        role: "system",
                        content: `Você é um assistente que analisa imagens enviadas por clientes.
            Descreva o que vê na imagem e sugira uma resposta apropriada.
            Contexto da conversa: ${context}
            
            Retorne JSON:
            {
              "description": "descrição detalhada",
              "objects": ["objeto1", "objeto2"],
              "text_detected": "texto na imagem",
              "category": "product|document|receipt|problem|other",
              "suggested_action": "ação sugerida",
              "suggested_response": "resposta sugerida",
              "requires_human": boolean
            }`
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analise esta imagem:" },
                            { type: "image_url", image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 500
            });

            const analysis = JSON.parse(completion.choices[0].message.content);

            // Salvar análise
            await this.saveImageAnalysis(conversationId, imageUrl, analysis);

            return analysis;

        } catch (error) {
            logger.error('Image analysis error:', error);
            return {
                description: 'Não foi possível analisar a imagem',
                objects: [],
                text_detected: '',
                category: 'other',
                suggested_action: 'Pedir para reenviar ou descrever o problema',
                suggested_response: 'Recebi sua imagem. Pode me descrever o que precisa?',
                requires_human: true
            };
        }
    }

    // Transcrição e Análise de Áudio
    async analyzeAudio(audioUrl, conversationId) {
        try {
            // Primeiro, transcrever o áudio
            const audioResponse = await axios.get(audioUrl, { responseType: 'stream' });

            const transcription = await openai.audio.transcriptions.create({
                file: audioResponse.data,
                model: "whisper-1",
                language: "pt"
            });

            // Depois analisar o texto transcrito
            const textAnalysis = await this.analyzeSentiment(transcription.text, conversationId);

            const audioAnalysis = {
                transcription: transcription.text,
                duration_estimate: Math.ceil(transcription.text.length / 150), // ~150 chars/min
                ...textAnalysis,
                media_type: 'audio'
            };

            await this.saveAudioAnalysis(conversationId, audioUrl, audioAnalysis);

            return audioAnalysis;

        } catch (error) {
            logger.error('Audio analysis error:', error);
            return {
                transcription: 'Não foi possível transcrever o áudio',
                duration_estimate: 0,
                sentiment: 'neutral',
                confidence: 0.3,
                requires_human: true
            };
        }
    }

    // Predição de Intenção Avançada
    async predictCustomerIntent(conversationHistory, currentMessage) {
        try {
            const historyText = conversationHistory
                .slice(-10) // Últimas 10 mensagens
                .map(msg => `${msg.direction}: ${msg.content}`)
                .join('\n');

            const completion = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: `Analise o histórico da conversa e a mensagem atual para prever a intenção do cliente.
            
            Retorne JSON:
            {
              "primary_intent": "purchase|support|complaint|inquiry|cancellation|compliment",
              "secondary_intents": ["intent1", "intent2"],
              "confidence": 0-1,
              "customer_journey_stage": "awareness|consideration|purchase|retention|advocacy",
              "likelihood_to_buy": 0-1,
              "likelihood_to_churn": 0-1,
              "recommended_actions": ["action1", "action2"],
              "priority_level": "low|medium|high|critical",
              "estimated_resolution_time": "minutes",
              "requires_specialist": boolean,
              "upsell_opportunity": boolean
            }`
                    },
                    {
                        role: "user",
                        content: `Histórico:\n${historyText}\n\nMensagem atual: ${currentMessage}`
                    }
                ],
                temperature: 0.2,
                max_tokens: 400
            });

            return JSON.parse(completion.choices[0].message.content);

        } catch (error) {
            logger.error('Intent prediction error:', error);
            return {
                primary_intent: 'inquiry',
                confidence: 0.5,
                priority_level: 'medium',
                requires_specialist: false
            };
        }
    }

    // Geração de Respostas Contextuais
    async generateContextualResponse(conversationHistory, customerData, companyData) {
        try {
            const customerContext = this.buildCustomerContext(customerData);
            const conversationContext = this.buildConversationContext(conversationHistory);

            const completion = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: `Você é um assistente da ${companyData.name}.
            
            Informações da empresa:
            - Segmento: ${companyData.industry || 'Geral'}
            - Tom de voz: ${companyData.toneOfVoice || 'Profissional e amigável'}
            - Horário comercial: ${companyData.businessHours || '9h-18h'}
            
            Informações do cliente:
            ${customerContext}
            
            Histórico da conversa:
            ${conversationContext}
            
            Regras:
            - Seja natural e humano
            - Use o nome do cliente quando apropriado
            - Mantenha o tom da empresa
            - Seja conciso mas completo
            - Se não souber algo, seja honesto
            - Ofereça próximos passos claros
            
            Gere uma resposta apropriada para a última mensagem do cliente.`
                    },
                    {
                        role: "user",
                        content: "Gere uma resposta contextual e personalizada."
                    }
                ],
                temperature: 0.7,
                max_tokens: 200
            });

            return {
                response: completion.choices[0].message.content,
                confidence: 0.85,
                personalized: true
            };

        } catch (error) {
            logger.error('Contextual response error:', error);
            return {
                response: 'Obrigado pela sua mensagem. Nossa equipe irá analisá-la e retornar em breve.',
                confidence: 0.3,
                personalized: false
            };
        }
    }

    // Auto-Learning do Chatbot
    async learnFromInteraction(conversationId, userMessage, botResponse, userFeedback) {
        try {
            const learningData = {
                conversationId,
                userMessage,
                botResponse,
                feedback: userFeedback, // 'positive', 'negative', 'neutral'
                timestamp: new Date(),
                context: await this.getConversationContext(conversationId)
            };

            // Salvar para treinamento futuro
            await prisma.aILearningData.create({
                data: {
                    conversationId,
                    userInput: userMessage,
                    botOutput: botResponse,
                    feedback: userFeedback,
                    context: learningData.context,
                    sentiment: await this.analyzeSentiment(userMessage, conversationId)
                }
            });

            // Se feedback negativo, marcar para revisão humana
            if (userFeedback === 'negative') {
                await this.flagForHumanReview(conversationId, userMessage, botResponse);
            }

            // Atualizar templates de resposta baseado no feedback
            if (userFeedback === 'positive') {
                await this.updateResponseTemplates(userMessage, botResponse);
            }

        } catch (error) {
            logger.error('Learning from interaction error:', error);
        }
    }

    // Detecção de Anomalias na Conversa
    async detectConversationAnomalies(conversationId, messages) {
        try {
            const anomalies = [];

            // Verificar mensagens repetitivas
            const messageFreq = {};
            messages.forEach(msg => {
                const content = msg.content.toLowerCase().trim();
                messageFreq[content] = (messageFreq[content] || 0) + 1;
            });

            const repeatedMessages = Object.entries(messageFreq)
                .filter(([content, count]) => count > 3)
                .map(([content]) => content);

            if (repeatedMessages.length > 0) {
                anomalies.push({
                    type: 'repeated_messages',
                    severity: 'medium',
                    description: 'Cliente enviando mensagens repetitivas',
                    data: repeatedMessages
                });
            }

            // Verificar escalação de sentimento
            const sentiments = await Promise.all(
                messages.slice(-5).map(msg => this.analyzeSentiment(msg.content, conversationId))
            );

            const negativeTrend = sentiments.slice(-3).every(s => s.sentiment === 'negative');
            if (negativeTrend) {
                anomalies.push({
                    type: 'negative_sentiment_escalation',
                    severity: 'high',
                    description: 'Sentimento do cliente deteriorando',
                    data: sentiments
                });
            }

            // Verificar tempo de resposta
            const responseTime = this.calculateAverageResponseTime(messages);
            if (responseTime > 600) { // 10 minutos
                anomalies.push({
                    type: 'slow_response_time',
                    severity: 'medium',
                    description: 'Tempo de resposta acima do normal',
                    data: { averageResponseTime: responseTime }
                });
            }

            return anomalies;

        } catch (error) {
            logger.error('Anomaly detection error:', error);
            return [];
        }
    }

    // Sugestões de Melhoria para Agentes
    async generateAgentCoaching(agentId, conversationSample) {
        try {
            const agentStats = await this.getAgentPerformanceStats(agentId);

            const completion = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: `Analise a performance do agente e forneça coaching personalizado.
            
            Estatísticas do agente:
            - Tempo médio de resposta: ${agentStats.avgResponseTime} minutos
            - Taxa de resolução: ${agentStats.resolutionRate}%
            - Satisfação do cliente: ${agentStats.customerSatisfaction}/5
            - Número de transferências: ${agentStats.transfers}
            
            Retorne JSON:
            {
              "strengths": ["força1", "força2"],
              "areas_for_improvement": ["area1", "area2"],
              "specific_feedback": "feedback detalhado",
              "training_recommendations": ["treinamento1", "treinamento2"],
              "best_practices": ["prática1", "prática2"],
              "next_goals": ["meta1", "meta2"]
            }`
                    },
                    {
                        role: "user",
                        content: `Amostra de conversa do agente:\n${conversationSample}`
                    }
                ],
                temperature: 0.4,
                max_tokens: 600
            });

            return JSON.parse(completion.choices[0].message.content);

        } catch (error) {
            logger.error('Agent coaching error:', error);
            return {
                strengths: ['Atendimento cordial'],
                areas_for_improvement: ['Tempo de resposta'],
                specific_feedback: 'Continue o bom trabalho!',
                training_recommendations: [],
                best_practices: [],
                next_goals: []
            };
        }
    }

    // Métodos auxiliares
    buildCustomerContext(customerData) {
        if (!customerData) return 'Cliente novo sem histórico';

        return `
    - Nome: ${customerData.name || 'Não informado'}
    - Primeira compra: ${customerData.firstPurchase || 'Nunca comprou'}
    - Última interação: ${customerData.lastInteraction || 'Primeira vez'}
    - Valor total gasto: ${customerData.totalSpent || 'R$ 0,00'}
    - Nível de fidelidade: ${customerData.loyaltyLevel || 'Novo'}
    - Preferências: ${customerData.preferences || 'Nenhuma registrada'}
    `;
    }

    buildConversationContext(messages) {
        return messages
            .slice(-8)
            .map(msg => `${msg.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${msg.content}`)
            .join('\n');
    }

    async saveSentimentAnalysis(conversationId, text, analysis) {
        try {
            await prisma.sentimentAnalysis.create({
                data: {
                    conversationId,
                    text: text.slice(0, 1000), // Limitar tamanho
                    sentiment: analysis.sentiment,
                    confidence: analysis.confidence,
                    emotions: analysis.emotions,
                    urgency: analysis.urgency,
                    intent: analysis.intent,
                    keywords: analysis.keywords,
                    shouldEscalate: analysis.escalate
                }
            });
        } catch (error) {
            logger.error('Error saving sentiment analysis:', error);
        }
    }

    async saveImageAnalysis(conversationId, imageUrl, analysis) {
        try {
            await prisma.imageAnalysis.create({
                data: {
                    conversationId,
                    imageUrl,
                    description: analysis.description,
                    objects: analysis.objects,
                    textDetected: analysis.text_detected,
                    category: analysis.category,
                    requiresHuman: analysis.requires_human
                }
            });
        } catch (error) {
            logger.error('Error saving image analysis:', error);
        }
    }

    async saveAudioAnalysis(conversationId, audioUrl, analysis) {
        try {
            await prisma.audioAnalysis.create({
                data: {
                    conversationId,
                    audioUrl,
                    transcription: analysis.transcription,
                    durationEstimate: analysis.duration_estimate,
                    sentiment: analysis.sentiment,
                    confidence: analysis.confidence
                }
            });
        } catch (error) {
            logger.error('Error saving audio analysis:', error);
        }
    }

    calculateAverageResponseTime(messages) {
        let totalTime = 0;
        let count = 0;

        for (let i = 1; i < messages.length; i++) {
            const prevMsg = messages[i - 1];
            const currentMsg = messages[i];

            if (prevMsg.direction === 'INBOUND' && currentMsg.direction === 'OUTBOUND') {
                const timeDiff = new Date(currentMsg.timestamp) - new Date(prevMsg.timestamp);
                totalTime += timeDiff;
                count++;
            }
        }

        return count > 0 ? totalTime / count / 1000 / 60 : 0; // em minutos
    }

    async getAgentPerformanceStats(agentId) {
        try {
            const stats = await prisma.user.findUnique({
                where: { id: agentId },
                include: {
                    conversations: {
                        where: {
                            conversation: {
                                createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                            }
                        },
                        include: {
                            conversation: {
                                include: { messages: true }
                            }
                        }
                    }
                }
            });

            // Calcular métricas
            const conversations = stats.conversations.map(ca => ca.conversation);
            const avgResponseTime = this.calculateAverageResponseTime(
                conversations.flatMap(c => c.messages)
            );

            const resolvedCount = conversations.filter(c => c.status === 'CLOSED').length;
            const resolutionRate = conversations.length > 0
                ? Math.round((resolvedCount / conversations.length) * 100)
                : 0;

            const ratings = conversations
                .filter(c => c.rating)
                .map(c => c.rating);

            const customerSatisfaction = ratings.length > 0
                ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(1)
                : 0;

            const transfers = conversations.filter(c =>
                c.agents && c.agents.length > 1
            ).length;

            return {
                avgResponseTime,
                resolutionRate,
                customerSatisfaction,
                transfers,
                totalConversations: conversations.length
            };

        } catch (error) {
            logger.error('Error getting agent stats:', error);
            return {
                avgResponseTime: 5,
                resolutionRate: 80,
                customerSatisfaction: 4.0,
                transfers: 0,
                totalConversations: 0
            };
        }
    }
}

module.exports = { AdvancedAIService };