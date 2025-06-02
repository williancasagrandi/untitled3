// src/services/automationService.js
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const logger = require('../utils/logger');
const { notifyCompany } = require('./socket');
const cron = require('node-cron');

const prisma = new PrismaClient();

class AutomationService {
    constructor() {
        this.workflows = new Map();
        this.triggers = new Map();
        this.conditions = new Map();
        this.actions = new Map();
        this.executionQueue = [];
        this.isProcessing = false;

        this.initializeBuiltInComponents();
        this.startWorkflowEngine();
    }

    initializeBuiltInComponents() {
        // Triggers disponíveis
        this.triggers.set('message_received', {
            name: 'Mensagem Recebida',
            description: 'Disparado quando uma nova mensagem é recebida',
            parameters: ['channel', 'keyword', 'sender_type'],
            realtime: true
        });

        this.triggers.set('conversation_created', {
            name: 'Nova Conversa',
            description: 'Disparado quando uma nova conversa é iniciada',
            parameters: ['channel', 'department', 'source'],
            realtime: true
        });

        this.triggers.set('time_based', {
            name: 'Baseado em Tempo',
            description: 'Disparado em intervalos específicos',
            parameters: ['cron_expression', 'timezone'],
            realtime: false
        });

        this.triggers.set('customer_action', {
            name: 'Ação do Cliente',
            description: 'Disparado por ações específicas do cliente',
            parameters: ['action_type', 'timeframe'],
            realtime: true
        });

        this.triggers.set('agent_action', {
            name: 'Ação do Agente',
            description: 'Disparado por ações do agente',
            parameters: ['action_type', 'agent_id'],
            realtime: true
        });

        // Condições disponíveis
        this.conditions.set('sentiment_analysis', {
            name: 'Análise de Sentimento',
            description: 'Verifica o sentimento da mensagem',
            parameters: ['sentiment', 'confidence_threshold'],
            evaluate: this.evaluateSentimentCondition.bind(this)
        });

        this.conditions.set('customer_data', {
            name: 'Dados do Cliente',
            description: 'Verifica dados específicos do cliente',
            parameters: ['field', 'operator', 'value'],
            evaluate: this.evaluateCustomerDataCondition.bind(this)
        });

        this.conditions.set('conversation_history', {
            name: 'Histórico da Conversa',
            description: 'Verifica histórico de interações',
            parameters: ['message_count', 'timeframe', 'status'],
            evaluate: this.evaluateConversationHistoryCondition.bind(this)
        });

        this.conditions.set('business_hours', {
            name: 'Horário Comercial',
            description: 'Verifica se está dentro do horário comercial',
            parameters: ['timezone', 'schedule'],
            evaluate: this.evaluateBusinessHoursCondition.bind(this)
        });

        this.conditions.set('agent_availability', {
            name: 'Disponibilidade de Agentes',
            description: 'Verifica se há agentes disponíveis',
            parameters: ['department', 'min_agents'],
            evaluate: this.evaluateAgentAvailabilityCondition.bind(this)
        });

        // Ações disponíveis
        this.actions.set('send_message', {
            name: 'Enviar Mensagem',
            description: 'Envia uma mensagem para o cliente',
            parameters: ['content', 'channel', 'delay'],
            execute: this.executeSendMessageAction.bind(this)
        });

        this.actions.set('assign_agent', {
            name: 'Atribuir Agente',
            description: 'Atribui a conversa a um agente específico',
            parameters: ['agent_id', 'department_id'],
            execute: this.executeAssignAgentAction.bind(this)
        });

        this.actions.set('add_tag', {
            name: 'Adicionar Tag',
            description: 'Adiciona uma tag ao cliente ou conversa',
            parameters: ['tag', 'target'],
            execute: this.executeAddTagAction.bind(this)
        });

        this.actions.set('create_ticket', {
            name: 'Criar Ticket',
            description: 'Cria um ticket no sistema',
            parameters: ['title', 'priority', 'description'],
            execute: this.executeCreateTicketAction.bind(this)
        });

        this.actions.set('webhook_call', {
            name: 'Chamar Webhook',
            description: 'Faz uma chamada HTTP para um webhook externo',
            parameters: ['url', 'method', 'headers', 'body'],
            execute: this.executeWebhookAction.bind(this)
        });

        this.actions.set('update_crm', {
            name: 'Atualizar CRM',
            description: 'Atualiza dados no CRM',
            parameters: ['crm_type', 'record_id', 'fields'],
            execute: this.executeUpdateCRMAction.bind(this)
        });

        this.actions.set('schedule_followup', {
            name: 'Agendar Follow-up',
            description: 'Agenda um follow-up automático',
            parameters: ['delay', 'message', 'agent_id'],
            execute: this.executeScheduleFollowupAction.bind(this)
        });
    }

