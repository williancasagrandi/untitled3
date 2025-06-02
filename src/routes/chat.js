// src/routes/chat.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, requireRole, checkPlanLimits } = require('../middleware/auth');
const { messageRateLimit } = require('../middleware/rateLimiter');
const { validate, schemas } = require('../utils/validation');
const { whatsappService } = require('../services/whatsapp');
const multer = require('multer');
const path = require('path');

const router = express.Router();
const prisma = new PrismaClient();

// Configurar upload de arquivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|mp3|mp4|wav/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não permitido'));
        }
    }
});

router.use(authenticateToken);

// Listar conversas
router.get('/conversations', async (req, res) => {
    try {
        const { page = 1, limit = 20, status, departmentId } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where = {
            companyId: req.user.companyId,
            ...(status && { status }),
            ...(departmentId && { departmentId }),
            // Se for agente, mostrar apenas suas conversas
            ...(req.user.role === 'AGENT' && {
                agents: {
                    some: { userId: req.user.id, isActive: true }
                }
            })
        };

        const conversations = await prisma.conversation.findMany({
            where,
            include: {
                contact: true,
                agents: {
                    where: { isActive: true },
                    include: { user: { select: { id: true, name: true, role: true } } }
                },
                messages: {
                    orderBy: { timestamp: 'desc' },
                    take: 1
                },
                department: { select: { id: true, name: true } }
            },
            orderBy: { updatedAt: 'desc' },
            skip,
            take: parseInt(limit)
        });

        const total = await prisma.conversation.count({ where });

        res.json({
            conversations,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ error: 'Erro ao buscar conversas' });
    }
});

