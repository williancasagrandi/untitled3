// src/services/omnichannelService.js
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { notifyCompany } = require('./socket');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const prisma = new PrismaClient();

class OmnichannelService {
    constructor() {
        this.channels = new Map();
        this.messageQueue = [];
        this.isProcessing = false;

        // Inicializar canais
        this.initializeChannels();
    }

    async initializeChannels() {
        // WhatsApp já implementado
        this.channels.set('WHATSAPP', {
            name: 'WhatsApp',
            status: 'active',
            capabilities: ['text', 'image', 'audio', 'video', 'document'],
            rateLimits: { messages: 1000, per: 'hour' }
        });

        // Instagram Direct
        this.channels.set('INSTAGRAM', {
            name: 'Instagram Direct',
            status: 'active',
            capabilities: ['text', 'image', 'video', 'story'],
            rateLimits: { messages: 200, per: 'hour' }
        });

        // Telegram
        this.channels.set('TELEGRAM', {
            name: 'Telegram',
            status: 'active',
            capabilities: ['text', 'image', 'audio', 'video', 'document', 'sticker'],
            rateLimits: { messages: 30, per: 'second' }
        });

        // Facebook Messenger
        this.channels.set('FACEBOOK', {
            name: 'Facebook Messenger',
            status: 'active',
            capabilities: ['text', 'image', 'audio', 'video', 'quick_reply'],
            rateLimits: { messages: 1000, per: 'hour' }
        });

        // SMS
        this.channels.set('SMS', {
            name: 'SMS',
            status: 'active',
            capabilities: ['text'],
            rateLimits: { messages: 100, per: 'hour' }
        });

        // Email
        this.channels.set('EMAIL', {
            name: 'Email',
            status: 'active',
            capabilities: ['text', 'html', 'attachment'],
            rateLimits: { messages: 500, per: 'hour' }
        });

        // Webchat
        this.channels.set('WEBCHAT', {
            name: 'Website Chat',
            status: 'active',
            capabilities: ['text', 'image', 'file'],
            rateLimits: { messages: 1000, per: 'hour' }
        });
    }

    // Processamento unificado de mensagens
    async processIncomingMessage(messageData) {
        try {
            const {
                channel,
                externalId,
                senderId,
                content,
                type,
                mediaUrl,
                timestamp,
                metadata = {}
            } = messageData;

            // Normalizar dados do contato
            const normalizedContact = await this.normalizeContact(senderId, channel, metadata);

            // Buscar ou criar conversa unificada
            const conversation = await this.findOrCreateUnifiedConversation(
                normalizedContact.id,
                channel,
                metadata.companyId
            );

            // Criar mensagem unificada
            const message = await prisma.message.create({
                data: {
                    content,
                    type: type.toUpperCase(),
                    direction: 'INBOUND',
                    status: 'DELIVERED',
                    mediaUrl,
                    conversationId: conversation.id,
                    timestamp: new Date(timestamp),
                    metadata: {
                        channel,
                        externalId,
                        originalSenderId: senderId,
                        ...metadata
                    }
                }
            });

            // Processar com IA se disponível
            await this.processWithAI(message, conversation);

            // Notificar agentes
            await notifyCompany(metadata.companyId, 'message:new', {
                message,
                conversation,
                contact: normalizedContact,
                channel
            });

            return { success: true, messageId: message.id };

        } catch (error) {
            logger.error('Error processing omnichannel message:', error);
            return { success: false, error: error.message };
        }
    }

    // Instagram Direct Integration
    async setupInstagramWebhook(companyId, accessToken, pageId) {
        try {
            const webhookUrl = `${process.env.API_URL}/api/webhooks/instagram`;

            // Configurar webhook do Instagram
            const response = await axios.post(
                `https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`,
                {
                    subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries'
                },
                {
                    headers: { Authorization: `Bearer ${accessToken}` }
                }
            );

            // Salvar configuração
            await prisma.channelIntegration.upsert({
                where: {
                    companyId_channel: { companyId, channel: 'INSTAGRAM' }
                },
                update: {
                    accessToken,
                    pageId,
                    webhookUrl,
                    isActive: true,
                    config: { pageId, accessToken }
                },
                create: {
                    companyId,
                    channel: 'INSTAGRAM',
                    accessToken,
                    pageId,
                    webhookUrl,
                    isActive: true,
                    config: { pageId, accessToken }
                }
            });

            return { success: true, webhookUrl };

        } catch (error) {
            logger.error('Instagram webhook setup error:', error);
            throw error;
        }
    }

