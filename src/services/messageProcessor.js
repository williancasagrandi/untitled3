// src/services/messageProcessor.js (continuação)
const { PrismaClient } = require('@prisma/client');
const OpenAI = require('openai');
const { whatsappService } = require('./whatsapp');
const { notifyCompany } = require('./socket');
const logger = require('../utils/logger');
const { isBusinessHours } = require('../utils/helpers');

const prisma = new PrismaClient();
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

class MessageProcessor {
    constructor() {
        this.processingQueue = new Map();
    }

    async processIncomingMessage(message, conversation, whatsappAccount) {
        try {
            if (this.processingQueue.has(conversation.id)) {
                return;
            }
            this.processingQueue.set(conversation.id, true);

            const shouldUseBot = await this.shouldUseChatbot(conversation, message);

            if (shouldUseBot) {
                await this.processChatbotResponse(message, conversation, whatsappAccount);
            } else {
                await this.assignToAgent(conversation);
            }

        } catch (error) {
            logger.error('Error processing message:', error);
        } finally {
            this.processingQueue.delete(conversation.id);
        }
    }

    async shouldUseChatbot(conversation, message) {
        try {
            const onlineAgents = await prisma.user.findMany({
                where: {
                    companyId: conversation.companyId,
                    isOnline: true,
                    role: { in: ['AGENT', 'MANAGER', 'ADMIN'] },
                    status: 'ACTIVE'
                }
            });

            const company = await prisma.company.findUnique({
                where: { id: conversation.companyId },
                include: {
                    chatbots: {
                        where: { isActive: true }
                    }
                }
            });

            const hasActiveChatbot = company.chatbots.length > 0;
            const isUnassigned = !await this.isConversationAssigned(conversation.id);

            return hasActiveChatbot && (
                onlineAgents.length === 0 ||
                !isBusinessHours() ||
                isUnassigned
            );

        } catch (error) {
            logger.error('Error checking chatbot conditions:', error);
            return false;
        }
    }

    async processChatbotResponse(message, conversation, whatsappAccount) {
        try {
            const recentMessages = await prisma.message.findMany({
                where: { conversationId: conversation.id },
                orderBy: { timestamp: 'desc' },
                take: 10,
                include: { user: true }
            });

            const chatbot = await prisma.chatbot.findFirst({
                where: {
                    companyId: conversation.companyId,
                    isActive: true
                }
            });

            if (!chatbot) {
                await this.assignToAgent(conversation);
                return;
            }

            const context = this.buildAIContext(conversation, recentMessages, chatbot);
            const aiResponse = await this.generateAIResponse(message.content, context);

            if (aiResponse.shouldTransferToAgent) {
                await this.assignToAgent(conversation);
                return;
            }

            await this.sendBotMessage(
                conversation,
                aiResponse.message,
                whatsappAccount.id
            );

            if (aiResponse.actions) {
                await this.executeActions(aiResponse.actions, conversation);
            }

        } catch (error) {
            logger.error('Error processing chatbot response:', error);
            await this.assignToAgent(conversation);
        }
    }

    buildAIContext(conversation, recentMessages, chatbot) {
        const contact = conversation.contact;
        const messageHistory = recentMessages
            .reverse()
            .map(msg => `${msg.direction === 'INBOUND' ? 'Cliente' : 'Bot'}: ${msg.content}`)
            .join('\n');

        return {
            companyName: conversation.company?.name || 'Nossa empresa',
            clientName: contact.name || 'Cliente',
            clientPhone: contact.phone,
            conversationHistory: messageHistory,
            botConfig: chatbot.config,
            currentTime: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        };
    }