    // Criar workflow personalizado
    async createWorkflow(companyId, workflowData) {
        try {
            const {
                name,
                description,
                trigger,
                conditions = [],
                actions = [],
                isActive = true
            } = workflowData;

            // Validar componentes
            await this.validateWorkflowComponents(trigger, conditions, actions);

            // Criar workflow no banco
            const workflow = await prisma.automation.create({
                data: {
                    companyId,
                    name,
                    description,
                    trigger,
                    conditions,
                    actions,
                    isActive,
                    createdBy: workflowData.createdBy,
                    metadata: {
                        version: '1.0',
                        createdAt: new Date(),
                        lastModified: new Date()
                    }
                }
            });

            // Registrar workflow ativo
            if (isActive) {
                await this.registerWorkflow(workflow);
            }

            return workflow;

        } catch (error) {
            logger.error('Error creating workflow:', error);
            throw error;
        }
    }

    // Registrar workflow para execução
    async registerWorkflow(workflow) {
        try {
            this.workflows.set(workflow.id, {
                ...workflow,
                executions: 0,
                lastExecution: null,
                averageExecutionTime: 0
            });

            // Configurar triggers
            await this.setupWorkflowTriggers(workflow);

            logger.info(`Workflow ${workflow.name} registered successfully`);

        } catch (error) {
            logger.error('Error registering workflow:', error);
        }
    }

    // Configurar triggers do workflow
    async setupWorkflowTriggers(workflow) {
        const triggerConfig = workflow.trigger;

        switch (triggerConfig.type) {
            case 'time_based':
                this.setupCronTrigger(workflow, triggerConfig);
                break;
            case 'message_received':
            case 'conversation_created':
            case 'customer_action':
            case 'agent_action':
                // Triggers em tempo real são tratados via eventos
                break;
        }
    }

    // Configurar trigger baseado em tempo
    setupCronTrigger(workflow, triggerConfig) {
        const cronExpression = triggerConfig.parameters.cron_expression;

        cron.schedule(cronExpression, async () => {
            try {
                await this.executeWorkflow(workflow.id, {
                    triggeredBy: 'cron',
                    timestamp: new Date()
                });
            } catch (error) {
                logger.error(`Cron workflow execution error for ${workflow.id}:`, error);
            }
        });
    }

    // Executar workflow
    async executeWorkflow(workflowId, triggerData) {
        try {
            const workflow = this.workflows.get(workflowId);
            if (!workflow || !workflow.isActive) {
                return;
            }

            const startTime = Date.now();
            const executionId = `exec_${workflowId}_${Date.now()}`;

            logger.info(`Starting workflow execution: ${executionId}`);

            // Verificar condições
            const conditionsResult = await this.evaluateConditions(
                workflow.conditions,
                triggerData
            );

            if (!conditionsResult.passed) {
                logger.info(`Workflow ${workflowId} conditions not met: ${conditionsResult.reason}`);
                return;
            }

            // Executar ações
            const actionResults = await this.executeActions(
                workflow.actions,
                triggerData,
                conditionsResult.context
            );

            const executionTime = Date.now() - startTime;

            // Registrar execução
            await this.logWorkflowExecution({
                workflowId,
                executionId,
                triggerData,
                conditionsResult,
                actionResults,
                executionTime,
                success: actionResults.every(r => r.success)
            });

            // Atualizar estatísticas
            await this.updateWorkflowStats(workflowId, executionTime);

            logger.info(`Workflow execution completed: ${executionId} in ${executionTime}ms`);

        } catch (error) {
            logger.error(`Workflow execution error for ${workflowId}:`, error);

            await this.logWorkflowExecution({
                workflowId,
                executionId: `exec_${workflowId}_${Date.now()}`,
                triggerData,
                error: error.message,
                success: false
            });
        }
    }