    async sendInstagramMessage(recipientId, message, accessToken) {
        try {
            const response = await axios.post(
                'https://graph.facebook.com/v18.0/me/messages',
                {
                    recipient: { id: recipientId },
                    message: {
                        text: message.content,
                        ...(message.quickReplies && {
                            quick_replies: message.quickReplies.map(reply => ({
                                content_type: 'text',
                                title: reply,
                                payload: reply
                            }))
                        })
                    }
                },
                {
                    headers: { Authorization: `Bearer ${accessToken}` }
                }
            );

            return { success: true, messageId: response.data.message_id };

        } catch (error) {
            logger.error('Instagram send error:', error);
            throw error;
        }
    }

    // Telegram Integration
    async setupTelegramBot(companyId, botToken) {
        try {
            const webhookUrl = `${process.env.API_URL}/api/webhooks/telegram`;

            // Configurar webhook do Telegram
            await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, {
                url: webhookUrl,
                allowed_updates: ['message', 'callback_query']
            });

            // Salvar configuração
            await prisma.channelIntegration.upsert({
                where: {
                    companyId_channel: { companyId, channel: 'TELEGRAM' }
                },
                update: {
                    accessToken: botToken,
                    webhookUrl,
                    isActive: true,
                    config: { botToken }
                },
                create: {
                    companyId,
                    channel: 'TELEGRAM',
                    accessToken: botToken,
                    webhookUrl,
                    isActive: true,
                    config: { botToken }
                }
            });

            return { success: true, webhookUrl };

        } catch (error) {
            logger.error('Telegram setup error:', error);
            throw error;
        }
    }

    async sendTelegramMessage(chatId, message, botToken) {
        try {
            const payload = {
                chat_id: chatId,
                text: message.content,
                parse_mode: 'HTML'
            };

            if (message.keyboard) {
                payload.reply_markup = {
                    inline_keyboard: message.keyboard.map(row =>
                        row.map(button => ({
                            text: button.text,
                            callback_data: button.callback_data
                        }))
                    )
                };
            }

            const response = await axios.post(
                `https://api.telegram.org/bot${botToken}/sendMessage`,
                payload
            );

            return { success: true, messageId: response.data.result.message_id };

        } catch (error) {
            logger.error('Telegram send error:', error);
            throw error;
        }
    }

    // Facebook Messenger Integration
    async setupFacebookMessenger(companyId, pageAccessToken, pageId) {
        try {
            const webhookUrl = `${process.env.API_URL}/api/webhooks/facebook`;

            // Configurar webhook
            await axios.post(
                `https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`,
                {
                    subscribed_fields: 'messages,messaging_postbacks,messaging_optins'
                },
                {
                    headers: { Authorization: `Bearer ${pageAccessToken}` }
                }
            );

            await prisma.channelIntegration.upsert({
                where: {
                    companyId_channel: { companyId, channel: 'FACEBOOK' }
                },
                update: {
                    accessToken: pageAccessToken,
                    pageId,
                    webhookUrl,
                    isActive: true,
                    config: { pageId, pageAccessToken }
                },
                create: {
                    companyId,
                    channel: 'FACEBOOK',
                    accessToken: pageAccessToken,
                    pageId,
                    webhookUrl,
                    isActive: true,
                    config: { pageId, pageAccessToken }
                }
            });

            return { success: true };

        } catch (error) {
            logger.error('Facebook Messenger setup error:', error);
            throw error;
        }
    }

    async sendFacebookMessage(recipientId, message, pageAccessToken) {
        try {
            const payload = {
                recipient: { id: recipientId },
                message: { text: message.content }
            };

            if (message.quickReplies) {
                payload.message.quick_replies = message.quickReplies.map(reply => ({
                    content_type: 'text',
                    title: reply,
                    payload: reply
                }));
            }

            const response = await axios.post(
                'https://graph.facebook.com/v18.0/me/messages',
                payload,
                {
                    headers: { Authorization: `Bearer ${pageAccessToken}` }
                }
            );

            return { success: true, messageId: response.data.message_id };

        } catch (error) {
            logger.error('Facebook send error:', error);
            throw error;
        }
    }

    // SMS Integration (Twilio)
    async setupSMS(companyId, accountSid, authToken, phoneNumber) {
        try {
            const client = twilio(accountSid, authToken);

            // Configurar webhook
            const webhookUrl = `${process.env.API_URL}/api/webhooks/sms`;

            await client.incomingPhoneNumbers
                .list({ phoneNumber })
                .then(phoneNumbers => {
                    if (phoneNumbers.length > 0) {
                        return client.incomingPhoneNumbers(phoneNumbers[0].sid)
                            .update({
                                smsUrl: webhookUrl,
                                smsMethod: 'POST'
                            });
                    }
                });

            await prisma.channelIntegration.upsert({
                where: {
                    companyId_channel: { companyId, channel: 'SMS' }
                },
                update: {
                    accessToken: authToken,
                    phoneNumber,
                    webhookUrl,
                    isActive: true,
                    config: { accountSid, authToken, phoneNumber }
                },
                create: {
                    companyId,
                    channel: 'SMS',
                    accessToken: authToken,
                    phoneNumber,
                    webhookUrl,
                    isActive: true,
                    config: { accountSid, authToken, phoneNumber }
                }
            });

            return { success: true };

        } catch (error) {
            logger.error('SMS setup error:', error);
            throw error;
        }
    }

    async sendSMS(toNumber, message, config) {
        try {
            const client = twilio(config.accountSid, config.authToken);

            const response = await client.messages.create({
                body: message.content,
                from: config.phoneNumber,
                to: toNumber
            });

            return { success: true, messageId: response.sid };

        } catch (error) {
            logger.error('SMS send error:', error);
            throw error;
        }
    }

    // Email Integration
    async setupEmail(companyId, emailConfig) {
        try {
            const { provider, host, port, secure, user, password } = emailConfig;

            // Testar conexão
            const transporter = nodemailer.createTransporter({
                host,
                port,
                secure,
                auth: { user, pass: password }
            });

            await transporter.verify();

            await prisma.channelIntegration.upsert({
                where: {
                    companyId_channel: { companyId, channel: 'EMAIL' }
                },
                update: {
                    accessToken: password,
                    email: user,
                    isActive: true,
                    config: emailConfig
                },
                create: {
                    companyId,
                    channel: 'EMAIL',
                    accessToken: password,
                    email: user,
                    isActive: true,
                    config: emailConfig
                }
            });

            return { success: true };

        } catch (error) {
            logger.error('Email setup error:', error);
            throw error;
        }
    }

    async sendEmail(toEmail, message, config) {
        try {
            const transporter = nodemailer.createTransporter({
                host: config.host,
                port: config.port,
                secure: config.secure,
                auth: {
                    user: config.user,
                    pass: config.password
                }
            });

            const mailOptions = {
                from: config.user,
                to: toEmail,
                subject: message.subject || 'Mensagem da equipe de atendimento',
                text: message.content,
                html: message.html || message.content
            };

            if (message.attachments) {
                mailOptions.attachments = message.attachments;
            }

            const response = await transporter.sendMail(mailOptions);

            return { success: true, messageId: response.messageId };

        } catch (error) {
            logger.error('Email send error:', error);
            throw error;
        }
    }

    // Webchat Integration
    async initializeWebchat(companyId, websiteUrl, customization = {}) {
        try {
            const webchatConfig = {
                widgetId: `chatflow_${companyId}_${Date.now()}`,
                websiteUrl,
                customization: {
                    primaryColor: customization.primaryColor || '#3B82F6',
                    position: customization.position || 'bottom-right',
                    greeting: customization.greeting || 'Olá! Como podemos ajudar?',
                    avatar: customization.avatar || null,
                    showOnPages: customization.showOnPages || 'all',
                    ...customization
                }
            };

            await prisma.channelIntegration.upsert({
                where: {
                    companyId_channel: { companyId, channel: 'WEBCHAT' }
                },
                update: {
                    widgetId: webchatConfig.widgetId,
                    webhookUrl: websiteUrl,
                    isActive: true,
                    config: webchatConfig
                },
                create: {
                    companyId,
                    channel: 'WEBCHAT',
                    widgetId: webchatConfig.widgetId,
                    webhookUrl: websiteUrl,
                    isActive: true,
                    config: webchatConfig
                }
            });

            // Gerar código do widget
            const widgetCode = this.generateWebchatWidget(webchatConfig);

            return {
                success: true,
                widgetId: webchatConfig.widgetId,
                widgetCode
            };

        } catch (error) {
            logger.error('Webchat setup error:', error);
            throw error;
        }
    }

    generateWebchatWidget(config) {
        return `
<!-- ChatFlow Widget -->
<script>
  (function() {
    window.ChatFlowConfig = ${JSON.stringify(config)};
    var script = document.createElement('script');
    script.src = '${process.env.API_URL}/widget/chatflow-widget.js';
    script.async = true;
    document.head.appendChild(script);
  })();
</script>
<!-- End ChatFlow Widget -->
    `;
    }

    // Unificação de contatos
    async normalizeContact(externalId, channel, metadata = {}) {
        try {
            // Buscar contato existente por ID externo
            let contact = await prisma.contact.findFirst({
                where: {
                    OR: [
                        { externalIds: { path: [channel], equals: externalId } },
                        { phone: this.extractPhoneFromExternalId(externalId, channel) },
                        { email: this.extractEmailFromExternalId(externalId, channel) }
                    ]
                }
            });

            if (!contact) {
                // Criar novo contato unificado
                const contactData = {
                    name: metadata.name || this.generateNameFromChannel(externalId, channel),
                    phone: this.extractPhoneFromExternalId(externalId, channel),
                    email: this.extractEmailFromExternalId(externalId, channel),
                    avatar: metadata.avatar || null,
                    externalIds: { [channel]: externalId },
                    metadata: {
                        channels: [channel],
                        firstContact: new Date(),
                        ...metadata
                    }
                };

                contact = await prisma.contact.create({ data: contactData });
            } else {
                // Atualizar IDs externos se necessário
                const updatedExternalIds = {
                    ...contact.externalIds,
                    [channel]: externalId
                };

                const updatedChannels = contact.metadata?.channels || [];
                if (!updatedChannels.includes(channel)) {
                    updatedChannels.push(channel);
                }

                await prisma.contact.update({
                    where: { id: contact.id },
                    data: {
                        externalIds: updatedExternalIds,
                        metadata: {
                            ...contact.metadata,
                            channels: updatedChannels,
                            lastContact: new Date()
                        }
                    }
                });
            }

            return contact;

        } catch (error) {
            logger.error('Error normalizing contact:', error);
            throw error;
        }
    }

    // Encontrar ou criar conversa unificada
    async findOrCreateUnifiedConversation(contactId, channel, companyId) {
        try {
            // Procurar conversa ativa existente
            let conversation = await prisma.conversation.findFirst({
                where: {
                    contactId,
                    companyId,
                    status: { in: ['OPEN', 'PENDING'] }
                }
            });

            if (!conversation) {
                // Criar nova conversa
                conversation = await prisma.conversation.create({
                    data: {
                        contactId,
                        companyId,
                        channel,
                        status: 'OPEN',
                        metadata: {
                            channels: [channel],
                            unified: true,
                            createdVia: channel
                        }
                    }
                });
            } else {
                // Adicionar canal se não existir
                const channels = conversation.metadata?.channels || [];
                if (!channels.includes(channel)) {
                    channels.push(channel);

                    await prisma.conversation.update({
                        where: { id: conversation.id },
                        data: {
                            metadata: {
                                ...conversation.metadata,
                                channels,
                                lastChannel: channel
                            }
                        }
                    });
                }
            }

            return conversation;

        } catch (error) {
            logger.error('Error finding/creating unified conversation:', error);
            throw error;
        }
    }

    // Envio unificado de mensagens
    async sendUnifiedMessage(conversationId, messageContent, userId) {
        try {
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId },
                include: {
                    contact: true,
                    company: {
                        include: {
                            channelIntegrations: true
                        }
                    }
                }
            });

            if (!conversation) {
                throw new Error('Conversation not found');
            }

            // Determinar canal preferencial
            const preferredChannel = this.determinePreferredChannel(conversation);
            const integration = conversation.company.channelIntegrations.find(
                ci => ci.channel === preferredChannel && ci.isActive
            );

            if (!integration) {
                throw new Error(`No active integration for channel ${preferredChannel}`);
            }

            // Enviar mensagem pelo canal apropriado
            let sendResult;
            const externalId = conversation.contact.externalIds[preferredChannel];

            switch (preferredChannel) {
                case 'WHATSAPP':
                    sendResult = await this.sendWhatsAppMessage(externalId, messageContent);
                    break;
                case 'INSTAGRAM':
                    sendResult = await this.sendInstagramMessage(externalId, messageContent, integration.accessToken);
                    break;
                case 'TELEGRAM':
                    sendResult = await this.sendTelegramMessage(externalId, messageContent, integration.accessToken);
                    break;
                case 'FACEBOOK':
                    sendResult = await this.sendFacebookMessage(externalId, messageContent, integration.accessToken);
                    break;
                case 'SMS':
                    sendResult = await this.sendSMS(externalId, messageContent, integration.config);
                    break;
                case 'EMAIL':
                    sendResult = await this.sendEmail(externalId, messageContent, integration.config);
                    break;
                default:
                    throw new Error(`Unsupported channel: ${preferredChannel}`);
            }

            // Salvar mensagem no banco
            const message = await prisma.message.create({
                data: {
                    content: messageContent.content,
                    type: messageContent.type || 'TEXT',
                    direction: 'OUTBOUND',
                    status: sendResult.success ? 'DELIVERED' : 'FAILED',
                    conversationId,
                    userId,
                    metadata: {
                        channel: preferredChannel,
                        externalMessageId: sendResult.messageId,
                        unified: true
                    }
                }
            });

            return { success: true, message, channel: preferredChannel };

        } catch (error) {
            logger.error('Error sending unified message:', error);
            throw error;
        }
    }

    // Métodos auxiliares
    determinePreferredChannel(conversation) {
        const channels = conversation.metadata?.channels || [conversation.channel];
        const lastChannel = conversation.metadata?.lastChannel;

        // Preferir o último canal usado
        if (lastChannel && channels.includes(lastChannel)) {
            return lastChannel;
        }

        // Ordem de prioridade padrão
        const priority = ['WHATSAPP', 'TELEGRAM', 'INSTAGRAM', 'FACEBOOK', 'SMS', 'EMAIL', 'WEBCHAT'];

        for (const channel of priority) {
            if (channels.includes(channel)) {
                return channel;
            }
        }

        return channels[0] || 'WHATSAPP';
    }

    extractPhoneFromExternalId(externalId, channel) {
        if (channel === 'WHATSAPP' || channel === 'SMS') {
            return externalId.replace(/[^\d]/g, '');
        }
        return null;
    }

    extractEmailFromExternalId(externalId, channel) {
        if (channel === 'EMAIL') {
            return externalId;
        }
        return null;
    }

    generateNameFromChannel(externalId, channel) {
        switch (channel) {
            case 'WHATSAPP':
            case 'SMS':
                return `Cliente ${externalId.slice(-4)}`;
            case 'EMAIL':
                return externalId.split('@')[0];
            case 'INSTAGRAM':
                return `@${externalId}`;
            case 'TELEGRAM':
                return `Telegram ${externalId}`;
            case 'FACEBOOK':
                return `FB ${externalId.slice(-6)}`;
            default:
                return `Cliente ${externalId.slice(-4)}`;
        }
    }

    // Estatísticas por canal
    async getChannelStats(companyId, dateRange = 30) {
        try {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - dateRange);

            const stats = await prisma.message.groupBy({
                by: ['metadata'],
                where: {
                    conversation: { companyId },
                    timestamp: { gte: startDate },
                    metadata: { path: ['channel'], not: null }
                },
                _count: { id: true },
                _sum: { id: 1 }
            });

            const channelStats = {};

            for (const stat of stats) {
                const channel = stat.metadata?.channel;
                if (channel) {
                    if (!channelStats[channel]) {
                        channelStats[channel] = {
                            name: this.channels.get(channel)?.name || channel,
                            messages: 0,
                            conversations: 0
                        };
                    }
                    channelStats[channel].messages += stat._count.id;
                }
            }

            // Adicionar conversas por canal
            const conversationStats = await prisma.conversation.groupBy({
                by: ['metadata'],
                where: {
                    companyId,
                    createdAt: { gte: startDate }
                },
                _count: { id: true }
            });

            for (const stat of conversationStats) {
                const channels = stat.metadata?.channels || [];
                for (const channel of channels) {
                    if (channelStats[channel]) {
                        channelStats[channel].conversations += stat._count.id;
                    }
                }
            }

            return channelStats;

        } catch (error) {
            logger.error('Error getting channel stats:', error);
            return {};
        }
    }
}

module.exports = { OmnichannelService };