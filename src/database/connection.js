// src/database/connection.js
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

let prisma = null;

async function initializeDatabase() {
    try {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is not set');
        }

        prisma = new PrismaClient({
            log: ['error', 'warn'],
            errorFormat: 'pretty',
        });

        // Testar conexão
        await prisma.$connect();

        logger.info('Database connected successfully');
        return prisma;
    } catch (error) {
        logger.error('Failed to connect to database:', error);
        throw error;
    }
}

async function disconnectDatabase() {
    if (prisma) {
        await prisma.$disconnect();
        logger.info('Database disconnected');
    }
}

function getPrismaClient() {
    if (!prisma) {
        throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return prisma;
}

module.exports = {
    initializeDatabase,
    disconnectDatabase,
    getPrismaClient
};