    async generateAIResponse(userMessage, context) {
        try {
            const prompt = this.buildPrompt(userMessage, context);

            const completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content: prompt
                    },
                    {
                        role: "user",
                        content: userMessage
                    }
                ],
                max_tokens: 500,
                temperature: 0.7,
            });

            const response = completion.choices[0].message.content;

            // Verificar se deve transferir para agente
            const shouldTransferToAgent = this.shouldTransferToAgent(response, userMessage);

            return {
                message: response,
                shouldTransferToAgent,
                actions: this.extractActions(response)
            };

        } catch (error) {
            logger.error('Error generating AI response:', error);
            return {
                message: 'Desculpe, estou com dificuldades técnicas. Vou transferir você para um de nossos atendentes.',
                shouldTransferToAgent: true
            };
        }
    }

    buildPrompt(userMessage, context) {
        return `
Você é um assistente virtual da empresa ${context.companyName}.

Contexto do cliente:
- Nome: ${context.clientName}
- Telefone: ${context.clientPhone}
- Horário atual: ${context.currentTime}

Histórico da conversa:
${context.conversationHistory}

Instruções:
1. Seja educado, prestativo e profissional
2. Responda de forma concisa e clara
3. Use o nome do cliente quando possível
4. Se não souber responder algo específico, ofereça transferir para um atendente
5. Mantenha o tom da empresa
6. Se detectar urgência ou problema complexo, transfira para atendente

Configurações específicas:
${JSON.stringify(context.botConfig, null, 2)}

Responda à mensagem do cliente de forma natural e útil.
        `;
    }

    shouldTransferToAgent(response, userMessage) {
        const transferKeywords = [
            'transferir',
            'atendente',
            'humano',
            'supervisor',
            'gerente',
            'reclamação',
            'urgente',
            'problema grave'
        ];

        const responseText = response.toLowerCase();
        const userText = userMessage.toLowerCase();

        return transferKeywords.some(keyword =>
            responseText.includes(keyword) || userText.includes(keyword)
        );
    }

    extractActions(response) {
        // Extrair ações do texto da resposta (implementar conforme necessário)
        const actions = [];

        if (response.includes('[AGENDAR]')) {
            actions.push({ type: 'schedule', data: {} });
        }

        if (response.includes('[COTACAO]')) {
            actions.push({ type: 'quote', data: {} });
        }

        return actions.length > 0 ? actions : null;
    }

    async isConversationAssigned(conversationId) {
        const assignment = await prisma.conversationAgent.findFirst({
            where: {
                conversationId,
                isActive: true
            }
        });
        return !!assignment;
    }

    async assignToAgent(conversation) {
        try {
            // Buscar agente disponível
            const availableAgent = await this.findAvailableAgent(conversation.companyId);

            if (availableAgent) {
                await prisma.conversationAgent.create({
                    data: {
                        userId: availableAgent.id,
                        conversationId: conversation.id,
                        isActive: true
                    }
                });

                await prisma.conversation.update({
                    where: { id: conversation.id },
                    data: { status: 'OPEN' }
                });

                // Notificar agente
                await notifyCompany(conversation.companyId, 'conversation:assigned', {
                    conversationId: conversation.id,
                    agentId: availableAgent.id
                });
            } else {
                // Marcar como pendente se não há agentes disponíveis
                await prisma.conversation.update({
                    where: { id: conversation.id },
                    data: { status: 'PENDING' }
                });

                await notifyCompany(conversation.companyId, 'conversation:pending', {
                    conversationId: conversation.id
                });
            }

        } catch (error) {
            logger.error('Error assigning to agent:', error);
        }
    }

    async findAvailableAgent(companyId) {
        // Buscar agente com menos conversas ativas
        const agents = await prisma.user.findMany({
            where: {
                companyId,
                isOnline: true,
                status: 'ACTIVE',
                role: { in: ['AGENT', 'MANAGER'] }
            },
            include: {
                agents: {
                    where: { isActive: true },
                    include: {
                        conversation: {
                            where: { status: { in: ['OPEN', 'PENDING'] } }
                        }
                    }
                }
            }
        });

        if (agents.length === 0) return null;

        // Retornar agente com menos conversas
        return agents.reduce((prev, current) =>
            prev.agents.length < current.agents.length ? prev : current
        );
    }

    async sendBotMessage(conversation, content, whatsappAccountId) {
        try {
            // Salvar mensagem no banco
            const message = await prisma.message.create({
                data: {
                    content,
                    type: 'TEXT',
                    direction: 'OUTBOUND',
                    status: 'SENT',
                    conversationId: conversation.id,
                    metadata: { source: 'chatbot' }
                }
            });

            // Enviar via WhatsApp
            const { whatsappService } = require('./whatsapp');
            await whatsappService.sendMessage(
                whatsappAccountId,
                conversation.contact.phone,
                content
            );

            // Notificar através do socket
            await notifyCompany(conversation.companyId, 'message:new', {
                conversationId: conversation.id,
                message
            });

        } catch (error) {
            logger.error('Error sending bot message:', error);
        }
    }

    async executeActions(actions, conversation) {
        for (const action of actions) {
            try {
                switch (action.type) {
                    case 'schedule':
                        await this.scheduleAppointment(action.data, conversation);
                        break;
                    case 'quote':
                        await this.generateQuote(action.data, conversation);
                        break;
                    default:
                        logger.warn(`Unknown action type: ${action.type}`);
                }
            } catch (error) {
                logger.error(`Error executing action ${action.type}:`, error);
            }
        }
    }

    async scheduleAppointment(data, conversation) {
        // Implementar agendamento
        logger.info('Scheduling appointment', { data, conversationId: conversation.id });
    }

    async generateQuote(data, conversation) {
        // Implementar geração de cotação
        logger.info('Generating quote', { data, conversationId: conversation.id });
    }
}

module.exports = new MessageProcessor();