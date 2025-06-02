// src/utils/helpers.js
const crypto = require('crypto');

// Formatação de telefone brasileiro
const formatPhone = (phone) => {
    // Remove todos os caracteres não numéricos
    const cleaned = phone.replace(/\D/g, '');

    // Se começa com 55 (código do Brasil), remove
    if (cleaned.startsWith('55') && cleaned.length > 11) {
        return cleaned.substring(2);
    }

    // Se não tem código de área, adiciona 11 (São Paulo como padrão)
    if (cleaned.length === 9) {
        return '11' + cleaned;
    }

    return cleaned;
};

// Validação de telefone brasileiro
const isValidBrazilianPhone = (phone) => {
    const cleaned = formatPhone(phone);

    // Deve ter 10 ou 11 dígitos (com código de área)
    if (!/^\d{10,11}$/.test(cleaned)) {
        return false;
    }

    // Se tem 11 dígitos, o 3º deve ser 9 (celular)
    if (cleaned.length === 11 && cleaned[2] !== '9') {
        return false;
    }

    // Códigos de área válidos (simplificado)
    const validAreaCodes = [
        '11', '12', '13', '14', '15', '16', '17', '18', '19', // SP
        '21', '22', '24', // RJ
        '27', '28', // ES
        '31', '32', '33', '34', '35', '37', '38', // MG
        '41', '42', '43', '44', '45', '46', // PR
        '47', '48', '49', // SC
        '51', '53', '54', '55', // RS
        '61', // DF
        '62', '64', // GO
        '65', '66', // MT
        '67', // MS
        '68', // AC
        '69', // RO
        '71', '73', '74', '75', '77', // BA
        '79', // SE
        '81', '87', // PE
        '82', // AL
        '83', // PB
        '84', // RN
        '85', '88', // CE
        '86', '89', // PI
        '91', '93', '94', // PA
        '92', '97', // AM
        '95', // RR
        '96', // AP
        '98', '99' // MA
    ];

    const areaCode = cleaned.substring(0, 2);
    return validAreaCodes.includes(areaCode);
};

// Verificar horário comercial
const isBusinessHours = (timezone = 'America/Sao_Paulo') => {
    const now = new Date();
    const localTime = new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'long'
    }).formatToParts(now);

    const hour = parseInt(localTime.find(part => part.type === 'hour').value);
    const weekday = localTime.find(part => part.type === 'weekday').value;

    // Horário comercial padrão: Segunda a Sexta, 9h às 18h
    const isWeekday = !['sábado', 'domingo'].includes(weekday);
    const isBusinessHour = hour >= 9 && hour < 18;

    return isWeekday && isBusinessHour;
};

// Delay para operações
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Gerar UUID simples
const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

// Hash de string
const hashString = (str) => {
    return crypto.createHash('sha256').update(str).digest('hex');
};

// Sanitizar entrada de usuário
const sanitizeInput = (input) => {
    if (typeof input !== 'string') return input;

    return input
        .replace(/[<>]/g, '') // Remove caracteres perigosos
        .trim()
        .substring(0, 1000); // Limita tamanho
};

// Formatar data para exibição
const formatDate = (date, locale = 'pt-BR') => {
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(date));
};

// Gerar slug de string
const generateSlug = (str) => {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove acentos
        .replace(/[^a-z0-9 -]/g, '') // Remove caracteres especiais
        .replace(/\s+/g, '-') // Substitui espaços por hífens
        .replace(/-+/g, '-') // Remove hífens duplicados
        .trim('-');
};

// Validar email
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// Truncar texto
const truncateText = (text, maxLength = 100) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
};

// Calcular tempo decorrido
const timeAgo = (date, locale = 'pt-BR') => {
    const now = new Date();
    const diff = now - new Date(date);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} dia${days > 1 ? 's' : ''} atrás`;
    if (hours > 0) return `${hours} hora${hours > 1 ? 's' : ''} atrás`;
    if (minutes > 0) return `${minutes} minuto${minutes > 1 ? 's' : ''} atrás`;
    return 'Agora mesmo';
};

// Validar CPF
const isValidCPF = (cpf) => {
    const cleaned = cpf.replace(/\D/g, '');

    if (cleaned.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cleaned)) return false; // Números iguais

    let sum = 0;
    for (let i = 0; i < 9; i++) {
        sum += parseInt(cleaned.charAt(i)) * (10 - i);
    }
    let remainder = (sum * 10) % 11;
    if (remainder === 10 || remainder === 11) remainder = 0;
    if (remainder !== parseInt(cleaned.charAt(9))) return false;

    sum = 0;
    for (let i = 0; i < 10; i++) {
        sum += parseInt(cleaned.charAt(i)) * (11 - i);
    }
    remainder = (sum * 10) % 11;
    if (remainder === 10 || remainder === 11) remainder = 0;
    if (remainder !== parseInt(cleaned.charAt(10))) return false;

    return true;
};

// Validar CNPJ
const isValidCNPJ = (cnpj) => {
    const cleaned = cnpj.replace(/\D/g, '');

    if (cleaned.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(cleaned)) return false; // Números iguais

    let length = cleaned.length - 2;
    let numbers = cleaned.substring(0, length);
    let digits = cleaned.substring(length);
    let sum = 0;
    let pos = length - 7;

    for (let i = length; i >= 1; i--) {
        sum += numbers.charAt(length - i) * pos--;
        if (pos < 2) pos = 9;
    }

    let result = sum % 11 < 2 ? 0 : 11 - sum % 11;
    if (result !== parseInt(digits.charAt(0))) return false;

    length = length + 1;
    numbers = cleaned.substring(0, length);
    sum = 0;
    pos = length - 7;

    for (let i = length; i >= 1; i--) {
        sum += numbers.charAt(length - i) * pos--;
        if (pos < 2) pos = 9;
    }

    result = sum % 11 < 2 ? 0 : 11 - sum % 11;
    if (result !== parseInt(digits.charAt(1))) return false;

    return true;
};

module.exports = {
    formatPhone,
    isValidBrazilianPhone,
    isBusinessHours,
    delay,
    generateUUID,
    hashString,
    sanitizeInput,
    formatDate,
    generateSlug,
    isValidEmail,
    truncateText,
    timeAgo,
    isValidCPF,
    isValidCNPJ
};