    // Avaliar condições do workflow
    async evaluateConditions(conditions, triggerData) {
        try {
            const context = { ...triggerData };

            for (const condition of conditions) {
                const conditionHandler = this.conditions.get(condition.type);

                if (!conditionHandler) {
                    throw new Error(`Unknown condition type: ${condition.type}`);
                }

                const result = await conditionHandler.evaluate(condition.parameters, context);

                if (!result.passed) {
                    return {
                        passed: false,
                        reason: `Condition ${condition.type} failed: ${result.reason}`,
                        context
                    };
                }

                // Adicionar dados da condição ao contexto
                Object.assign(context, result.context || {});
            }

            return { passed: true, context };

        } catch (error) {
            return {
                passed: false,
                reason: `Condition evaluation error: ${error.message}`,
                context: triggerData
            };
        }
    }

    // Executar ações do workflow
    async executeActions(actions, triggerData, context) {
        const results = [];

        for (const action of actions) {
            try {
                const actionHandler = this.actions.get(action.type);

                if (!actionHandler) {
                    throw new Error(`Unknown action type: ${action.type}`);
                }

                const result = await actionHandler.execute(action.parameters, {
                    ...triggerData,
                    ...context
                });

                results.push({
                    action: action.type,
                    success: true,
                    result,
                    executedAt: new Date()
                });

                // Delay entre ações se especificado
                if (action.delay) {
                    await new Promise(resolve => setTimeout(resolve, action.delay));
                }

            } catch (error) {
                logger.error(`Action execution error for ${action.type}:`, error);

                results.push({
                    action: action.type,
                    success: false,
                    error: error.message,
                    executedAt: new Date()
                });

                // Se a ação é crítica, parar execução
                if (action.critical) {
                    break;
                }
            }
        }

        return results;
    }

    // Implementação das condições
    async evaluateSentimentCondition(parameters, context) {
        try {
            const { sentiment, confidence_threshold = 0.7 } = parameters;
            const messageContent = context.messageContent || context.content;

            if (!messageContent) {
                return { passed: false, reason: 'No message content to analyze' };
            }

            // Aqui seria integrado com o serviço de IA
            const sentimentAnalysis = await this.analyzeSentiment(messageContent);

            const passed = sentimentAnalysis.sentiment === sentiment &&
                sentimentAnalysis.confidence >= confidence_threshold;

            return {
                passed,
                reason: passed ? 'Sentiment condition met' : `Expected ${sentiment}, got ${sentimentAnalysis.sentiment}`,
                context: { sentimentAnalysis }
            };

        } catch (error) {
            return { passed: false, reason: `Sentiment analysis error: ${error.message}` };
        }
    }

    async evaluateCustomerDataCondition(parameters, context) {
        try {
            const { field, operator, value } = parameters;
            const customerId = context.customerId || context.contactId;

            if (!customerId) {
                return { passed: false, reason: 'No customer ID provided' };
            }

            const customer = await prisma.contact.findUnique({
                where: { id: customerId }
            });

            if (!customer) {
                return { passed: false, reason: 'Customer not found' };
            }

            const fieldValue = this.getNestedValue(customer, field);
            const passed = this.evaluateOperator(fieldValue, operator, value);

            return {
                passed,
                reason: passed ? 'Customer data condition met' : `Field ${field} condition not met`,
                context: { customerData: customer }
            };

        } catch (error) {
            return { passed: false, reason: `Customer data evaluation error: ${error.message}` };
        }
    }

