// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');

const router = express.Router();
const prisma = new PrismaClient();

// Registro de nova empresa
router.post('/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('name').notEmpty().trim(),
    body('companyName').notEmpty().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password, name, companyName, phone } = req.body;

        // Verificar se email já existe
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ error: 'Email já cadastrado' });
        }

        // Hash da senha
        const hashedPassword = await bcrypt.hash(password, 12);

        // Criar empresa e usuário owner em uma transação
        const result = await prisma.$transaction(async (tx) => {
            // Criar empresa
            const company = await tx.company.create({
                data: {
                    name: companyName,
                    email,
                    phone,
                    plan: 'STARTER',
                    status: 'TRIAL'
                }
            });

            // Criar departamento padrão
            const department = await tx.department.create({
                data: {
                    name: 'Geral',
                    description: 'Departamento padrão',
                    isDefault: true,
                    companyId: company.id
                }
            });

            // Criar usuário owner
            const user = await tx.user.create({
                data: {
                    email,
                    name,
                    password: hashedPassword,
                    role: 'OWNER',
                    companyId: company.id,
                    departmentId: department.id
                }
            });

            return { company, user };
        });

        // Gerar JWT
        const token = jwt.sign(
            { userId: result.user.id, companyId: result.company.id },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Salvar sessão
        await prisma.userSession.create({
            data: {
                token,
                userId: result.user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 dias
            }
        });

        res.status(201).json({
            message: 'Conta criada com sucesso',
            token,
            user: {
                id: result.user.id,
                name: result.user.name,
                email: result.user.email,
                role: result.user.role,
                company: {
                    id: result.company.id,
                    name: result.company.name,
                    plan: result.company.plan
                }
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Login
router.post('/login', [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;

        const user = await prisma.user.findUnique({
            where: { email },
            include: { company: true, department: true }
        });

        if (!user || user.status !== 'ACTIVE') {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        if (user.company.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });
        }

        const token = jwt.sign(
            { userId: user.id, companyId: user.companyId },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        await prisma.userSession.create({
            data: {
                token,
                userId: user.id,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        });

        // Atualizar último acesso
        await prisma.user.update({
            where: { id: user.id },
            data: { lastSeen: new Date() }
        });

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                isOnline: user.isOnline,
                company: {
                    id: user.company.id,
                    name: user.company.name,
                    plan: user.company.plan,
                    status: user.company.status
                },
                department: user.department
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Logout
router.post('/logout', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            await prisma.userSession.deleteMany({ where: { token } });
        }
        res.json({ message: 'Logout realizado com sucesso' });
    } catch (error) {
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

module.exports = router;

// src/routes/chat.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');
const { whatsappService } = require('../services/whatsapp');

const router = express.Router();
const prisma = new PrismaClient();

// Todas as rotas precisam de autenticação
router.use(authenticateToken);

// Listar conversas
router.get('/conversations', async (req, res) => {
    try {
        const { page = 1, limit = 20, status, department } = req.query;
        const userId = req.user.id;
        const companyId = req.user.companyId;

        const where = {
            companyId,
            ...(status && { status }),
            ...(department && { departmentId: department }),
            ...(req.user.role === 'AGENT' && {
                agents: {
                    some: { userId, isActive: true }
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
                messages: {
                    orderBy: { timestamp: 'desc' },
                    take: 1
                },
                department: true,
                _count: {
                    select: {
                        messages: {
                            where: {
                                direction: 'INBOUND',
                                // Adicionar lógica para mensagens não lidas
                            }
                        }
                    }
                }
            },
            orderBy: { lastMessageAt: 'desc' },
            skip: (page - 1) * limit,
            take: parseInt(limit)
        });

        res.json(conversations);

    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ error: 'Erro ao buscar conversas' });
    }
});

// Buscar mensagens de uma conversa
router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { page = 1, limit = 50 } = req.query;

        // Verificar se o usuário tem acesso à conversa
        const conversation = await prisma.conversation.findUnique({
            where: { id },
            include: {
                agents: {
                    where: { isActive: true }
                }
            }
        });

        if (!conversation || conversation.companyId !== req.user.companyId) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        if (req.user.role === 'AGENT') {
            const hasAccess = conversation.agents.some(a => a.userId === req.user.id);
            if (!hasAccess) {
                return res.status(403).json({ error: 'Acesso negado' });
            }
        }

        const messages = await prisma.message.findMany({
            where: { conversationId: id },
            include: {
                user: { select: { id: true, name: true } }
            },
            orderBy: { timestamp: 'asc' },
            skip: (page - 1) * limit,
            take: parseInt(limit)
        });

        res.json(messages);

    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
});

// Enviar mensagem
router.post('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { content, type = 'TEXT', mediaUrl } = req.body;

        const conversation = await prisma.conversation.findUnique({
            where: { id },
            include: {
                contact: true,
                whatsappAccount: true,
                agents: { where: { isActive: true } }
            }
        });

        if (!conversation || conversation.companyId !== req.user.companyId) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        // Verificar permissões
        if (req.user.role === 'AGENT') {
            const isAssigned = conversation.agents.some(a => a.userId === req.user.id);
            if (!isAssigned) {
                return res.status(403).json({ error: 'Você não está atribuído a esta conversa' });
            }
        }

        // Salvar mensagem
        const message = await prisma.message.create({
            data: {
                content,
                type,
                direction: 'OUTBOUND',
                status: 'SENT',
                mediaUrl,
                conversationId: id,
                userId: req.user.id
            },
            include: {
                user: { select: { id: true, name: true } }
            }
        });

        // Enviar via WhatsApp
        if (conversation.whatsappAccount) {
            try {
                await whatsappService.sendMessage(
                    conversation.whatsappAccount.id,
                    conversation.contact.phone,
                    content,
                    mediaUrl
                );

                await prisma.message.update({
                    where: { id: message.id },
                    data: { status: 'DELIVERED' }
                });

            } catch (error) {
                console.error('WhatsApp send error:', error);
                await prisma.message.update({
                    where: { id: message.id },
                    data: { status: 'FAILED' }
                });
            }
        }

        // Atualizar conversa
        await prisma.conversation.update({
            where: { id },
            data: {
                lastMessageAt: new Date(),
                status: conversation.status === 'PENDING' ? 'OPEN' : conversation.status
            }
        });

        res.status(201).json(message);

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Erro ao enviar mensagem' });
    }
});

// Atribuir conversa
router.post('/conversations/:id/assign', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        if (!['ADMIN', 'MANAGER', 'OWNER'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Permissão insuficiente' });
        }

        const conversation = await prisma.conversation.findUnique({
            where: { id },
            include: { agents: { where: { isActive: true } } }
        });

        if (!conversation || conversation.companyId !== req.user.companyId) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        // Verificar se o usuário existe na empresa
        const targetUser = await prisma.user.findUnique({
            where: { id: userId },
            include: { company: true }
        });

        if (!targetUser || targetUser.companyId !== req.user.companyId) {
            return res.status(400).json({ error: 'Usuário não encontrado' });
        }

        // Verificar se já está atribuído
        const existingAssignment = conversation.agents.find(a => a.userId === userId);
        if (existingAssignment) {
            return res.status(400).json({ error: 'Usuário já atribuído a esta conversa' });
        }

        // Criar atribuição
        await prisma.conversationAgent.create({
            data: {
                conversationId: id,
                userId: userId
            }
        });

        // Atualizar status se necessário
        if (conversation.status === 'PENDING') {
            await prisma.conversation.update({
                where: { id },
                data: { status: 'OPEN' }
            });
        }

        res.json({ message: 'Conversa atribuída com sucesso' });

    } catch (error) {
        console.error('Error assigning conversation:', error);
        res.status(500).json({ error: 'Erro ao atribuir conversa' });
    }
});

// Fechar conversa
router.post('/conversations/:id/close', async (req, res) => {
    try {
        const { id } = req.params;
        const { rating, feedback } = req.body;

        const conversation = await prisma.conversation.findUnique({
            where: { id },
            include: { agents: { where: { isActive: true } } }
        });

        if (!conversation || conversation.companyId !== req.user.companyId) {
            return res.status(404).json({ error: 'Conversa não encontrada' });
        }

        // Verificar permissões
        if (req.user.role === 'AGENT') {
            const isAssigned = conversation.agents.some(a => a.userId === req.user.id);
            if (!isAssigned) {
                return res.status(403).json({ error: 'Você não pode fechar esta conversa' });
            }
        }

        // Fechar conversa
        await prisma.conversation.update({
            where: { id },
            data: {
                status: 'CLOSED',
                closedAt: new Date(),
                rating: rating || null,
                feedback: feedback || null
            }
        });

        // Desativar atribuições
        await prisma.conversationAgent.updateMany({
            where: { conversationId: id, isActive: true },
            data: { isActive: false, unassignedAt: new Date() }
        });

        res.json({ message: 'Conversa fechada com sucesso' });

    } catch (error) {
        console.error('Error closing conversation:', error);
        res.status(500).json({ error: 'Erro ao fechar conversa' });
    }
});

module.exports = router;

// src/routes/whatsapp.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');
const { whatsappService } = require('../services/whatsapp');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticateToken);

