// src/middleware/rateLimiter.js
const { RateLimiterRedis } = require('rate-limiter-flexible');
const Redis = require('redis');
const logger = require('../utils/logger');

let redisClient;

// Inicializar Redis
async function initializeRedis() {
    try {
        redisClient = Redis.createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379'
        });

        redisClient.on('error', (err) => {
            logger.error('Redis Client Error', err);
        });

        await redisClient.connect();
        logger.info('Redis connected successfully');
        return redisClient;
    } catch (error) {
        logger.error('Failed to connect to Redis:', error);
        throw error;
    }
}

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

// Middleware principal
const rateLimiter = async (req, res, next) => {
    try {
        if (!redisClient) {
            await initializeRedis();
        }

        await apiLimiter.consume(req.ip);
        next();
    } catch (rejRes) {
        res.status(429).json({
            error: 'Muitas requisições. Tente novamente em alguns minutos.',
            retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 60
        });
    }
};

// Middleware para login
const loginRateLimit = async (req, res, next) => {
    try {
        await loginLimiter.consume(req.ip);
        next();
    } catch (rejRes) {
        res.status(429).json({
            error: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
            retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 900
        });
    }
};

// Middleware para mensagens
const messageRateLimit = async (req, res, next) => {
    try {
        await messageLimiter.consume(req.user?.companyId || req.ip);
        next();
    } catch (rejRes) {
        res.status(429).json({
            error: 'Limite de mensagens atingido. Tente novamente em uma hora.',
            retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 3600
        });
    }
};

module.exports = {
    rateLimiter,
    loginRateLimit,
    messageRateLimit,
    initializeRedis
};