    async evaluateConversationHistoryCondition(parameters, context) {
        try {
            const { message_count, timeframe, status } = parameters;
            const conversationId = context.conversationId;

            if (!conversationId) {
                return { passed: false, reason: 'No conversation ID provided' };
            }

            const startDate = new Date();
            startDate.setDate(startDate.getDate() - (timeframe || 30));

            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId },
                include: {
                    messages: {
                        where: {
                            timestamp: { gte: startDate }
                        }
                    }
                }
            });

            if (!conversation) {
                return { passed: false, reason: 'Conversation not found' };
            }

            const passed = conversation.messages.length >= (message_count || 1) &&
                (!status || conversation.status === status);

            return {
                passed,
                reason: passed ? 'Conversation history condition met' : 'Conversation history condition not met',
                context: { conversationHistory: conversation }
            };

        } catch (error) {
            return { passed: false, reason: `Conversation history evaluation error: ${error.message}` };
        }
    }

    async evaluateBusinessHoursCondition(parameters, context) {
        try {
            const { timezone = 'America/Sao_Paulo', schedule } = parameters;
            const now = new Date();

            // Converter para timezone especificado
            const localTime = new Intl.DateTimeFormat('en', {
                timeZone: timezone,
                hour: '2-digit',
                minute: '2-digit',
                weekday: 'long'
            }).formatToParts(now);

            const hour = parseInt(localTime.find(p => p.type === 'hour').value);
            const weekday = localTime.find(p => p.type === 'weekday').value.toLowerCase();

            // Schedule padrão se não especificado
            const defaultSchedule = {
                monday: { start: 9, end: 18 },
                tuesday: { start: 9, end: 18 },
                wednesday: { start: 9, end: 18 },
                thursday: { start: 9, end: 18 },
                friday: { start: 9, end: 18 },
                saturday: { start: 9, end: 14 },
                sunday: { start: null, end: null }
            };

            const currentSchedule = schedule || defaultSchedule;
            const daySchedule = currentSchedule[weekday];

            const passed = daySchedule &&
                daySchedule.start !== null &&
                hour >= daySchedule.start &&
                hour < daySchedule.end;

            return {
                passed,
                reason: passed ? 'Within business hours' : 'Outside business hours',
                context: { currentTime: { hour, weekday }, schedule: daySchedule }
            };

        } catch (error) {
            return { passed: false, reason: `Business hours evaluation error: ${error.message}` };
        }
    }

    async evaluateAgentAvailabilityCondition(parameters, context) {
        try {
            const { department, min_agents = 1 } = parameters;
            const companyId = context.companyId;

            const whereClause = {
                companyId,
                isOnline: true,
                status: 'ACTIVE',
                role: { in: ['AGENT', 'MANAGER'] }
            };

            if (department) {
                whereClause.departmentId = department;
            }

            const availableAgents = await prisma.user.count({
                where: whereClause
            });

            const passed = availableAgents >= min_agents;

            return {
                passed,
                reason: passed ? 'Agents available' : `Only ${availableAgents} agents available, need ${min_agents}`,
                context: { availableAgents }
            };

        } catch (error) {
            return { passed: false, reason: `Agent availability evaluation error: ${error.message}` };
        }
    }

    // Implementação das ações
    async executeSendMessageAction(parameters, context) {
        try {
            const { content, channel, delay = 0 } = parameters;
            const conversationId = context.conversationId;

            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            // Aqui seria integrado com o serviço de mensagens
            const result = await this.sendAutomatedMessage(conversationId, content, channel);

            return {
                success: true,
                messageId: result.messageId,
                channel: result.channel
            };

        } catch (error) {
            throw new Error(`Send message action failed: ${error.message}`);
        }
    }

    async executeAssignAgentAction(parameters, context) {
        try {
            const { agent_id, department_id } = parameters;
            const conversationId = context.conversationId;

            let agentId = agent_id;

            // Se não especificou agente, encontrar um disponível
            if (!agentId && department_id) {
                const availableAgent = await this.findAvailableAgent(department_id);
                agentId = availableAgent?.id;
            }

            if (!agentId) {
                throw new Error('No agent available for assignment');
            }

            await prisma.conversationAgent.create({
                data: {
                    conversationId,
                    userId: agentId,
                    isActive: true
                }
            });

            await prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'OPEN' }
            });

            return {
                success: true,
                assignedAgentId: agentId
            };

        } catch (error) {
            throw new Error(`Assign agent action failed: ${error.message}`);
        }
    }

    async executeAddTagAction(parameters, context) {
        try {
            const { tag, target = 'contact' } = parameters;
            const targetId = target === 'contact' ? context.contactId : context.conversationId;

            if (target === 'contact') {
                const contact = await prisma.contact.findUnique({
                    where: { id: targetId }
                });

                const updatedTags = [...(contact.tags || []), tag];

                await prisma.contact.update({
                    where: { id: targetId },
                    data: { tags: updatedTags }
                });
            } else {
                // Adicionar tag à conversa
                const conversation = await prisma.conversation.findUnique({
                    where: { id: targetId }
                });

                const updatedMetadata = {
                    ...conversation.metadata,
                    tags: [...(conversation.metadata?.tags || []), tag]
                };

                await prisma.conversation.update({
                    where: { id: targetId },
                    data: { metadata: updatedMetadata }
                });
            }

            return {
                success: true,
                tag,
                target,
                targetId
            };

        } catch (error) {
            throw new Error(`Add tag action failed: ${error.message}`);
        }
    }

    async executeWebhookAction(parameters, context) {
        try {
            const { url, method = 'POST', headers = {}, body } = parameters;

            const requestConfig = {
                method,
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'ChatFlow-Automation/1.0',
                    ...headers
                }
            };

            if (body && (method === 'POST' || method === 'PUT')) {
                requestConfig.data = this.interpolateVariables(body, context);
            }

            const response = await axios(requestConfig);

            return {
                success: true,
                statusCode: response.status,
                responseData: response.data
            };

        } catch (error) {
            throw new Error(`Webhook action failed: ${error.message}`);
        }
    }

    async executeScheduleFollowupAction(parameters, context) {
        try {
            const { delay, message, agent_id } = parameters;
            const conversationId = context.conversationId;

            const executeAt = new Date(Date.now() + delay);

            await prisma.scheduledAction.create({
                data: {
                    type: 'send_followup',
                    conversationId,
                    agentId: agent_id,
                    executeAt,
                    parameters: { message },
                    status: 'PENDING'
                }
            });

            return {
                success: true,
                scheduledAt: executeAt
            };

        } catch (error) {
            throw new Error(`Schedule followup action failed: ${error.message}`);
        }
    }

    // Métodos auxiliares
    getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => current?.[key], obj);
    }

    evaluateOperator(fieldValue, operator, expectedValue) {
        switch (operator) {
            case 'equals': return fieldValue === expectedValue;
            case 'not_equals': return fieldValue !== expectedValue;
            case 'greater_than': return fieldValue > expectedValue;
            case 'less_than': return fieldValue < expectedValue;
            case 'contains': return String(fieldValue).includes(expectedValue);
            case 'starts_with': return String(fieldValue).startsWith(expectedValue);
            case 'ends_with': return String(fieldValue).endsWith(expectedValue);
            case 'is_empty': return !fieldValue;
            case 'is_not_empty': return !!fieldValue;
            default: return false;
        }
    }

    interpolateVariables(text, context) {
        if (typeof text !== 'string') return text;

        return text.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
            const value = this.getNestedValue(context, path);
            return value !== undefined ? value : match;
        });
    }

    async logWorkflowExecution(executionLog) {
        try {
            await prisma.automationExecution.create({
                data: executionLog
            });
        } catch (error) {
            logger.error('Error logging workflow execution:', error);
        }
    }

    async updateWorkflowStats(workflowId, executionTime) {
        try {
            const workflow = this.workflows.get(workflowId);
            if (workflow) {
                workflow.executions++;
                workflow.lastExecution = new Date();
                workflow.averageExecutionTime =
                    (workflow.averageExecutionTime * (workflow.executions - 1) + executionTime) / workflow.executions;
            }
        } catch (error) {
            logger.error('Error updating workflow stats:', error);
        }
    }

    startWorkflowEngine() {
        // Processar ações agendadas a cada minuto
        cron.schedule('* * * * *', async () => {
            await this.processScheduledActions();
        });

        logger.info('Workflow engine started');
    }

    async processScheduledActions() {
        try {
            const now = new Date();
            const pendingActions = await prisma.scheduledAction.findMany({
                where: {
                    status: 'PENDING',
                    executeAt: { lte: now }
                }
            });

            for (const action of pendingActions) {
                try {
                    await this.executeScheduledAction(action);

                    await prisma.scheduledAction.update({
                        where: { id: action.id },
                        data: {
                            status: 'COMPLETED',
                            executedAt: new Date()
                        }
                    });

                } catch (error) {
                    logger.error(`Scheduled action execution error for ${action.id}:`, error);

                    await prisma.scheduledAction.update({
                        where: { id: action.id },
                        data: {
                            status: 'FAILED',
                            error: error.message,
                            executedAt: new Date()
                        }
                    });
                }
            }

        } catch (error) {
            logger.error('Error processing scheduled actions:', error);
        }
    }

    async executeScheduledAction(action) {
        switch (action.type) {
            case 'send_followup':
                await this.sendAutomatedMessage(
                    action.conversationId,
                    action.parameters.message
                );
                break;
            // Adicionar outros tipos de ações agendadas
        }
    }

    // Trigger de eventos em tempo real
    async triggerWorkflows(eventType, eventData) {
        try {
            const relevantWorkflows = Array.from(this.workflows.values())
                .filter(workflow =>
                    workflow.isActive &&
                    workflow.trigger.type === eventType
                );

            for (const workflow of relevantWorkflows) {
                // Verificar se os parâmetros do trigger coincidem
                if (this.matchesTriggerParameters(workflow.trigger, eventData)) {
                    await this.executeWorkflow(workflow.id, eventData);
                }
            }

        } catch (error) {
            logger.error('Error triggering workflows:', error);
        }
    }

    matchesTriggerParameters(trigger, eventData) {
        const parameters = trigger.parameters || {};

        for (const [key, value] of Object.entries(parameters)) {
            if (eventData[key] !== undefined && eventData[key] !== value) {
                return false;
            }
        }

        return true;
    }

    // API pública para disparar workflows
    async handleMessageReceived(messageData) {
        await this.triggerWorkflows('message_received', {
            messageId: messageData.id,
            conversationId: messageData.conversationId,
            contactId: messageData.conversation?.contactId,
            companyId: messageData.conversation?.companyId,
            content: messageData.content,
            channel: messageData.metadata?.channel,
            sentiment: messageData.sentiment
        });
    }

    async handleConversationCreated(conversationData) {
        await this.triggerWorkflows('conversation_created', {
            conversationId: conversationData.id,
            contactId: conversationData.contactId,
            companyId: conversationData.companyId,
            channel: conversationData.channel,
            department: conversationData.departmentId
        });
    }

    async handleCustomerAction(actionData) {
        await this.triggerWorkflows('customer_action', actionData);
    }

    async handleAgentAction(actionData) {
        await this.triggerWorkflows('agent_action', actionData);
    }
}

module.exports = { AutomationService };