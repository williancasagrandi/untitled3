// src/routes/admin.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, requireRole, checkPlanLimits } = require('../middleware/auth');
const { validate, schemas } = require('../utils/validation');
const bcrypt = require('bcryptjs');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticateToken);

// Dashboard de admin
router.get('/dashboard', requireRole('ADMIN', 'OWNER'), async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // Estatísticas gerais
        const stats = await Promise.all([
            // Total de conversas
            prisma.conversation.count({
                where: { companyId }
            }),

            // Conversas dos últimos 30 dias
            prisma.conversation.count({
                where: {
                    companyId,
                    createdAt: { gte: thirtyDaysAgo }
                }
            }),

            // Total de mensagens
            prisma.message.count({
                where: {
                    conversation: { companyId }
                }
            }),

            // Mensagens dos últimos 30 dias
            prisma.message.count({
                where: {
                    conversation: { companyId },
                    timestamp: { gte: thirtyDaysAgo }
                }
            }),

            // Agentes ativos
            prisma.user.count({
                where: {
                    companyId,
                    status: 'ACTIVE',
                    role: { in: ['AGENT', 'MANAGER'] }
                }
            }),

            // Conversas por status
            prisma.conversation.groupBy({
                by: ['status'],
                where: { companyId },
                _count: { status: true }
            })
        ]);

        const [
            totalConversations,
            conversationsLast30Days,
            totalMessages,
            messagesLast30Days,
            activeAgents,
            conversationsByStatus
        ] = stats;

        // Conversas por dia (últimos 7 dias)
        const last7Days = Array.from({ length: 7 }, (_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - i);
            return date.toISOString().split('T')[0];
        }).reverse();

        const conversationsByDay = await Promise.all(
            last7Days.map(async (date) => {
                const startOfDay = new Date(`${date}T00:00:00.000Z`);
                const endOfDay = new Date(`${date}T23:59:59.999Z`);

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

        res.json({
            overview: {
                totalConversations,
                conversationsLast30Days,
                totalMessages,
                messagesLast30Days,
                activeAgents
            },
            conversationsByStatus: conversationsByStatus.reduce((acc, item) => {
                acc[item.status] = item._count.status;
                return acc;
            }, {}),
            conversationsByDay
        });

    } catch (error) {
        console.error('Error fetching admin dashboard:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
});

// Gerenciar usuários
router.get('/users', requireRole('ADMIN', 'OWNER'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, role, status } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where = {
            companyId: req.user.companyId,
            ...(search && {
                OR: [
                    { name: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } }
                ]
            }),
            ...(role && { role }),
            ...(status && { status })
        };

        const users = await prisma.user.findMany({
            where,
            include: {
                department: { select: { id: true, name: true } },
                agents: {
                    where: { isActive: true },
                    include: {
                        conversation: {
                            select: { id: true, status: true }
                        }
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: parseInt(limit)
        });

        const total = await prisma.user.count({ where });

        res.json({
            users: users.map(user => ({
                ...user,
                password: undefined, // Não retornar senha
                activeConversations: user.agents.filter(
                    agent => agent.conversation.status === 'OPEN'
                ).length
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Erro ao buscar usuários' });
    }
});

// Criar usuário
router.post('/users',
    requireRole('ADMIN', 'OWNER'),
    checkPlanLimits('agents'),
    validate(schemas.createUser),
    async (req, res) => {
        try {
            const { email, name, password, role, departmentId } = req.body;

            // Verificar se email já existe
            const existingUser = await prisma.user.findUnique({
                where: { email }
            });

            if (existingUser) {
                return res.status(400).json({ error: 'Email já cadastrado' });
            }

            // Verificar permissões para criar roles específicas
            if (role === 'OWNER' && req.user.role !== 'OWNER') {
                return res.status(403).json({ error: 'Apenas owners podem criar outros owners' });
            }

            if (role === 'ADMIN' && !['OWNER', 'ADMIN'].includes(req.user.role)) {
                return res.status(403).json({ error: 'Permissão insuficiente para criar admin' });
            }

            const hashedPassword = await bcrypt.hash(password, 12);

            const user = await prisma.user.create({
                data: {
                    email,
                    name,
                    password: hashedPassword,
                    role,
                    departmentId,
                    companyId: req.user.companyId
                },
                include: {
                    department: { select: { id: true, name: true } }
                }
            });

            res.status(201).json({
                ...user,
                password: undefined
            });

        } catch (error) {
            console.error('Error creating user:', error);
            res.status(500).json({ error: 'Erro ao criar usuário' });
        }
    }
);

// Atualizar usuário
router.put('/users/:id',
    requireRole('ADMIN', 'OWNER'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, email, role, departmentId, status } = req.body;

            // Verificar se o usuário existe e pertence à empresa
            const existingUser = await prisma.user.findUnique({
                where: {
                    id,
                    companyId: req.user.companyId
                }
            });

            if (!existingUser) {
                return res.status(404).json({ error: 'Usuário não encontrado' });
            }

            // Verificar permissões
            if (existingUser.role === 'OWNER' && req.user.role !== 'OWNER') {
                return res.status(403).json({ error: 'Apenas owners podem editar outros owners' });
            }

            if (role === 'OWNER' && req.user.role !== 'OWNER') {
                return res.status(403).json({ error: 'Apenas owners podem promover a owner' });
            }

            // Verificar se email já existe (se foi alterado)
            if (email && email !== existingUser.email) {
                const emailExists = await prisma.user.findUnique({
                    where: { email }
                });

                if (emailExists) {
                    return res.status(400).json({ error: 'Email já cadastrado' });
                }
            }

            const updatedUser = await prisma.user.update({
                where: { id },
                data: {
                    name,
                    email,
                    role,
                    departmentId,
                    status
                },
                include: {
                    department: { select: { id: true, name: true } }
                }
            });

            res.json({
                ...updatedUser,
                password: undefined
            });

        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).json({ error: 'Erro ao atualizar usuário' });
        }
    }
);

// Deletar usuário
router.delete('/users/:id',
    requireRole('ADMIN', 'OWNER'),
    async (req, res) => {
        try {
            const { id } = req.params;

            // Verificar se o usuário existe e pertence à empresa
            const user = await prisma.user.findUnique({
                where: {
                    id,
                    companyId: req.user.companyId
                }
            });

            if (!user) {
                return res.status(404).json({ error: 'Usuário não encontrado' });
            }

            // Não permitir deletar owners (apenas desativar)
            if (user.role === 'OWNER') {
                return res.status(400).json({ error: 'Owners não podem ser deletados, apenas desativados' });
            }

            // Verificar se o usuário não está atribuído a conversas ativas
            const activeAssignments = await prisma.conversationAgent.count({
                where: {
                    userId: id,
                    isActive: true,
                    conversation: { status: { in: ['OPEN', 'PENDING'] } }
                }
            });

            if (activeAssignments > 0) {
                return res.status(400).json({
                    error: 'Usuário possui conversas ativas. Transfira as conversas antes de deletar.'
                });
            }

            // Desativar ao invés de deletar para manter histórico
            await prisma.user.update({
                where: { id },
                data: { status: 'INACTIVE' }
            });

            res.json({ message: 'Usuário desativado com sucesso' });

        } catch (error) {
            console.error('Error deleting user:', error);
            res.status(500).json({ error: 'Erro ao deletar usuário' });
        }
    }
);

// Gerenciar departamentos
router.get('/departments', requireRole('ADMIN', 'OWNER'), async (req, res) => {
    try {
        const departments = await prisma.department.findMany({
            where: { companyId: req.user.companyId },
            include: {
                users: {
                    where: { status: 'ACTIVE' },
                    select: { id: true, name: true, role: true }
                },
                conversations: {
                    where: { status: { in: ['OPEN', 'PENDING'] } },
                    select: { id: true }
                }
            },
            orderBy: { name: 'asc' }
        });

        res.json(departments.map(dept => ({
            ...dept,
            activeUsers: dept.users.length,
            activeConversations: dept.conversations.length
        })));

    } catch (error) {
        console.error('Error fetching departments:', error);
        res.status(500).json({ error: 'Erro ao buscar departamentos' });
    }
});

// Criar departamento
router.post('/departments',
    requireRole('ADMIN', 'OWNER'),
    validate(schemas.createDepartment),
    async (req, res) => {
        try {
            const { name, description } = req.body;

            const department = await prisma.department.create({
                data: {
                    name,
                    description,
                    companyId: req.user.companyId
                }
            });

            res.status(201).json(department);

        } catch (error) {
            console.error('Error creating department:', error);
            res.status(500).json({ error: 'Erro ao criar departamento' });
        }
    }
);

// Atualizar departamento
router.put('/departments/:id',
    requireRole('ADMIN', 'OWNER'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, description } = req.body;

            const department = await prisma.department.findUnique({
                where: {
                    id,
                    companyId: req.user.companyId
                }
            });

            if (!department) {
                return res.status(404).json({ error: 'Departamento não encontrado' });
            }

            const updatedDepartment = await prisma.department.update({
                where: { id },
                data: { name, description }
            });

            res.json(updatedDepartment);

        } catch (error) {
            console.error('Error updating department:', error);
            res.status(500).json({ error: 'Erro ao atualizar departamento' });
        }
    }
);

// Deletar departamento
router.delete('/departments/:id',
    requireRole('ADMIN', 'OWNER'),
    async (req, res) => {
        try {
            const { id } = req.params;

            const department = await prisma.department.findUnique({
                where: {
                    id,
                    companyId: req.user.companyId
                }
            });

            if (!department) {
                return res.status(404).json({ error: 'Departamento não encontrado' });
            }

            if (department.isDefault) {
                return res.status(400).json({ error: 'Não é possível deletar o departamento padrão' });
            }

            // Verificar se há usuários ou conversas no departamento
            const [usersCount, conversationsCount] = await Promise.all([
                prisma.user.count({ where: { departmentId: id } }),
                prisma.conversation.count({ where: { departmentId: id } })
            ]);

            if (usersCount > 0 || conversationsCount > 0) {
                return res.status(400).json({
                    error: 'Departamento possui usuários ou conversas. Transfira-os antes de deletar.'
                });
            }

            await prisma.department.delete({ where: { id } });

            res.json({ message: 'Departamento deletado com sucesso' });

        } catch (error) {
            console.error('Error deleting department:', error);
            res.status(500).json({ error: 'Erro ao deletar departamento' });
        }
    }
);

module.exports = router;