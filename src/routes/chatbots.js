// src/routes/chatbots.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, requireRole, checkPlanLimits } = require('../middleware/auth');
const { validate, schemas } = require('../utils/validation');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticateToken);

// Listar chatbots
router.get('/', async (req, res) => {
    try {
        const chatbots = await prisma.chatbot.findMany({
            where: { companyId: req.user.companyId },
            include: {
                department: {
                    select: { id: true, name: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(chatbots);
    } catch (error) {
        console.error('Error fetching chatbots:', error);
        res.status(500).json({ error: 'Erro ao buscar chatbots' });
    }
});

// Buscar chatbot específico
router.get('/:id', async (req, res) => {
    try {
        const chatbot = await prisma.chatbot.findUnique({
            where: {
                id: req.params.id,
                companyId: req.user.companyId
            },
            include: {
                department: {
                    select: { id: true, name: true }
                }
            }
        });

        if (!chatbot) {
            return res.status(404).json({ error: 'Chatbot não encontrado' });
        }

        res.json(chatbot);
    } catch (error) {
        console.error('Error fetching chatbot:', error);
        res.status(500).json({ error: 'Erro ao buscar chatbot' });
    }
});

// Criar chatbot
router.post('/',
    requireRole('OWNER', 'ADMIN', 'MANAGER'),
    checkPlanLimits('ai'),
    validate(schemas.createChatbot),
    async (req, res) => {
        try {
            const { name, description, config, departmentId } = req.body;

            const chatbot = await prisma.chatbot.create({
                data: {
                    name,
                    description,
                    config,
                    departmentId,
                    companyId: req.user.companyId
                },
                include: {
                    department: {
                        select: { id: true, name: true }
                    }
                }
            });

            res.status(201).json(chatbot);
        } catch (error) {
            console.error('Error creating chatbot:', error);
            res.status(500).json({ error: 'Erro ao criar chatbot' });
        }
    }
);

// Atualizar chatbot
router.put('/:id',
    requireRole('OWNER', 'ADMIN', 'MANAGER'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, description, config, departmentId, isActive } = req.body;

            const chatbot = await prisma.chatbot.findUnique({
                where: { id, companyId: req.user.companyId }
            });

            if (!chatbot) {
                return res.status(404).json({ error: 'Chatbot não encontrado' });
            }

            const updatedChatbot = await prisma.chatbot.update({
                where: { id },
                data: {
                    name,
                    description,
                    config,
                    departmentId,
                    isActive
                },
                include: {
                    department: {
                        select: { id: true, name: true }
                    }
                }
            });

            res.json(updatedChatbot);
        } catch (error) {
            console.error('Error updating chatbot:', error);
            res.status(500).json({ error: 'Erro ao atualizar chatbot' });
        }
    }
);

// Deletar chatbot
router.delete('/:id',
    requireRole('OWNER', 'ADMIN'),
    async (req, res) => {
        try {
            const { id } = req.params;

            const chatbot = await prisma.chatbot.findUnique({
                where: { id, companyId: req.user.companyId }
            });

            if (!chatbot) {
                return res.status(404).json({ error: 'Chatbot não encontrado' });
            }

            await prisma.chatbot.delete({ where: { id } });

            res.json({ message: 'Chatbot deletado com sucesso' });
        } catch (error) {
            console.error('Error deleting chatbot:', error);
            res.status(500).json({ error: 'Erro ao deletar chatbot' });
        }
    }
);

// Testar chatbot
router.post('/:id/test',
    async (req, res) => {
        try {
            const { id } = req.params;
            const { message } = req.body;

            const chatbot = await prisma.chatbot.findUnique({
                where: { id, companyId: req.user.companyId }
            });

            if (!chatbot) {
                return res.status(404).json({ error: 'Chatbot não encontrado' });
            }

            // Simular processamento do chatbot
            const { processIncomingMessage } = require('../services/messageProcessor');

            // Criar contexto de teste
            const mockConversation = {
                id: 'test',
                companyId: req.user.companyId,
                contact: { name: 'Teste', phone: '5511999999999' }
            };

            const mockMessage = {
                id: 'test',
                content: message,
                direction: 'INBOUND',
                timestamp: new Date()
            };

            // Processar mensagem (isso seria adaptado para modo de teste)
            const response = await simulateChatbotResponse(mockMessage, mockConversation, chatbot);

            res.json({
                userMessage: message,
                botResponse: response,
                timestamp: new Date()
            });

        } catch (error) {
            console.error('Error testing chatbot:', error);
            res.status(500).json({ error: 'Erro ao testar chatbot' });
        }
    }
);

async function simulateChatbotResponse(message, conversation, chatbot) {
    // Implementação simplificada para teste
    const config = chatbot.config;

    // Aqui você implementaria a lógica do chatbot baseada na configuração
    const responses = [
        "Olá! Como posso ajudá-lo?",
        "Entendi sua mensagem. Vou transferir você para um atendente.",
        "Obrigado pelo contato! Em que posso ser útil?",
        "Desculpe, não entendi. Pode reformular sua pergunta?"
    ];

    return responses[Math.floor(Math.random() * responses.length)];
}

module.exports = router;

// src/services/chatbotBuilder.js
class ChatbotBuilder {
    constructor() {
        this.flows = new Map();
    }

    createFlow(name, config) {
        const flow = {
            id: this.generateId(),
            name,
            nodes: [],
            connections: [],
            variables: {},
            ...config
        };

        this.flows.set(flow.id, flow);
        return flow;
    }

    addNode(flowId, nodeConfig) {
        const flow = this.flows.get(flowId);
        if (!flow) throw new Error('Flow not found');

        const node = {
            id: this.generateId(),
            type: nodeConfig.type,
            position: nodeConfig.position || { x: 0, y: 0 },
            data: nodeConfig.data,
            ...nodeConfig
        };

        flow.nodes.push(node);
        return node;
    }

    addConnection(flowId, sourceNodeId, targetNodeId, condition = null) {
        const flow = this.flows.get(flowId);
        if (!flow) throw new Error('Flow not found');

        const connection = {
            id: this.generateId(),
            source: sourceNodeId,
            target: targetNodeId,
            condition
        };

        flow.connections.push(connection);
        return connection;
    }

    // Tipos de nós disponíveis
    static NODE_TYPES = {
        START: 'start',
        MESSAGE: 'message',
        CONDITION: 'condition',
        INPUT: 'input',
        API_CALL: 'api_call',
        TRANSFER: 'transfer',
        END: 'end'
    };

    // Template de chatbot básico
    static createBasicTemplate() {
        return {
            name: 'Chatbot Básico',
            description: 'Template básico de atendimento',
            flows: [
                {
                    name: 'Fluxo Principal',
                    nodes: [
                        {
                            type: 'start',
                            position: { x: 100, y: 100 },
                            data: { label: 'Início' }
                        },
                        {
                            type: 'message',
                            position: { x: 100, y: 200 },
                            data: {
                                message: 'Olá! Bem-vindo ao nosso atendimento. Como posso ajudá-lo?',
                                options: [
                                    { label: 'Informações sobre produtos', value: 'produtos' },
                                    { label: 'Suporte técnico', value: 'suporte' },
                                    { label: 'Falar com atendente', value: 'atendente' }
                                ]
                            }
                        },
                        {
                            type: 'condition',
                            position: { x: 100, y: 300 },
                            data: {
                                variable: 'user_choice',
                                conditions: [
                                    { operator: 'equals', value: 'produtos', target: 'products_flow' },
                                    { operator: 'equals', value: 'suporte', target: 'support_flow' },
                                    { operator: 'equals', value: 'atendente', target: 'transfer_agent' }
                                ]
                            }
                        },
                        {
                            type: 'transfer',
                            position: { x: 300, y: 400 },
                            data: {
                                message: 'Vou transferir você para um de nossos atendentes. Aguarde um momento!',
                                department: null
                            }
                        }
                    ]
                }
            ],
            settings: {
                fallbackMessage: 'Desculpe, não entendi. Pode reformular sua pergunta?',
                transferTimeout: 300000, // 5 minutos
                collectLeads: true,
                businessHours: {
                    enabled: true,
                    schedule: {
                        monday: { start: '09:00', end: '18:00' },
                        tuesday: { start: '09:00', end: '18:00' },
                        wednesday: { start: '09:00', end: '18:00' },
                        thursday: { start: '09:00', end: '18:00' },
                        friday: { start: '09:00', end: '18:00' },
                        saturday: { start: '09:00', end: '14:00' },
                        sunday: { start: null, end: null }
                    }
                }
            }
        };
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
}

module.exports = { ChatbotBuilder };

// __tests__/auth.test.js
const request = require('supertest');
const app = require('../src/server');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

describe('Authentication', () => {
    beforeAll(async () => {
        // Setup test database
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        // Clean database before each test
        await prisma.user.deleteMany();
        await prisma.company.deleteMany();
    });

    describe('POST /api/auth/register', () => {
        it('should register a new user and company', async () => {
            const userData = {
                email: 'test@example.com',
                password: 'password123',
                name: 'Test User',
                companyName: 'Test Company'
            };

            const response = await request(app)
                .post('/api/auth/register')
                .send(userData);

            expect(response.status).toBe(201);
            expect(response.body).toHaveProperty('token');
            expect(response.body.user.email).toBe(userData.email);
            expect(response.body.user.role).toBe('OWNER');
        });

        it('should not register user with invalid email', async () => {
            const userData = {
                email: 'invalid-email',
                password: 'password123',
                name: 'Test User',
                companyName: 'Test Company'
            };

            const response = await request(app)
                .post('/api/auth/register')
                .send(userData);

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty('errors');
        });

        it('should not register user with duplicate email', async () => {
            const userData = {
                email: 'test@example.com',
                password: 'password123',
                name: 'Test User',
                companyName: 'Test Company'
            };

            // First registration
            await request(app)
                .post('/api/auth/register')
                .send(userData);

            // Second registration with same email
            const response = await request(app)
                .post('/api/auth/register')
                .send(userData);

            expect(response.status).toBe(400);
            expect(response.body.error).toContain('já cadastrado');
        });
    });

    describe('POST /api/auth/login', () => {
        let testUser;

        beforeEach(async () => {
            // Create test user
            const userData = {
                email: 'test@example.com',
                password: 'password123',
                name: 'Test User',
                companyName: 'Test Company'
            };

            const response = await request(app)
                .post('/api/auth/register')
                .send(userData);

            testUser = response.body.user;
        });

        it('should login with valid credentials', async () => {
            const response = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'test@example.com',
                    password: 'password123'
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('token');
            expect(response.body.user.email).toBe('test@example.com');
        });

        it('should not login with invalid credentials', async () => {
            const response = await request(app)
                .post('/api/auth/login')
                .send({
                    email: 'test@example.com',
                    password: 'wrongpassword'
                });

            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Credenciais inválidas');
        });
    });
});

// __tests__/chat.test.js
const request = require('supertest');
const app = require('../src/server');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

describe('Chat API', () => {
    let authToken;
    let testUser;
    let testCompany;
    let testConversation;

    beforeAll(async () => {
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        // Clean database
        await prisma.message.deleteMany();
        await prisma.conversation.deleteMany();
        await prisma.contact.deleteMany();
        await prisma.user.deleteMany();
        await prisma.company.deleteMany();

        // Create test user and company
        const userData = {
            email: 'test@example.com',
            password: 'password123',
            name: 'Test User',
            companyName: 'Test Company'
        };

        const registerResponse = await request(app)
            .post('/api/auth/register')
            .send(userData);

        authToken = registerResponse.body.token;
        testUser = registerResponse.body.user;
        testCompany = registerResponse.body.user.company;

        // Create test contact and conversation
        const contact = await prisma.contact.create({
            data: {
                phone: '5511999999999',
                name: 'Test Contact'
            }
        });

        testConversation = await prisma.conversation.create({
            data: {
                contactId: contact.id,
                companyId: testCompany.id,
                status: 'OPEN',
                channel: 'WHATSAPP'
            }
        });

        // Assign user to conversation
        await prisma.conversationAgent.create({
            data: {
                conversationId: testConversation.id,
                userId: testUser.id,
                isActive: true
            }
        });
    });

    describe('GET /api/chat/conversations', () => {
        it('should return conversations for authenticated user', async () => {
            const response = await request(app)
                .get('/api/chat/conversations')
                .set('Authorization', `Bearer ${authToken}`);

            expect(response.status).toBe(200);
            expect(response.body).toBeInstanceOf(Array);
            expect(response.body.length).toBe(1);
            expect(response.body[0].id).toBe(testConversation.id);
        });

        it('should require authentication', async () => {
            const response = await request(app)
                .get('/api/chat/conversations');

            expect(response.status).toBe(401);
        });
    });

    describe('POST /api/chat/conversations/:id/messages', () => {
        it('should send a message', async () => {
            const messageData = {
                content: 'Test message',
                type: 'TEXT'
            };

            const response = await request(app)
                .post(`/api/chat/conversations/${testConversation.id}/messages`)
                .set('Authorization', `Bearer ${authToken}`)
                .send(messageData);

            expect(response.status).toBe(201);
            expect(response.body.content).toBe(messageData.content);
            expect(response.body.direction).toBe('OUTBOUND');
        });

        it('should not send message to unauthorized conversation', async () => {
            // Create another conversation without assigning user
            const anotherContact = await prisma.contact.create({
                data: {
                    phone: '5511888888888',
                    name: 'Another Contact'
                }
            });

            const anotherConversation = await prisma.conversation.create({
                data: {
                    contactId: anotherContact.id,
                    companyId: testCompany.id,
                    status: 'OPEN',
                    channel: 'WHATSAPP'
                }
            });

            const messageData = {
                content: 'Unauthorized message',
                type: 'TEXT'
            };

            const response = await request(app)
                .post(`/api/chat/conversations/${anotherConversation.id}/messages`)
                .set('Authorization', `Bearer ${authToken}`)
                .send(messageData);

            expect(response.status).toBe(403);
        });
    });
});

// __tests__/campaigns.test.js
const request = require('supertest');
const app = require('../src/server');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

describe('Campaigns API', () => {
    let authToken;
    let testUser;

    beforeAll(async () => {
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.campaign.deleteMany();
        await prisma.user.deleteMany();
        await prisma.company.deleteMany();

        // Create admin user
        const userData = {
            email: 'admin@example.com',
            password: 'password123',
            name: 'Admin User',
            companyName: 'Test Company'
        };

        const registerResponse = await request(app)
            .post('/api/auth/register')
            .send(userData);

        authToken = registerResponse.body.token;
        testUser = registerResponse.body.user;
    });

    describe('POST /api/campaigns', () => {
        it('should create a new campaign', async () => {
            const campaignData = {
                name: 'Test Campaign',
                content: 'Hello, this is a test message!',
                recipients: [
                    { phone: '5511999999999', name: 'Test User 1' },
                    { phone: '5511888888888', name: 'Test User 2' }
                ]
            };

            const response = await request(app)
                .post('/api/campaigns')
                .set('Authorization', `Bearer ${authToken}`)
                .send(campaignData);

            expect(response.status).toBe(201);
            expect(response.body.name).toBe(campaignData.name);
            expect(response.body.status).toBe('DRAFT');
        });

        it('should validate phone numbers', async () => {
            const campaignData = {
                name: 'Test Campaign',
                content: 'Hello!',
                recipients: [
                    { phone: 'invalid-phone', name: 'Invalid User' }
                ]
            };

            const response = await request(app)
                .post('/api/campaigns')
                .set('Authorization', `Bearer ${authToken}`)
                .send(campaignData);

            expect(response.status).toBe(400);
            expect(response.body.error).toContain('inválidos');
        });
    });
});

// jest.config.js
module.exports = {
    testEnvironment: 'node',
    setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
    testMatch: ['**/__tests__/**/*.test.js'],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/server.js',
        '!src/database/seed.js'
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    testTimeout: 30000
};

// __tests__/setup.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/chatflow_test'
        }
    }
});