// Listar contas WhatsApp
router.get('/accounts', async (req, res) => {
    try {
        const accounts = await prisma.whatsAppAccount.findMany({
            where: { companyId: req.user.companyId },
            select: {
                id: true,
                name: true,
                phone: true,
                status: true,
                createdAt: true
            }
        });

        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar contas WhatsApp' });
    }
});

// Criar nova conta WhatsApp
router.post('/accounts', async (req, res) => {
    try {
        const { name } = req.body;

        if (!['OWNER', 'ADMIN'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Permissão insuficiente' });
        }

        const account = await prisma.whatsAppAccount.create({
            data: {
                name,
                companyId: req.user.companyId,
                status: 'DISCONNECTED'
            }
        });

        res.status(201).json(account);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar conta WhatsApp' });
    }
});

// Conectar conta WhatsApp
router.post('/accounts/:id/connect', async (req, res) => {
    try {
        const { id } = req.params;

        const account = await prisma.whatsAppAccount.findUnique({
            where: { id, companyId: req.user.companyId }
        });

        if (!account) {
            return res.status(404).json({ error: 'Conta não encontrada' });
        }

        await whatsappService.initializeAccount(req.user.companyId, id);

        res.json({ message: 'Processo de conexão iniciado' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao conectar conta WhatsApp' });
    }
});

// Desconectar conta WhatsApp
router.post('/accounts/:id/disconnect', async (req, res) => {
    try {
        const { id } = req.params;

        const account = await prisma.whatsAppAccount.findUnique({
            where: { id, companyId: req.user.companyId }
        });

        if (!account) {
            return res.status(404).json({ error: 'Conta não encontrada' });
        }

        await whatsappService.disconnectAccount(id);

        res.json({ message: 'Conta desconectada com sucesso' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao desconectar conta WhatsApp' });
    }
});

module.exports = router;