// Buscar conversa específica
router.get('/conversations/:id', async (req, res) => {
    try {
        const conversation = await prisma.conversation.findUnique({
            where: {
                id: req.params.id,
                companyId: req.user.companyId
            },
            include: {
                contact: true,
                agents: {
                    where: { isActive: true },
                    include: { user: { select: { id: true, name: true, role: true } } }
                },
                department: { select: { id: true, name: true } },
                whatsapp: { select: { id: true, phone: true, status: true } }
            }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        res.json(conversation);
    } catch (error) {
        console.error('Error fetching conversation:', error);
        res.status(500).json({ error: 'Erro ao buscar conversa' });
    }
});

// Buscar mensagens de uma conversa
router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Verificar se a conversa pertence à empresa do usuário
        const conversation = await prisma.conversation.findUnique({
            where: {
                id: req.params.id,
                companyId: req.user.companyId
            }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        const messages = await prisma.message.findMany({
            where: { conversationId: req.params.id },
            include: {
                user: { select: { id: true, name: true, role: true } }
            },
            orderBy: { timestamp: 'desc' },
            skip,
            take: parseInt(limit)
        });

        const total = await prisma.message.count({
            where: { conversationId: req.params.id }
        });

        res.json({
            messages: messages.reverse(), // Reverter para ordem cronológica
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});

// Enviar mensagem
router.post('/conversations/:id/messages',
    messageRateLimit,
    checkPlanLimits('messages'),
    validate(schemas.sendMessage),
    async (req, res) => {
        try {
            const { content, type = 'TEXT' } = req.body;
            const conversationId = req.params.id;

            // Verificar se a conversa existe e o usuário tem acesso
            const conversation = await prisma.conversation.findUnique({
                where: {
                    id: conversationId,
                    companyId: req.user.companyId
                },
                include: {
                    contact: true,
                    whatsapp: true
                }
            });

            if (!conversation) {
                return res.status(404).json({ error: 'Conversa não encontrada' });
            }

            // Salvar mensagem no banco
            const message = await prisma.message.create({
                data: {
                    content,
                    type,
                    direction: 'OUTBOUND',
                    status: 'SENT',
                    conversationId,
                    userId: req.user.id
                },
                include: {
                    user: { select: { id: true, name: true, role: true } }
                }
            });

            // Enviar via WhatsApp
            const sendResult = await whatsappService.sendMessage(
                conversation.whatsappId,
                conversation.contact.phone,
                content
            );

            if (sendResult.success) {
                await prisma.message.update({
                    where: { id: message.id },
                    data: {
                        status: 'DELIVERED',
                        metadata: { whatsappId: sendResult.messageId }
                    }
                });
            } else {
                await prisma.message.update({
                    where: { id: message.id },
                    data: { status: 'FAILED' }
                });
            }

            // Atualizar última atividade da conversa
            await prisma.conversation.update({
                where: { id: conversationId },
                data: { updatedAt: new Date() }
            });

            // Notificar via socket
            const { notifyCompany } = require('../services/socket');
            await notifyCompany(req.user.companyId, 'message:new', {
                conversationId,
                message: { ...message, status: sendResult.success ? 'DELIVERED' : 'FAILED' }
            });

            res.status(201).json({
                ...message,
                status: sendResult.success ? 'DELIVERED' : 'FAILED'
            });

        } catch (error) {
            console.error('Error sending message:', error);
            res.status(500).json({ error: 'Erro ao enviar mensagem' });
        }
    }
);

// Enviar mensagem com arquivo
router.post('/conversations/:id/messages/media',
    upload.single('file'),
    messageRateLimit,
    checkPlanLimits('messages'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Arquivo não fornecido' });
            }

            const { caption = '' } = req.body;
            const conversationId = req.params.id;

            const conversation = await prisma.conversation.findUnique({
                where: {
                    id: conversationId,
                    companyId: req.user.companyId
                },
                include: {
                    contact: true,
                    whatsapp: true
                }
            });

            if (!conversation) {
                return res.status(404).json({ error: 'Conversa não encontrada' });
            }

            // Determinar tipo de arquivo
            let messageType = 'DOCUMENT';
            if (req.file.mimetype.startsWith('image/')) messageType = 'IMAGE';
            else if (req.file.mimetype.startsWith('audio/')) messageType = 'AUDIO';
            else if (req.file.mimetype.startsWith('video/')) messageType = 'VIDEO';

            // Salvar mensagem no banco
            const message = await prisma.message.create({
                data: {
                    content: caption,
                    type: messageType,
                    direction: 'OUTBOUND',
                    status: 'SENT',
                    conversationId,
                    userId: req.user.id,
                    metadata: {
                        fileName: req.file.originalname,
                        filePath: req.file.path,
                        mimeType: req.file.mimetype,
                        fileSize: req.file.size
                    }
                },
                include: {
                    user: { select: { id: true, name: true, role: true } }
                }
            });

            // Enviar via WhatsApp
            const sendResult = await whatsappService.sendMessage(
                conversation.whatsappId,
                conversation.contact.phone,
                caption,
                req.file.path
            );

            if (sendResult.success) {
                await prisma.message.update({
                    where: { id: message.id },
                    data: {
                        status: 'DELIVERED',
                        metadata: {
                            ...message.metadata,
                            whatsappId: sendResult.messageId
                        }
                    }
                });
            }

            res.status(201).json({
                ...message,
                status: sendResult.success ? 'DELIVERED' : 'FAILED'
            });

        } catch (error) {
            console.error('Error sending media message:', error);
            res.status(500).json({ error: 'Erro ao enviar arquivo' });
        }
    }
);

// Atribuir conversa a agente
router.post('/conversations/:id/assign',
    requireRole('AGENT', 'MANAGER', 'ADMIN', 'OWNER'),
    async (req, res) => {
        try {
            const { agentId } = req.body;
            const conversationId = req.params.id;

            const conversation = await prisma.conversation.findUnique({
                where: {
                    id: conversationId,
                    companyId: req.user.companyId
                }
            });

            if (!conversation) {
                return res.status(404).json({ error: 'Conversa não encontrada' });
            }

            // Verificar se o agente existe e pertence à empresa
            const agent = await prisma.user.findUnique({
                where: {
                    id: agentId || req.user.id,
                    companyId: req.user.companyId,
                    status: 'ACTIVE'
                }
            });

            if (!agent) {
                return res.status(404).json({ error: 'Agente não encontrado' });
            }

            // Desativar atribuições anteriores
            await prisma.conversationAgent.updateMany({
                where: { conversationId },
                data: { isActive: false }
            });

            // Criar nova atribuição
            await prisma.conversationAgent.create({
                data: {
                    userId: agent.id,
                    conversationId,
                    isActive: true
                }
            });

            // Atualizar status da conversa
            await prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'OPEN' }
            });

            const { notifyCompany } = require('../services/socket');
            await notifyCompany(req.user.companyId, 'conversation:assigned', {
                conversationId,
                agentId: agent.id,
                agentName: agent.name
            });

            res.json({ message: 'Conversa atribuída com sucesso' });

        } catch (error) {
            console.error('Error assigning conversation:', error);
            res.status(500).json({ error: 'Erro ao atribuir conversa' });
        }
    }
);

