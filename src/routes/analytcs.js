// src/routes/analytics.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, requirePlan } = require('../middleware/auth');
const { analyticsService } = require('../services/analyticsService');

const router = express.Router();
const prisma = new PrismaClient();

router.use(authenticateToken);
router.use(requirePlan('PROFESSIONAL', 'ENTERPRISE', 'CUSTOM'));

// Dashboard principal
router.get('/dashboard', async (req, res) => {
    try {
        const { dateRange = 30 } = req.query;
        const stats = await analyticsService.getDashboardStats(
            req.user.companyId,
            parseInt(dateRange)
        );
        res.json(stats);
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Erro ao buscar estatísticas' });
    }
});

// Relatório de conversas
router.get('/conversations', async (req, res) => {
    try {
        const options = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            departmentId: req.query.departmentId,
            agentId: req.query.agentId
        };

        const report = await analyticsService.getConversationsReport(
            req.user.companyId,
            options
        );
        res.json(report);
    } catch (error) {
        console.error('Error fetching conversations report:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório de conversas' });
    }
});

// Relatório de performance dos agentes
router.get('/agents-performance', async (req, res) => {
    try {
        const options = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            departmentId: req.query.departmentId
        };

        const report = await analyticsService.getAgentsPerformanceReport(
            req.user.companyId,
            options
        );
        res.json(report);
    } catch (error) {
        console.error('Error fetching agents performance:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório de performance' });
    }
});

// Tempo de resposta
router.get('/response-time', async (req, res) => {
    try {
        const options = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            groupBy: req.query.groupBy || 'day'
        };

        const report = await analyticsService.getResponseTimeReport(
            req.user.companyId,
            options
        );
        res.json(report);
    } catch (error) {
        console.error('Error fetching response time report:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório de tempo de resposta' });
    }
});

// Satisfação do cliente
router.get('/satisfaction', async (req, res) => {
    try {
        const options = {
            startDate: req.query.startDate,
            endDate: req.query.endDate
        };

        const report = await analyticsService.getSatisfactionReport(
            req.user.companyId,
            options
        );
        res.json(report);
    } catch (error) {
        console.error('Error fetching satisfaction report:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório de satisfação' });
    }
});

// Volume de mensagens
router.get('/message-volume', async (req, res) => {
    try {
        const options = {
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            groupBy: req.query.groupBy || 'day'
        };

        const report = await analyticsService.getMessageVolumeReport(
            req.user.companyId,
            options
        );
        res.json(report);
    } catch (error) {
        console.error('Error fetching message volume report:', error);
        res.status(500).json({ error: 'Erro ao gerar relatório de volume de mensagens' });
    }
});

// Exportar relatório
router.post('/export', async (req, res) => {
    try {
        const { reportType, format = 'csv', options = {} } = req.body;

        const exportData = await analyticsService.exportReport(
            req.user.companyId,
            reportType,
            options
        );

        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${reportType}-${Date.now()}.csv"`);
            res.send(exportData);
        } else {
            res.json(exportData);
        }

    } catch (error) {
        console.error('Error exporting report:', error);
        res.status(500).json({ error: 'Erro ao exportar relatório' });
    }
});

module.exports = router;