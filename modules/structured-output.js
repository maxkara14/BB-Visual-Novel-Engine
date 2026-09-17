import { cleanupMarkdownFences, parseModelJson, normalizeOptionData, normalizeGeneratedMessage, canonicalizeIntent } from './utils.js';

export function normalizeJsonMode(value) {
    return ['schema', 'json', 'prompt'].includes(value) ? value : 'auto';
}

export function normalizeAdditionalRequests(value) {
    if (value === undefined || value === null || value === '') return 3;
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.min(5, Math.trunc(count))) : 3;
}

export function initialJsonMode(settings, source) {
    const mode = normalizeJsonMode(settings.vnJsonMode);
    // Tavern's structured-output extraction can replace unsupported responses with {}.
    // Keep its main/profile routes in prompt mode unless the user explicitly opts into a schema.
    return mode === 'auto' ? (source === 'custom' ? 'schema' : 'prompt') : mode;
}

export function customResponseFormat(mode, schema) {
    if (mode === 'json') return { type: 'json_object' };
    if (mode !== 'schema' || !schema) return undefined;
    return { type: 'json_schema', json_schema: {
        name: schema.name, description: schema.description, strict: schema.strict, schema: schema.value,
    } };
}

export function isUnsupportedOutputFormat(status, data) {
    if (status !== 400 && status !== 422) return false;
    const error = data?.error;
    if (!error || typeof error !== 'object') return false;
    const code = String(error.code || '');
    const param = String(error.param || '');
    const message = String(error.message || '');
    const namesFormat = /response_format|json_schema|structured.outputs/i.test(`${param} ${message}`);
    return namesFormat && (/^(unsupported_parameter|unsupported_value|unsupported_response_format)$/.test(code)
        || /not supported|does not support|unsupported|not available for/i.test(message));
}

export function isEmptyOptionsInput(raw) {
    const cleaned = cleanupMarkdownFences(raw);
    if (!cleaned) return true;
    try {
        const value = JSON.parse(cleaned);
        if (value === null || value === '') return true;
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'object') {
            return Object.keys(value).length === 0 || (Array.isArray(value.options) && value.options.length === 0);
        }
    } catch { /* Nonempty broken JSON can still be repaired. */ }
    return false;
}

export function parseVnOptions(raw) {
    const parsed = parseModelJson(raw, { prefer: 'array' });
    if (!parsed.ok || !Array.isArray(parsed.parsed)) return { ok: false, options: [], errors: parsed.errors || [] };
    const options = [];
    const messages = new Set();
    const intents = new Set();
    for (const entry of parsed.parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const message = entry.message ?? entry.text ?? entry.action ?? entry.reply ?? entry.response ?? entry.dialogue ?? entry.content ?? entry.description;
        if (typeof entry.intent !== 'string' || !entry.intent.trim() || typeof message !== 'string' || !message.trim()) continue;
        if (!normalizeGeneratedMessage(message)) continue;
        if (['tone', 'forecast', 'risk'].some(key => entry[key] != null && typeof entry[key] !== 'string')) continue;
        if (entry.targets != null && (!Array.isArray(entry.targets) || entry.targets.some(target => typeof target !== 'string'))) continue;
        if (entry.target != null && typeof entry.target !== 'string') continue;
        const normalized = normalizeOptionData({ ...entry, message });
        const messageKey = canonicalizeIntent(normalized.message);
        const intentKey = canonicalizeIntent(normalized.intent);
        if (!messageKey || !intentKey || messages.has(messageKey) || intents.has(intentKey)) continue;
        messages.add(messageKey);
        intents.add(intentKey);
        options.push({
            intent: normalized.intent, message: normalized.message, tone: normalized.tone,
            forecast: normalized.forecast, risk: normalized.risk,
            targets: normalized.targets.map(target => target.trim()).filter(Boolean).slice(0, 3),
        });
    }
    return { ok: options.length > 0, options: options.slice(0, 3), errors: options.length ? [] : ['No valid option objects'] };
}
