const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { PrismaClient } = require('@prisma/client');
const { getSocketIO } = require('./socket');
const logger = require('../utils/logger');
const { processIncomingMessage } = require('./messageProcessor');

const prisma = new PrismaClient();
const whatsappClients = new Map();

class WhatsAppService {
    constructor() {
        this.clients = whatsappClients;
    }

    async initializeAccount(companyId, whatsappAccountId) {
        try {
            const account = await prisma.whatsAppAccount.findUnique({
                where: { id: whatsappAccountId },
                include: { company: true }
            });

            if (!account) {
                throw new Error('WhatsApp account not found');
            }

            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: `${companyId}_${whatsappAccountId}`,
                    dataPath: './sessions'
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu'
                    ]
                }
            });

            this.setupClientEvents(client, account);

            // Armazenar cliente no Map
            this.clients.set(whatsappAccountId, client);

            // Inicializar cliente
            await client.initialize();

            return client;
        } catch (error) {
            logger.error('Error initializing WhatsApp account:', error);
            throw error;
        }
    }

    setupClientEvents(client, account) {
        const io = getSocketIO();

        // QR Code para conexão
        client.on('qr', async (qr) => {
            try {
                const qrCodeData = await QRCode.toDataURL(qr);

                await prisma.whatsAppAccount.update({
                    where: { id: account.id },
                    data: {
                        qrCode: qrCodeData,
                        status: 'CONNECTING'
                    }
                });

                io.to(`company_${account.companyId}`).emit('whatsapp:qr', {
                    accountId: account.id,
                    qrCode: qrCodeData
                });

                logger.info(`QR Code generated for account ${account.id}`);
            } catch (error) {
                logger.error('Error handling QR code:', error);
            }
        });

        // Cliente pronto
        client.on('ready', async () => {
            try {
                const clientInfo = client.info;

                await prisma.whatsAppAccount.update({
                    where: { id: account.id },
                    data: {
                        status: 'CONNECTED',
                        phone: clientInfo.wid.user,
                        qrCode: null
                    }
                });

                io.to(`company_${account.companyId}`).emit('whatsapp:connected', {
                    accountId: account.id,
                    phone: clientInfo.wid.user,
                    name: clientInfo.pushname
                });

                logger.info(`WhatsApp account ${account.id} connected successfully`);
            } catch (error) {
                logger.error('Error handling client ready:', error);
            }
        });

        // Mensagem recebida
        client.on('message', async (message) => {
            try {
                await this.handleIncomingMessage(message, account);
            } catch (error) {
                logger.error('Error handling incoming message:', error);
            }
        });

        // Desconexão
        client.on('disconnected', async (reason) => {
            try {
                await prisma.whatsAppAccount.update({
                    where: { id: account.id },
                    data: { status: 'DISCONNECTED' }
                });

                io.to(`company_${account.companyId}`).emit('whatsapp:disconnected', {
                    accountId: account.id,
                    reason
                });

                this.clients.delete(account.id);
                logger.warn(`WhatsApp account ${account.id} disconnected: ${reason}`);
            } catch (error) {
                logger.error('Error handling disconnection:', error);
            }
        });

        // Erro de autenticação
        client.on('auth_failure', async (message) => {
            try {
                await prisma.whatsAppAccount.update({
                    where: { id: account.id },
                    data: { status: 'FAILED' }
                });

                io.to(`company_${account.companyId}`).emit('whatsapp:auth_failure', {
                    accountId: account.id,
                    message
                });

                logger.error(`Auth failure for account ${account.id}: ${message}`);
            } catch (error) {
                logger.error('Error handling auth failure:', error);
            }
        });
    }

    async handleIncomingMessage(message, account) {
        try {
            // Ignorar mensagens do próprio bot
            if (message.fromMe) return;

            // Ignorar mensagens de grupos (por enquanto)
            if (message.from.includes('@g.us')) return;

            const phoneNumber = message.from.replace('@c.us', '');

            // Buscar ou criar contato
            let contact = await prisma.contact.findUnique({
                where: { phone: phoneNumber }
            });

            if (!contact) {
                const contactInfo = await message.getContact();
                contact = await prisma.contact.create({
                    data: {
                        phone: phoneNumber,
                        name: contactInfo.pushname || contactInfo.formattedName || phoneNumber
                    }
                });
            }

            // Buscar conversa ativa ou criar nova
            let conversation = await prisma.conversation.findFirst({
                where: {
                    contactId: contact.id,
                    companyId: account.companyId,
                    status: { in: ['OPEN', 'PENDING'] }
                },
                include: {
                    agents: {
                        where: { isActive: true },
                        include: { user: true }
                    }
                }
            });

            if (!conversation) {
                conversation = await prisma.conversation.create({
                    data: {
                        contactId: contact.id,
                        companyId: account.companyId,
                        whatsappId: account.id,
                        status: 'OPEN',
                        channel: 'WHATSAPP'
                    },
                    include: {
                        agents: {
                            where: { isActive: true },
                            include: { user: true }
                        }
                    }
                });
            }

            // Processar conteúdo da mensagem
            let content = message.body;
            let messageType = 'TEXT';
            let mediaUrl = null;
            let mediaType = null;

            if (message.hasMedia) {
                const media = await message.downloadMedia();
                // Aqui você salvaria o arquivo e retornaria a URL
                mediaUrl = await this.saveMediaFile(media, message.type);
                mediaType = message.type;
                messageType = this.getMessageType(message.type);
                content = message.caption || `[${messageType}]`;
            }

            // Salvar mensagem no banco
            const savedMessage = await prisma.message.create({
                data: {
                    content,
                    type: messageType,
                    direction: 'INBOUND',
                    status: 'DELIVERED',
                    mediaUrl,
                    mediaType,
                    conversationId: conversation.id,
                    timestamp: new Date(message.timestamp * 1000)
                }
            });

            // Atualizar timestamp da conversa
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { lastMessageAt: new Date() }
            });

            // Processar com chatbot se necessário
            await processIncomingMessage(savedMessage, conversation, account);

            // Notificar agentes via Socket.IO
            const io = getSocketIO();
            io.to(`company_${account.companyId}`).emit('message:new', {
                message: savedMessage,
                conversation,
                contact
            });

            logger.info(`Message processed for conversation ${conversation.id}`);

        } catch (error) {
            logger.error('Error handling incoming message:', error);
        }
    }

    async sendMessage(whatsappAccountId, phoneNumber, content, mediaUrl = null) {
        try {
            const client = this.clients.get(whatsappAccountId);
            if (!client) {
                throw new Error('WhatsApp client not found or not connected');
            }

            const chatId = `${phoneNumber}@c.us`;
            let message;

            if (mediaUrl) {
                const media = MessageMedia.fromFilePath(mediaUrl);
                message = await client.sendMessage(chatId, media, { caption: content });
            } else {
                message = await client.sendMessage(chatId, content);
            }

            return {
                success: true,
                messageId: message.id._serialized,
                timestamp: message.timestamp
            };

        } catch (error) {
            logger.error('Error sending message:', error);
            throw error;
        }
    }

    async saveMediaFile(media, messageType) {
        // Implementar upload para AWS S3, Google Cloud, etc.
        // Por enquanto, retornar uma URL de placeholder
        return `https://your-cdn.com/media/${Date.now()}.${this.getFileExtension(messageType)}`;
    }

    getMessageType(whatsappType) {
        const typeMap = {
            'image': 'IMAGE',
            'audio': 'AUDIO',
            'video': 'VIDEO',
            'document': 'DOCUMENT',
            'sticker': 'STICKER'
        };
        return typeMap[whatsappType] || 'TEXT';
    }

    getFileExtension(messageType) {
        const extMap = {
            'image': 'jpg',
            'audio': 'ogg',
            'video': 'mp4',
            'document': 'pdf'
        };
        return extMap[messageType] || 'bin';
    }

    async disconnectAccount(whatsappAccountId) {
        try {
            const client = this.clients.get(whatsappAccountId);
            if (client) {
                await client.destroy();
                this.clients.delete(whatsappAccountId);
            }

            await prisma.whatsAppAccount.update({
                where: { id: whatsappAccountId },
                data: { status: 'DISCONNECTED' }
            });

            return { success: true };
        } catch (error) {
            logger.error('Error disconnecting WhatsApp account:', error);
            throw error;
        }
    }

    getAccountStatus(whatsappAccountId) {
        const client = this.clients.get(whatsappAccountId);
        return {
            connected: !!client,
            client: client || null
        };
    }
}

// Exportar instância singleton
const whatsappService = new WhatsAppService();

async function initializeWhatsApp() {
    try {
        // Reconectar contas que estavam conectadas
        const connectedAccounts = await prisma.whatsAppAccount.findMany({
            where: { status: 'CONNECTED' },
            include: { company: true }
        });

        for (const account of connectedAccounts) {
            try {
                await whatsappService.initializeAccount(account.companyId, account.id);
                logger.info(`Reconnected WhatsApp account ${account.id}`);
            } catch (error) {
                logger.error(`Failed to reconnect account ${account.id}:`, error);
            }
        }
    } catch (error) {
        logger.error('Error initializing WhatsApp service:', error);
    }
}

module.exports = {
    whatsappService,
    initializeWhatsApp
};