// src/services/socket.js (completar)
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
let io = null;

const socketAuth = async (socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            include: { company: true, department: true }
        });

        if (!user || user.status !== 'ACTIVE') {
            return next(new Error('Authentication error: Invalid user'));
        }

        socket.user = user;
        socket.companyId = user.companyId;
        next();
    } catch (error) {
        logger.error('Socket authentication error:', error);
        next(new Error('Authentication error'));
    }
};

class PresenceManager {
    constructor() {
        this.userSockets = new Map();
        this.socketUsers = new Map();
    }

    addUser(userId, socketId) {
        if (!this.userSockets.has(userId)) {
            this.userSockets.set(userId, new Set());
        }
        this.userSockets.get(userId).add(socketId);
        this.socketUsers.set(socketId, userId);
    }

    removeUser(socketId) {
        const userId = this.socketUsers.get(socketId);
        if (userId) {
            const userSockets = this.userSockets.get(userId);
            if (userSockets) {
                userSockets.delete(socketId);
                if (userSockets.size === 0) {
                    this.userSockets.delete(userId);
                }
            }
            this.socketUsers.delete(socketId);
        }
        return userId;
    }

    isUserOnline(userId) {
        return this.userSockets.has(userId) && this.userSockets.get(userId).size > 0;
    }

    getOnlineUsers() {
        return Array.from(this.userSockets.keys());
    }
}

const presenceManager = new PresenceManager();

function initializeSocket(socketIO) {
    io = socketIO;

    io.use(socketAuth);

    io.on('connection', async (socket) => {
        const user = socket.user;
        const companyId = user.companyId;

        logger.info(`User ${user.name} (${user.id}) connected to company ${companyId}`);

        // Adicionar usuário aos grupos
        socket.join(`company_${companyId}`);
        if (user.departmentId) {
            socket.join(`department_${user.departmentId}`);
        }
        socket.join(`user_${user.id}`);

        // Gerenciar presença
        presenceManager.addUser(user.id, socket.id);

        // Atualizar status online
        await prisma.user.update({
            where: { id: user.id },
            data: {
                isOnline: true,
                lastSeen: new Date()
            }
        });

        // Notificar outros usuários
        socket.to(`company_${companyId}`).emit('user:online', {
            userId: user.id,
            name: user.name,
            timestamp: new Date()
        });

        // Enviar conversas ativas
        await sendActiveConversations(socket, user);

        // Event Handlers
        setupEventHandlers(socket, user);

        // Desconexão
        socket.on('disconnect', async () => {
            const userId = presenceManager.removeUser(socket.id);

            if (userId && !presenceManager.isUserOnline(userId)) {
                await prisma.user.update({
                    where: { id: userId },
                    data: {
                        isOnline: false,
                        lastSeen: new Date()
                    }
                });

                socket.to(`company_${companyId}`).emit('user:offline', {
                    userId: userId,
                    timestamp: new Date()
                });
            }

            logger.info(`User ${user.name} (${user.id}) disconnected`);
        });
    });
}

async function sendActiveConversations(socket, user) {
    try {
        const conversations = await prisma.conversation.findMany({
            where: {
                companyId: user.companyId,
                status: { in: ['OPEN', 'PENDING'] },
                ...(user.role === 'AGENT' ? {
                    agents: {
                        some: { userId: user.id, isActive: true }
                    }
                } : {})
            },
            include: {
                contact: true,
                agents: {
                    where: { isActive: true },
                    include: { user: true }
                },
                messages: {
                    orderBy: { timestamp: 'desc' },
                    take: 1
                },
                department: true
            },
            orderBy: { updatedAt: 'desc' }
        });

        socket.emit('conversations:list', conversations);
    } catch (error) {
        logger.error('Error sending active conversations:', error);
    }
}

