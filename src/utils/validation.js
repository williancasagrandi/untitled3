// src/utils/validation.js
const Joi = require('joi');

// Esquemas de validação
const schemas = {
    // Auth
    register: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().min(6).required(),
        name: Joi.string().min(2).max(100).required(),
        companyName: Joi.string().min(2).max(100).required(),
        phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).optional()
    }),

    login: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().required()
    }),

    // Users
    createUser: Joi.object({
        email: Joi.string().email().required(),
        name: Joi.string().min(2).max(100).required(),
        password: Joi.string().min(6).required(),
        role: Joi.string().valid('AGENT', 'MANAGER', 'ADMIN', 'OWNER').required(),
        departmentId: Joi.string().uuid().optional()
    }),

    updateUser: Joi.object({
        name: Joi.string().min(2).max(100).optional(),
        email: Joi.string().email().optional(),
        role: Joi.string().valid('AGENT', 'MANAGER', 'ADMIN', 'OWNER').optional(),
        departmentId: Joi.string().uuid().optional(),
        status: Joi.string().valid('ACTIVE', 'INACTIVE').optional()
    }),

    // Departments
    createDepartment: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        description: Joi.string().max(500).optional()
    }),

    updateDepartment: Joi.object({
        name: Joi.string().min(2).max(100).optional(),
        description: Joi.string().max(500).optional()
    }),

    // Messages
    sendMessage: Joi.object({
        content: Joi.string().min(1).max(4000).required(),
        type: Joi.string().valid('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT').optional()
    }),

    // Chatbots
    createChatbot: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        description: Joi.string().max(500).optional(),
        departmentId: Joi.string().uuid().optional(),
        config: Joi.object({
            welcome_message: Joi.string().max(500).optional(),
            fallback_message: Joi.string().max(500).optional(),
            transfer_keywords: Joi.array().items(Joi.string()).optional(),
            business_hours: Joi.object({
                enabled: Joi.boolean().optional(),
                timezone: Joi.string().optional(),
                schedule: Joi.object().optional()
            }).optional(),
            personality: Joi.object({
                tone: Joi.string().valid('formal', 'casual', 'friendly').optional(),
                language: Joi.string().optional()
            }).optional()
        }).optional()
    }),

    updateChatbot: Joi.object({
        name: Joi.string().min(2).max(100).optional(),
        description: Joi.string().max(500).optional(),
        departmentId: Joi.string().uuid().optional(),
        isActive: Joi.boolean().optional(),
        config: Joi.object({
            welcome_message: Joi.string().max(500).optional(),
            fallback_message: Joi.string().max(500).optional(),
            transfer_keywords: Joi.array().items(Joi.string()).optional(),
            business_hours: Joi.object({
                enabled: Joi.boolean().optional(),
                timezone: Joi.string().optional(),
                schedule: Joi.object().optional()
            }).optional(),
            personality: Joi.object({
                tone: Joi.string().valid('formal', 'casual', 'friendly').optional(),
                language: Joi.string().optional()
            }).optional()
        }).optional()
    }),

    // Campaigns
    createCampaign: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        content: Joi.string().min(1).max(4000).required(),
        recipients: Joi.array().items(
            Joi.object({
                name: Joi.string().optional(),
                phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required()
            })
        ).min(1).required(),
        scheduledAt: Joi.date().min('now').optional()
    }),

    // WhatsApp
    connectWhatsApp: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        departmentId: Joi.string().uuid().optional()
    }),

    // Contacts
    createContact: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required(),
        email: Joi.string().email().optional(),
        tags: Joi.array().items(Joi.string()).optional(),
        metadata: Joi.object().optional()
    }),

    updateContact: Joi.object({
        name: Joi.string().min(2).max(100).optional(),
        email: Joi.string().email().optional(),
        tags: Joi.array().items(Joi.string()).optional(),
        metadata: Joi.object().optional()
    }),

    // Company settings
    updateCompany: Joi.object({
        name: Joi.string().min(2).max(100).optional(),
        email: Joi.string().email().optional(),
        phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).optional(),
        website: Joi.string().uri().optional(),
        address: Joi.string().max(500).optional(),
        settings: Joi.object({
            businessHours: Joi.object({
                enabled: Joi.boolean().optional(),
                timezone: Joi.string().optional(),
                schedule: Joi.object({
                    monday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional(),
                    tuesday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional(),
                    wednesday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional(),
                    thursday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional(),
                    friday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional(),
                    saturday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional(),
                    sunday: Joi.object({ start: Joi.string(), end: Joi.string() }).optional()
                }).optional()
            }).optional(),
            autoAssignment: Joi.object({
                enabled: Joi.boolean().optional(),
                strategy: Joi.string().valid('round_robin', 'least_conversations', 'random').optional()
            }).optional(),
            notifications: Joi.object({
                email: Joi.boolean().optional(),
                push: Joi.boolean().optional(),
                sound: Joi.boolean().optional()
            }).optional()
        }).optional()
    })
};

// Middleware de validação
const validate = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));

            return res.status(400).json({
                error: 'Dados de entrada inválidos',
                details: errors
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