// Fechar conversa
router.post('/conversations/:id/close', async (req, res) => {
    try {
        const conversationId = req.params.id;

        const conversation = await prisma.conversation.findUnique({
            where: {
                id: conversationId,
                companyId: req.user.companyId
            }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        await prisma.conversation.update({
            where: { id: conversationId },
            data: { status: 'CLOSED' }
        });

        // Desativar agentes
        await prisma.conversationAgent.updateMany({
            where: { conversationId },
            data: { isActive: false }
        });

        const { notifyCompany } = require('../services/socket');
        await notifyCompany(req.user.companyId, 'conversation:closed', {
            conversationId,
            closedBy: req.user.id
        });

        res.json({ message: 'Conversa fechada com sucesso' });

    } catch (error) {
        console.error('Error closing conversation:', error);
        res.status(500).json({ error: 'Erro ao fechar conversa' });
    }
});

// Reabrir conversa
router.post('/conversations/:id/reopen', async (req, res) => {
    try {
        const conversationId = req.params.id;

        const conversation = await prisma.conversation.findUnique({
            where: {
                id: conversationId,
                companyId: req.user.companyId
            }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        await prisma.conversation.update({
            where: { id: conversationId },
            data: { status: 'PENDING' }
        });

        const { notifyCompany } = require('../services/socket');
        await notifyCompany(req.user.companyId, 'conversation:reopened', {
            conversationId,
            reopenedBy: req.user.id
        });

        res.json({ message: 'Conversa reaberta com sucesso' });

    } catch (error) {
        console.error('Error reopening conversation:', error);
        res.status(500).json({ error: 'Erro ao reabrir conversa' });
    }
});

// Transferir conversa para departamento
router.post('/conversations/:id/transfer',
    requireRole('AGENT', 'MANAGER', 'ADMIN', 'OWNER'),
    async (req, res) => {
        try {
            const { departmentId } = req.body;
            const conversationId = req.params.id;

            const conversation = await prisma.conversation.findUnique({
                where: {
                    id: conversationId,
                    companyId: req.user.companyId
                }
            });

            if (!conversation) {
                return res.status(404).json({ error: 'Conversa não encontrada' });
            }

            // Verificar se o departamento existe
            const department = await prisma.department.findUnique({
                where: {
                    id: departmentId,
                    companyId: req.user.companyId
                }
            });

            if (!department) {
                return res.status(404).json({ error: 'Departamento não encontrado' });
            }

            // Desativar agentes atuais
            await prisma.conversationAgent.updateMany({
                where: { conversationId },
                data: { isActive: false }
            });

            // Transferir para departamento
            await prisma.conversation.update({
                where: { id: conversationId },
                data: {
                    departmentId,
                    status: 'PENDING'
                }
            });

            const { notifyCompany } = require('../services/socket');
            await notifyCompany(req.user.companyId, 'conversation:transferred', {
                conversationId,
                departmentId,
                departmentName: department.name,
                transferredBy: req.user.id
            });

            res.json({ message: 'Conversa transferida com sucesso' });

        } catch (error) {
            console.error('Error transferring conversation:', error);
            res.status(500).json({ error: 'Erro ao transferir conversa' });
        }
    }
);

module.exports = router;