function setupEventHandlers(socket, user) {
    // Jointar conversa específica
    socket.on('conversation:join', async (conversationId) => {
        try {
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId, companyId: user.companyId }
            });

            if (conversation) {
                socket.join(`conversation_${conversationId}`);

                // Buscar mensagens da conversa
                const messages = await prisma.message.findMany({
                    where: { conversationId },
                    include: { user: true },
                    orderBy: { timestamp: 'asc' },
                    take: 50
                });

                socket.emit('conversation:messages', {
                    conversationId,
                    messages
                });
            }
        } catch (error) {
            logger.error('Error joining conversation:', error);
        }
    });

    // Sair da conversa
    socket.on('conversation:leave', (conversationId) => {
        socket.leave(`conversation_${conversationId}`);
    });

    // Enviar mensagem
    socket.on('message:send', async (data) => {
        try {
            const { conversationId, content, type = 'TEXT' } = data;

            // Verificar se o usuário pode enviar mensagens nesta conversa
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId, companyId: user.companyId },
                include: { contact: true, whatsapp: true }
            });

            if (!conversation) {
                socket.emit('error', { message: 'Conversa não encontrada' });
                return;
            }

            // Salvar mensagem no banco
            const message = await prisma.message.create({
                data: {
                    content,
                    type,
                    direction: 'OUTBOUND',
                    status: 'SENT',
                    conversationId,
                    userId: user.id
                },
                include: { user: true }
            });

            // Enviar via WhatsApp
            const { whatsappService } = require('./whatsapp');
            const sendResult = await whatsappService.sendMessage(
                conversation.whatsappId,
                conversation.contact.phone,
                content
            );

            if (sendResult.success) {
                // Atualizar status da mensagem
                await prisma.message.update({
                    where: { id: message.id },
                    data: {
                        status: 'DELIVERED',
                        metadata: { whatsappId: sendResult.messageId }
                    }
                });
            }

            // Notificar todos os usuários da conversa
            io.to(`conversation_${conversationId}`).emit('message:new', message);

            // Atualizar última atividade da conversa
            await prisma.conversation.update({
                where: { id: conversationId },
                data: { updatedAt: new Date() }
            });

        } catch (error) {
            logger.error('Error sending message:', error);
            socket.emit('error', { message: 'Erro ao enviar mensagem' });
        }
    });

    // Assumir conversa
    socket.on('conversation:take', async (conversationId) => {
        try {
            // Verificar se a conversa existe e não está atribuída
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId, companyId: user.companyId },
                include: {
                    agents: { where: { isActive: true } }
                }
            });

            if (!conversation) {
                socket.emit('error', { message: 'Conversa não encontrada' });
                return;
            }

            if (conversation.agents.length > 0) {
                socket.emit('error', { message: 'Conversa já está atribuída' });
                return;
            }

            // Atribuir conversa ao usuário
            await prisma.conversationAgent.create({
                data: {
                    userId: user.id,
                    conversationId,
                    isActive: true
                }
            });

            await prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'OPEN' }
            });

            // Notificar empresa
            socket.to(`company_${user.companyId}`).emit('conversation:assigned', {
                conversationId,
                agentId: user.id,
                agentName: user.name
            });

            socket.emit('conversation:taken', { conversationId });

        } catch (error) {
            logger.error('Error taking conversation:', error);
            socket.emit('error', { message: 'Erro ao assumir conversa' });
        }
    });

    // Marcar conversa como resolvida
    socket.on('conversation:close', async (conversationId) => {
        try {
            await prisma.conversation.update({
                where: { id: conversationId, companyId: user.companyId },
                data: { status: 'CLOSED' }
            });

            // Desativar agentes da conversa
            await prisma.conversationAgent.updateMany({
                where: { conversationId },
                data: { isActive: false }
            });

            io.to(`company_${user.companyId}`).emit('conversation:closed', {
                conversationId,
                closedBy: user.id
            });

        } catch (error) {
            logger.error('Error closing conversation:', error);
            socket.emit('error', { message: 'Erro ao fechar conversa' });
        }
    });

    // Digitando
    socket.on('typing:start', (conversationId) => {
        socket.to(`conversation_${conversationId}`).emit('typing:start', {
            userId: user.id,
            userName: user.name
        });
    });

    socket.on('typing:stop', (conversationId) => {
        socket.to(`conversation_${conversationId}`).emit('typing:stop', {
            userId: user.id
        });
    });
}

// Função para notificar empresa
async function notifyCompany(companyId, event, data) {
    if (io) {
        io.to(`company_${companyId}`).emit(event, data);
    }
}

// Função para obter instância do socket
function getSocketIO() {
    return io;
}

module.exports = {
    initializeSocket,
    notifyCompany,
    getSocketIO
};