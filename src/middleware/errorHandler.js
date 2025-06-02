// src/middleware/errorHandler.js
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log do erro
    logger.error(`Error ${err.message}`, {
        error: err,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });

    // Erro do Prisma
    if (err.code === 'P2002') {
        const message = 'Recurso duplicado';
        error = { message, statusCode: 400 };
    }

    // Erro de validação do Prisma
    if (err.code === 'P2025') {
        const message = 'Recurso não encontrado';
        error = { message, statusCode: 404 };
    }

    // Erro de JWT
    if (err.name === 'JsonWebTokenError') {
        const message = 'Token inválido';
        error = { message, statusCode: 401 };
    }

    // Erro de JWT expirado
    if (err.name === 'TokenExpiredError') {
        const message = 'Token expirado';
        error = { message, statusCode: 401 };
    }

    // Erro de validação
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message);
        error = { message, statusCode: 400 };
    }

    res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || 'Erro interno do servidor'
    });
};

module.exports = { errorHandler };