beforeAll(async () => {
    // Executar migrações de teste
    await prisma.$executeRaw`DROP SCHEMA IF EXISTS public CASCADE`;
    await prisma.$executeRaw`CREATE SCHEMA public`;

    // Aqui você executaria as migrações do Prisma
    // Em um ambiente real, use: await prisma.$migrate.deploy();
});

afterAll(async () => {
    await prisma.$disconnect();
});

// src/database/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Iniciando seed do banco de dados...');

    // Criar empresa demo
    const demoCompany = await prisma.company.create({
        data: {
            name: 'ChatFlow Demo',
            email: 'demo@chatflow.com',
            phone: '11999999999',
            plan: 'BUSINESS',
            status: 'ACTIVE',
            maxAgents: 15,
            maxMessages: 5000,
            hasAI: true,
            hasAnalytics: true
        }
    });

    // Criar departamento padrão
    const department = await prisma.department.create({
        data: {
            name: 'Atendimento',
            description: 'Departamento principal de atendimento',
            isDefault: true,
            companyId: demoCompany.id
        }
    });

    // Criar usuário admin
    const hashedPassword = await bcrypt.hash('admin123', 12);
    const adminUser = await prisma.user.create({
        data: {
            email: 'admin@chatflow.com',
            name: 'Administrador',
            password: hashedPassword,
            role: 'OWNER',
            companyId: demoCompany.id,
            departmentId: department.id
        }
    });

    // Criar alguns agentes
    const agents = await Promise.all([
        prisma.user.create({
            data: {
                email: 'maria@chatflow.com',
                name: 'Maria Santos',
                password: await bcrypt.hash('agent123', 12),
                role: 'AGENT',
                companyId: demoCompany.id,
                departmentId: department.id
            }
        }),
        prisma.user.create({
            data: {
                email: 'carlos@chatflow.com',
                name: 'Carlos Lima',
                password: await bcrypt.hash('agent123', 12),
                role: 'AGENT',
                companyId: demoCompany.id,
                departmentId: department.id
            }
        })
    ]);

    // Criar chatbot demo
    const { ChatbotBuilder } = require('../services/chatbotBuilder');
    const chatbot = await prisma.chatbot.create({
        data: {
            name: 'Assistente Virtual',
            description: 'Chatbot principal para atendimento',
            config: ChatbotBuilder.createBasicTemplate(),
            isActive: true,
            companyId: demoCompany.id,
            departmentId: department.id
        }
    });

    // Criar alguns contatos demo
    const contacts = await Promise.all([
        prisma.contact.create({
            data: {
                phone: '5511999999999',
                name: 'João Silva',
                email: 'joao@email.com'
            }
        }),
        prisma.contact.create({
            data: {
                phone: '5511888888888',
                name: 'Ana Costa',
                email: 'ana@email.com'
            }
        })
    ]);

    console.log('✅ Seed concluído!');
    console.log(`👤 Admin criado: admin@chatflow.com / admin123`);
    console.log(`🏢 Empresa: ${demoCompany.name}`);
    console.log(`🤖 Chatbot: ${chatbot.name}`);
    console.log(`👥 Agentes: ${agents.length}`);
    console.log(`📞 Contatos: ${contacts.length}`);
}

main()
    .catch((e) => {
        console.error('❌ Erro no seed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });