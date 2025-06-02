// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Middleware de autenticação
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Token de acesso requerido' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Verificar se a sessão ainda é válida
        const session = await prisma.userSession.findUnique({
            where: { token },
            include: {
                user: {
                    include: {
                        company: true,
                        department: true
                    }
                }
            }
        });

        if (!session || session.expiresAt < new Date()) {
            return res.status(401).json({ error: 'Token expirado ou inválido' });
        }

        if (session.user.status !== 'ACTIVE' || session.user.company.status === 'SUSPENDED') {
            return res.status(403).json({ error: 'Conta inativa ou suspensa' });
        }

        req.user = session.user;
        req.token = token;
        next();

    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Token inválido' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expirado' });
        }
        console.error('Auth middleware error:', error);
        return res.status(500).json({ error: 'Erro interno do servidor' });
    }
};

// Middleware para verificar roles
const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Usuário não autenticado' });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Permissão insuficiente' });
        }

        next();
    };
};

// Middleware para verificar plano da empresa
const requirePlan = (...plans) => {
    return (req, res, next) => {
        if (!req.user || !req.user.company) {
            return res.status(401).json({ error: 'Empresa não identificada' });
        }

        if (!plans.includes(req.user.company.plan)) {
            return res.status(403).json({
                error: 'Recurso não disponível no seu plano',
                currentPlan: req.user.company.plan,
                requiredPlans: plans
            });
        }

        next();
    };
};

// Middleware para verificar limites do plano
const checkPlanLimits = (resource) => {
    return async (req, res, next) => {
        try {
            const company = req.user.company;

            switch (resource) {
                case 'agents':
                    const agentCount = await prisma.user.count({
                        where: {
                            companyId: company.id,
                            status: 'ACTIVE',
                            role: { in: ['AGENT', 'MANAGER'] }
                        }
                    });

                    if (agentCount >= company.maxAgents) {
                        return res.status(403).json({
                            error: 'Limite de agentes atingido',
                            current: agentCount,
                            limit: company.maxAgents
                        });
                    }
                    break;

                case 'messages':
                    const currentMonth = new Date();
                    currentMonth.setDate(1);
                    currentMonth.setHours(0, 0, 0, 0);

                    const messageCount = await prisma.message.count({
                        where: {
                            conversation: { companyId: company.id },
                            timestamp: { gte: currentMonth }
                        }
                    });

                    if (messageCount >= company.maxMessages) {
                        return res.status(403).json({
                            error: 'Limite de mensagens mensais atingido',
                            current: messageCount,
                            limit: company.maxMessages
                        });
                    }
                    break;

                case 'ai':
                    if (!company.hasAI) {
                        return res.status(403).json({
                            error: 'Recurso de IA não disponível no seu plano'
                        });
                    }
                    break;
            }

            next();
        } catch (error) {
            console.error('Plan limits check error:', error);
            res.status(500).json({ error: 'Erro ao verificar limites do plano' });
        }
    };
};

module.exports = {
    authenticateToken,
    requireRole,
    requirePlan,
    checkPlanLimits
};

// src/middleware/rateLimiter.js
const { RateLimiterRedis } = require('rate-limiter-flexible');
const Redis = require('redis');

const redisClient = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Rate limiter para API geral
const apiLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyGenerator: (req) => req.ip,
    points: 100, // Número de requests
    duration: 60, // Por minuto
});

// Rate limiter para login
const loginLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyGenerator: (req) => `login_${req.ip}`,
    points: 5, // 5 tentativas
    duration: 900, // 15 minutos
    blockDuration: 900, // Bloquear por 15 minutos
});

// Rate limiter para envio de mensagens
const messageLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyGenerator: (req) => `messages_${req.user?.companyId || req.ip}`,
    points: 1000, // 1000 mensagens
    duration: 3600, // Por hora
});

const rateLimiter = async (req, res, next) => {
    try {
        await apiLimiter.consume(req.ip);
        next();
    } catch (rejRes) {
        const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
        res.set('Retry-After', String(secs));
        res.status(429).json({
            error: 'Muitas requisições. Tente novamente em alguns segundos.',
            retryAfter: secs
        });
    }
};

const loginRateLimit = async (req, res, next) => {
    try {
        await loginLimiter.consume(req.ip);
        next();
    } catch (rejRes) {
        const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
        res.status(429).json({
            error: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
            retryAfter: secs
        });
    }
};

const messageRateLimit = async (req, res, next) => {
    try {
        await messageLimiter.consume(req.user?.companyId || req.ip);
        next();
    } catch (rejRes) {
        const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
        res.status(429).json({
            error: 'Limite de mensagens por hora atingido.',
            retryAfter: secs
        });
    }
};

module.exports = {
    rateLimiter,
    loginRateLimit,
    messageRateLimit
};

// src/middleware/errorHandler.js
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
    logger.error('Unhandled error:', {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id,
        companyId: req.user?.companyId
    });

    // Prisma errors
    if (err.code === 'P2002') {
        return res.status(400).json({
            error: 'Dados duplicados. Verifique se as informações já existem.'
        });
    }

    if (err.code === 'P2025') {
        return res.status(404).json({
            error: 'Registro não encontrado.'
        });
    }

    // Validation errors
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Dados inválidos',
            details: err.details
        });
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            error: 'Token inválido'
        });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            error: 'Token expirado'
        });
    }

    // Multer errors (upload)
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
            error: 'Arquivo muito grande. Tamanho máximo: 10MB'
        });
    }

    // Default error
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production'
            ? 'Erro interno do servidor'
            : err.message
    });
};

module.exports = { errorHandler };

// src/utils/logger.js
const winston = require('winston');

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'chatflow-api' },
    transports: [
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: 5242880,
            maxFiles: 5
        })
    ]
});

// Em desenvolvimento, log no console também
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

module.exports = logger;

// src/utils/validation.js
const Joi = require('joi');

// Schemas de validação
const schemas = {
    // Usuário
    createUser: Joi.object({
        email: Joi.string().email().required(),
        name: Joi.string().min(2).max(100).required(),
        password: Joi.string().min(6).max(128).required(),
        role: Joi.string().valid('OWNER', 'ADMIN', 'MANAGER', 'AGENT').default('AGENT'),
        phone: Joi.string().pattern(/^\+?[\d\s\-\(\)]+$/).optional(),
        departmentId: Joi.string().uuid().optional()
    }),

    updateUser: Joi.object({
        name: Joi.string().min(2).max(100).optional(),
        phone: Joi.string().pattern(/^\+?[\d\s\-\(\)]+$/).optional(),
        role: Joi.string().valid('OWNER', 'ADMIN', 'MANAGER', 'AGENT').optional(),
        status: Joi.string().valid('ACTIVE', 'INACTIVE', 'SUSPENDED').optional(),
        departmentId: Joi.string().uuid().optional(),
        workSchedule: Joi.object().optional()
    }),

    // Conversa
    sendMessage: Joi.object({
        content: Joi.string().min(1).max(4000).required(),
        type: Joi.string().valid('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT').default('TEXT'),
        mediaUrl: Joi.string().uri().optional()
    }),

    closeConversation: Joi.object({
        rating: Joi.number().integer().min(1).max(5).optional(),
        feedback: Joi.string().max(1000).optional()
    }),

    // Campanha
    createCampaign: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        content: Joi.string().min(1).max(4000).required(),
        recipients: Joi.array().items(
            Joi.object({
                phone: Joi.string().required(),
                name: Joi.string().optional()
            })
        ).min(1).required(),
        scheduledAt: Joi.date().greater('now').optional()
    }),

    // Chatbot
    createChatbot: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        description: Joi.string().max(500).optional(),
        config: Joi.object().required(),
        departmentId: Joi.string().uuid().optional()
    }),

    // Departamento
    createDepartment: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        description: Joi.string().max(500).optional(),
        color: Joi.string().pattern(/^#[0-9A-F]{6}$/i).default('#3B82F6')
    })
};

// Middleware de validação
const validate = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, { abortEarly: false });

        if (error) {
            const details = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));

            return res.status(400).json({
                error: 'Dados inválidos',
                details
            });
        }

        req.body = value;
        next();
    };
};

module.exports = {
    schemas,
    validate
};

// src/utils/helpers.js
const crypto = require('crypto');

// Gerar código aleatório
const generateCode = (length = 6) => {
    return crypto.randomBytes(length).toString('hex').slice(0, length).toUpperCase();
};

// Formatar telefone brasileiro
const formatPhone = (phone) => {
    const cleaned = phone.replace(/\D/g, '');

    // Adicionar código do país se não tiver
    if (cleaned.length === 11 && cleaned.startsWith('11')) {
        return `55${cleaned}`;
    }
    if (cleaned.length === 10 && cleaned.startsWith('1')) {
        return `5511${cleaned}`;
    }
    if (cleaned.length === 11 && !cleaned.startsWith('55')) {
        return `55${cleaned}`;
    }

    return cleaned;
};

// Validar telefone brasileiro
const isValidBrazilianPhone = (phone) => {
    const cleaned = phone.replace(/\D/g, '');
    return /^55\d{10,11}$/.test(cleaned);
};

// Gerar slug
const generateSlug = (text) => {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove acentos
        .replace(/[^a-z0-9\s-]/g, '') // Remove caracteres especiais
        .replace(/\s+/g, '-') // Substitui espaços por hífens
        .replace(/-+/g, '-') // Remove hífens duplicados
        .trim('-'); // Remove hífens das extremidades
};

// Calcular tempo de resposta médio
const calculateAverageResponseTime = (conversations) => {
    let totalTime = 0;
    let count = 0;

    conversations.forEach(conv => {
        if (conv.messages && conv.messages.length >= 2) {
            for (let i = 1; i < conv.messages.length; i++) {
                const prevMsg = conv.messages[i - 1];
                const currentMsg = conv.messages[i];

                if (prevMsg.direction === 'INBOUND' && currentMsg.direction === 'OUTBOUND') {
                    const timeDiff = new Date(currentMsg.timestamp) - new Date(prevMsg.timestamp);
                    totalTime += timeDiff;
                    count++;
                }
            }
        }
    });

    return count > 0 ? Math.round(totalTime / count / 1000 / 60) : 0; // em minutos
};

// Sanitizar entrada do usuário
const sanitizeInput = (input) => {
    if (typeof input !== 'string') return input;

    return input
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
        .replace(/<[^>]*>?/gm, '') // Remove tags HTML
        .trim();
};

// Mascarar dados sensíveis
const maskSensitiveData = (data, fields = ['password', 'token', 'secret']) => {
    const masked = { ...data };

    fields.forEach(field => {
        if (masked[field]) {
            masked[field] = '***';
        }
    });

    return masked;
};

// Delay para rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    generateCode,
    formatPhone,
    isValidBrazilianPhone,
    generateSlug,
    calculateAverageResponseTime,
    sanitizeInput,
    maskSensitiveData,
    delay
};