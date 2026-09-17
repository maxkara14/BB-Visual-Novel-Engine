/* global SillyTavern */
import { chat_metadata, saveChatDebounced, generateQuietPrompt } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME, OPTIONS_PROMPT, normalizeVnReplyLength } from './constants.js';
import { 
    normalizeOptionData, 
    dedupeOptions, 
    escapeHtml,
    normalizeTraitResponse,
    isLikelyModelRefusalText,
    getToneClass,
    buildJsonDiagnostic,
} from './utils.js';
import { notifyInfo, notifyError } from './toasts.js';
import { 
    vnGenerationAbortController, 
    isVnGenerationCancelled, 
    setVnGenerationAbortController, 
    setIsVnGenerationCancelled,
    createVnOptionsGenerationToken,
    isActiveVnOptionsGenerationToken,
} from './state.js';
import { injectCombinedSocialPrompt, getCurrentPersonaScopeKey } from './social.js';
import { VnRequestError, normalizeRequestTimeout, httpRequestError, normalizeRequestError, readCustomApiContent, withRequestDeadline, getCustomApiIdentity } from './requests.js';
import { generateWithProfile, resolveVnGenerationSource } from './connections.js';
import { normalizeJsonMode, normalizeAdditionalRequests, initialJsonMode, customResponseFormat, isUnsupportedOutputFormat, isEmptyOptionsInput, parseVnOptions } from './structured-output.js';
import {
    resetVnOptionsContainer,
    setVnGenerateButtonIdle,
    setVnGenerateButtonLoading,
} from './vn-ui.js';

let lastCustomApiFallbackNoticeAt = 0;
let activeVnOptionsOperation = null;
let activeMainRequest = null;
const MIN_RENDERABLE_OPTIONS = 2;
const CUSTOM_API_HEALTH_EVENT = 'bb-vn-custom-api-health';
const VN_GENERATION_CANCELLED_MESSAGE = 'Отменено пользователем';
const OPTIONS_RESPONSE_LENGTH_TOKENS = {
    short: 2800,
    medium: 5200,
    long: 8000,
};
const JSON_REPAIR_RESPONSE_LENGTH_TOKENS = 5200;

function emitCustomApiHealth(detail = {}) {
    try {
        window.dispatchEvent(new CustomEvent(CUSTOM_API_HEALTH_EVENT, { detail }));
    } catch (error) {
        console.debug('[BB VN] Custom API health event skipped');
    }
}

function maybeNotifyCustomApiFallback() {
    const now = Date.now();
    if (now - lastCustomApiFallbackNoticeAt < 8000) return;
    lastCustomApiFallbackNoticeAt = now;
    notifyInfo('Кастомная модель не ответила. Генерация продолжена на основной модели.');
}
function getActiveVnReplyLength() {
    return normalizeVnReplyLength(extension_settings[MODULE_NAME]?.vnReplyLength);
}

function buildOptionLengthDirective(lengthPreset = '') {
    switch (normalizeVnReplyLength(lengthPreset)) {
        case 'short':
            return 'Length preset: SHORT. Each "message" should still feel like a complete mini-scene: usually 1-2 compact paragraphs, about 450-900 Russian characters total. Include a quick scene setup, one clear action or short dialogue beat, and a neat stopping point. Keep it concise, but do not reduce it to a one-line reaction.';
        case 'long':
            return 'Length preset: LONG. Each "message" must read like a substantial VN scene fragment, not just an expanded reaction: usually 4-8 paragraphs, about 1800-3200 Russian characters total. Include multiple connected beats inside one reply: scene movement, physical action, dialogue exchange, emotional shift, and a clear end state or strong hook. Build an actual scene with actions, dialogue, and progression.';
        case 'medium':
        default:
            return 'Length preset: MEDIUM. Each "message" should feel like one developed scene beat: usually 2-4 paragraphs, about 900-1600 Russian characters total. Balance action, dialogue, internal thought, and a noticeable consequence while keeping the pace active.';
    }
}

function getOptionsResponseLength(lengthPreset = '') {
    return OPTIONS_RESPONSE_LENGTH_TOKENS[normalizeVnReplyLength(lengthPreset)] || OPTIONS_RESPONSE_LENGTH_TOKENS.medium;
}

function getVnOptionsJsonSchema(count = 3) {
    return {
        name: 'bb_vn_options',
        description: 'Three distinct visual novel action options.',
        strict: true,
        returnInvalid: true,
        value: {
            type: 'object',
            additionalProperties: false,
            required: ['options'],
            properties: {
                options: {
                    type: 'array',
                    minItems: count,
                    maxItems: count,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['intent', 'tone', 'forecast', 'targets', 'risk', 'message'],
                        properties: {
                            intent: { type: 'string' },
                            tone: { type: 'string' },
                            forecast: { type: 'string' },
                            targets: {
                                type: 'array',
                                maxItems: 3,
                                items: { type: 'string' },
                            },
                            risk: { type: 'string' },
                            message: { type: 'string' },
                        },
                    },
                },
            },
        },
    };
}

function buildAssistantLengthDirective(lengthPreset = '') {
    switch (normalizeVnReplyLength(lengthPreset)) {
        case 'short':
            return 'Keep the reply compact but complete: usually 1-2 concise paragraphs with a short setup, one concrete interaction or dialogue beat, and a clean stopping point. It should feel like a mini-scene, not a stub.';
        case 'long':
            return 'Write a substantial scene with multiple meaningful beats: usually 4-8 paragraphs. Include actions, dialogue, emotional movement, and visible consequences. The reply must materially advance the scene and feel like a real VN scene fragment.';
        case 'medium':
        default:
            return 'Keep the reply medium in length: usually 2-4 paragraphs with one developed interaction, clear scene progression, and a noticeable consequence. Avoid filler, but let the scene breathe.';
    }
}

function normalizeOptionsGenerationRequest(request = []) {
    if (Array.isArray(request)) {
        return {
            excludedIntents: request.map(item => String(item || '').trim()).filter(Boolean),
            excludedTones: [],
            guidance: '',
            mode: 'default',
        };
    }

    if (request && typeof request === 'object') {
        return {
            excludedIntents: Array.isArray(request.excludedIntents)
                ? request.excludedIntents.map(item => String(item || '').trim()).filter(Boolean)
                : [],
            excludedTones: Array.isArray(request.excludedTones)
                ? request.excludedTones.map(item => String(item || '').trim()).filter(Boolean)
                : [],
            guidance: String(request.guidance || request.wish || '').trim(),
            mode: String(request.mode || 'default').trim() || 'default',
        };
    }

    return {
        excludedIntents: [],
        excludedTones: [],
        guidance: String(request || '').trim(),
        mode: 'default',
    };
}

function createVnGenerationCancelledError() {
    return new Error(VN_GENERATION_CANCELLED_MESSAGE);
}

function ensureActiveVnOptionsGeneration(token) {
    if (!isActiveVnOptionsGenerationToken(token) || isVnGenerationCancelled || !isCurrentOptionsOperation(token)) {
        throw createVnGenerationCancelledError();
    }
}

function reportGenerationSource(source) {
    window.dispatchEvent(new CustomEvent('bb-vn-generation-source', { detail: { source } }));
}

function getOptionsChatKey(context) {
    return JSON.stringify([
        context.groupId ?? null,
        context.characterId ?? null,
        context.getCurrentChatId?.() ?? context.chatId ?? null,
    ]);
}

function isCurrentOptionsOperation(token) {
    const operation = activeVnOptionsOperation;
    if (!operation || operation.token !== token) return false;
    const context = SillyTavern.getContext();
    return context.chat === operation.chat
        && getOptionsChatKey(context) === operation.chatKey
        && getCurrentPersonaScopeKey() === operation.personaKey
        && context.chat.length === operation.messageIndex + 1
        && context.chat[operation.messageIndex] === operation.message
        && !operation.message.is_user
        && (operation.message.swipe_id ?? 0) === operation.swipeId
        && String(operation.message.mes || '') === operation.messageText;
}

export function invalidateVnOptionsGeneration() {
    const operation = activeVnOptionsOperation;
    if (!operation) return;
    // Invalidate before aborting: stopGeneration can synchronously emit events.
    activeVnOptionsOperation = null;
    createVnOptionsGenerationToken();
    operation.controller?.abort();
    reportOptionsStage('Отменено', operation.requestsMade || 0);
    restoreVNOptions(false);
}

function canonicalizeToneKey(tone = '') {
    const normalizedTone = String(tone || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalizedTone) return '';

    const toneClass = getToneClass(normalizedTone);
    if (toneClass && toneClass !== 'tone-neutral') {
        return toneClass;
    }

    return normalizedTone.split(' ').slice(0, 2).join(' ');
}

function hasWeakToneDiversity(options = []) {
    if (!Array.isArray(options) || options.length < 2) return false;
    const toneKeys = options
        .map(option => canonicalizeToneKey(normalizeOptionData(option).tone))
        .filter(Boolean);
    if (toneKeys.length < 2) return false;
    return new Set(toneKeys).size < Math.min(options.length, 3);
}

function summarizeOptionsForPrompt(options = []) {
    return options.map((option, index) => {
        const normalized = normalizeOptionData(option);
        const tone = String(normalized.tone || '').trim() || 'без тона';
        const intent = String(normalized.intent || '').trim() || `Вариант ${index + 1}`;
        const forecast = String(normalized.forecast || '').trim();
        const messagePreview = String(normalized.message || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        return `${index + 1}. [tone=${tone}] [intent=${intent}]${forecast ? ` [forecast=${forecast}]` : ''}${messagePreview ? ` :: ${messagePreview}` : ''}`;
    }).join('\n');
}

function persistOptionsForCurrentSwipe(token, options = []) {
    ensureActiveVnOptionsGeneration(token);
    const { message: lastMsg, swipeId } = activeVnOptionsOperation;
    if (!lastMsg.extra) lastMsg.extra = {};
    if (!lastMsg.extra.bb_vn_options_swipes) lastMsg.extra.bb_vn_options_swipes = {};
    lastMsg.extra.bb_vn_options_swipes[swipeId] = options;
    saveChatDebounced();
}

export async function runMainGen(promptText, options = {}) {
    const token = options.vnOptionsToken;
    if (token) ensureActiveVnOptionsGeneration(token);
    const operation = token ? activeVnOptionsOperation : null;
    if ((operation?.controller.signal || options.signal)?.aborted) throw new VnRequestError('cancelled');
    const request = { quietPrompt: promptText };
    if (Number.isFinite(options.responseLength) && options.responseLength > 0) {
        request.responseLength = Math.round(options.responseLength);
    }
    if (options.jsonSchema) {
        request.jsonSchema = options.jsonSchema;
    }

    if (activeMainRequest) throw new VnRequestError('busy');
    const owner = {};
    activeMainRequest = owner;
    try {
        const result = await withRequestDeadline(async () => {
            try {
                if (typeof generateQuietPrompt === 'function') return await generateQuietPrompt(request);
                if (typeof window['generateQuietPrompt'] === 'function') return await window['generateQuietPrompt'](request);
                throw new VnRequestError('configuration');
            } finally {
                if (activeMainRequest === owner) activeMainRequest = null;
            }
        }, {
            signal: operation?.controller.signal || options.signal,
            timeoutMs: normalizeRequestTimeout(extension_settings[MODULE_NAME]?.requestTimeout) * 1000,
            onAbort: () => {
                if (activeMainRequest === owner) SillyTavern.getContext().stopGeneration?.();
            },
        });
        if (token) ensureActiveVnOptionsGeneration(token);
        if (typeof result !== 'string') throw new VnRequestError('invalid_response');
        if (!result.trim()) throw new VnRequestError('empty');
        return result;
    } catch (error) {
        throw normalizeRequestError(error);
    }
}

export function isVnGenerationAbortError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('abort')
        || message.includes('cancel')
        || message.includes('отмен');
}

export function cancelVnGeneration() {
    setIsVnGenerationCancelled(true);

    if (vnGenerationAbortController) {
        vnGenerationAbortController.abort();
    }

    try {
        SillyTavern.getContext?.().stopGeneration?.();
    } catch (error) {
        console.debug('[BB VN] stopGeneration failed');
    }
}

export async function generateFastPrompt(promptText, options = {}) {
    const token = options.vnOptionsToken;
    if (!token) return generateFastPromptOnce(promptText, options);
    ensureActiveVnOptionsGeneration(token);
    const operation = activeVnOptionsOperation;
    const source = resolveVnGenerationSource(operation.settings);
    if (!operation.jsonMode) operation.jsonMode = initialJsonMode(operation.settings, source);
    for (;;) {
        ensureActiveVnOptionsGeneration(token);
        if (!hasOptionsRequestBudget(token)) throw new VnRequestError('request_budget');
        operation.requestsMade++;
        reportOptionsStage(options.stage || 'Генерация вариантов', operation.requestsMade);
        try {
            return await generateFastPromptOnce(promptText, { ...options, jsonMode: operation.jsonMode });
        } catch (error) {
            ensureActiveVnOptionsGeneration(token);
            if (normalizeJsonMode(operation.settings.vnJsonMode) !== 'auto'
                || source !== 'custom' || error.code !== 'unsupported_format' || operation.jsonMode === 'prompt') throw error;
            operation.jsonMode = operation.jsonMode === 'schema' ? 'json' : 'prompt';
        }
    }
}

function hasOptionsRequestBudget(token) {
    ensureActiveVnOptionsGeneration(token);
    return activeVnOptionsOperation.requestsMade < 1 + normalizeAdditionalRequests(activeVnOptionsOperation.settings.vnMaxAdditionalRequests);
}

function reportOptionsStage(stage, requestNumber) {
    const label = document.querySelector('#bb-vn-btn-generate.loading .bb-vn-main-btn__label');
    if (label) label.textContent = `${stage} · ${requestNumber}`;
    window.dispatchEvent(new CustomEvent('bb-vn-generation-stage', { detail: { stage, requestNumber } }));
}

async function generateFastPromptOnce(promptText, options = {}) {
    const token = options.vnOptionsToken;
    if (token) ensureActiveVnOptionsGeneration(token);
    const responseFormat = options.responseFormat === 'text' ? 'text' : 'json';
    const includeMeta = options.includeMeta === true;
    const responseLength = Number.isFinite(options.responseLength) && options.responseLength > 0
        ? Math.round(options.responseLength)
        : null;
    const jsonSchema = options.jsonMode === 'prompt' || options.jsonMode === 'json' ? null : (options.jsonSchema || null);
    const s = { ...(token ? activeVnOptionsOperation.settings : extension_settings[MODULE_NAME]) };
    const signal = token ? activeVnOptionsOperation.controller.signal : options.signal;
    if (signal?.aborted) throw new VnRequestError('cancelled');
    const source = resolveVnGenerationSource(s);
    if (token && options.jsonMode === 'json' && source !== 'custom') throw new VnRequestError('json_mode_custom_only');
    if (token && options.jsonMode === 'schema' && source === 'main'
        && SillyTavern.getContext().mainApi && SillyTavern.getContext().mainApi !== 'openai') throw new VnRequestError('unsupported_format');
    if (source === 'profile') {
        const result = await generateWithProfile(promptText, s, {
            signal, responseLength, jsonSchema, assertCurrent: token ? () => ensureActiveVnOptionsGeneration(token) : undefined,
        });
        if (token) ensureActiveVnOptionsGeneration(token);
        reportGenerationSource(`профиль ${result.profileName}${result.model ? ` · ${result.model}` : ''}`);
        return includeMeta ? {
            content: result.content,
            meta: { provider: 'connection-profile', finishReason: '', usage: null },
        } : result.content;
    }
    if (source === 'custom') {
        if (!s.customApiUrl || !s.customApiModel) throw new VnRequestError('configuration');
        const controller = new AbortController();
        const connectionId = getCustomApiIdentity(s.customApiUrl, s.customApiKey);
        setVnGenerationAbortController(controller);
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            const baseUrl = s.customApiUrl.replace(/\/$/, '');
            const endpoint = baseUrl + '/chat/completions';
            
            const data = await withRequestDeadline(async requestSignal => {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    signal: requestSignal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${s.customApiKey || ''}`
                    },
                    body: JSON.stringify({
                        model: s.customApiModel,
                        messages:[
                            {
                                role: 'system',
                                content: responseFormat === 'text'
                                    ? 'You are an internal text generator. Return only the requested final result without extra explanations or wrappers.'
                                    : 'You are an internal JSON generator. You MUST output ONLY valid JSON format. No conversational text.'
                            },
                            { role: 'user', content: promptText }
                        ],
                        temperature: 0.7,
                        max_tokens: Math.max(4000, responseLength || 0),
                        ...(token && customResponseFormat(options.jsonMode, jsonSchema)
                            ? { response_format: customResponseFormat(options.jsonMode, jsonSchema) } : {}),
                        stream: false
                    })
                });
                if (!response.ok) {
                    let errorBody;
                    try { errorBody = await response.json(); } catch { /* Preserve HTTP status without exposing the body. */ }
                    if (token && isUnsupportedOutputFormat(response.status, errorBody)) throw new VnRequestError('unsupported_format');
                    throw httpRequestError(response.status);
                }
                try { return await response.json(); }
                catch { throw new VnRequestError('invalid_response'); }
            }, { signal: controller.signal, timeoutMs: normalizeRequestTimeout(s.requestTimeout) * 1000 });
            if (token) ensureActiveVnOptionsGeneration(token);
            const finishReason = data?.choices?.[0]?.finish_reason || '';
            const content = readCustomApiContent(data);
            reportGenerationSource(`Custom API · ${s.customApiModel}`);
            emitCustomApiHealth({
                state: 'connected',
                connectionId,
                model: s.customApiModel || '',
                message: s.customApiModel
                    ? `Кастомная модель ${s.customApiModel} ответила успешно.`
                    : 'Кастомная модель ответила успешно.',
            });
            if (includeMeta) {
                return {
                    content,
                    meta: {
                        provider: 'custom-api',
                        finishReason,
                        usage: data?.usage || null,
                    },
                };
            }
            return content;
        } catch (e) {
            if (token) ensureActiveVnOptionsGeneration(token);
            if (signal?.aborted || controller.signal.aborted) throw new VnRequestError('cancelled');
            const error = normalizeRequestError(e);
            if (error.code === 'cancelled') throw error;
            const canFallback = s.allowMainFallback === true && !(token && normalizeJsonMode(s.vnJsonMode) === 'json') && ['network', 'provider', 'timeout'].includes(error.code);
            emitCustomApiHealth({
                state: 'error',
                connectionId,
                model: s.customApiModel || '',
                message: error.message + (canFallback ? ' Используется резервная основная модель.' : ''),
            });
            if (!canFallback) throw error;
            if (token) {
                if (!hasOptionsRequestBudget(token)) throw new VnRequestError('request_budget');
                activeVnOptionsOperation.requestsMade++;
                reportOptionsStage('Резервная основная модель', activeVnOptionsOperation.requestsMade);
            }
            maybeNotifyCustomApiFallback();
            const fallbackSchema = token && normalizeJsonMode(s.vnJsonMode) === 'auto' ? null : jsonSchema;
            const fallbackContent = await runMainGen(promptText, { responseLength, jsonSchema: fallbackSchema, vnOptionsToken: token, signal });
            reportGenerationSource('основная модель (резервная после сбоя Custom API)');
            if (includeMeta) {
                return {
                    content: fallbackContent,
                    meta: {
                        provider: 'main-api-fallback',
                        finishReason: '',
                        usage: null,
                    },
                };
            }
            return fallbackContent;
        } finally {
            signal?.removeEventListener('abort', cancel);
            if (vnGenerationAbortController === controller) setVnGenerationAbortController(null);
        }
    } else {
        const content = await runMainGen(promptText, { responseLength, jsonSchema, vnOptionsToken: token, signal });
        reportGenerationSource('основная модель SillyTavern');
        if (includeMeta) {
            return {
                content,
                meta: {
                    provider: 'main-api',
                    finishReason: '',
                    usage: null,
                },
            };
        }
        return content;
    }
}

function extractOptionsFromGeneration(rawText = '') {
    return parseVnOptions(rawText);
}

function logOptionsJsonFailure(rawText = '', errors = [], stage = 'initial') {
    const settings = extension_settings[MODULE_NAME];
    console.warn(`[BB VN] Options JSON ${stage} parse diagnostic`, buildJsonDiagnostic(rawText, errors, {
        includeText: settings.debugGeneration === true,
        secrets: [settings.customApiKey],
    }));
}

async function repairOptionsJson(rawText = '', vnOptionsToken) {
    if (isEmptyOptionsInput(rawText)) throw new VnRequestError('empty_options');
    const repairPrompt = `You repair malformed JSON arrays for an internal roleplay tool.

Return ONLY a valid JSON object containing an "options" array with exactly 3 objects.
Do not add markdown fences, comments, or explanations.
Preserve the original Russian wording as much as possible.
Every "message" value must be a valid JSON string. Escape paragraph breaks as \\n\\n.
If a field is missing, use an empty string or[] instead of removing the object.

BROKEN INPUT:
${String(rawText || '').trim()}`;

    const generationResult = await generateFastPrompt(repairPrompt, {
        stage: 'Исправление JSON',
        vnOptionsToken,
        responseFormat: 'json',
        includeMeta: true,
        responseLength: JSON_REPAIR_RESPONSE_LENGTH_TOKENS,
        jsonSchema: getVnOptionsJsonSchema(),
    });
    return typeof generationResult === 'string'
        ? generationResult
        : generationResult?.content || '';
}

function buildOptionsCountError(rawCount = 0, uniqueCount = 0) {
    if (rawCount <= 0 && uniqueCount <= 0) {
        return 'Модель не вернула ни одного корректного варианта.';
    }
    if (uniqueCount >= MIN_RENDERABLE_OPTIONS) {
        return '';
    }
    if (rawCount > 0 && rawCount < 3) {
        return `Модель вернула только ${rawCount} варианта вместо 3.`;
    }
    if (uniqueCount > 0 && uniqueCount < 3) {
        return `Удалось собрать только ${uniqueCount} различимых варианта. Остальные были пустыми или слишком похожими.`;
    }
    return 'Не удалось собрать 3 корректных варианта ответа.';
}

function maybeNotifyPartialOptions(count = 0) {
    if (count >= 3 || count < MIN_RENDERABLE_OPTIONS) return;
    notifyInfo(`Модель собрала ${count} варианта из 3. Показываю то, что удалось получить.`);
}

async function fillMissingOptions(basePrompt = '', existingOptions =[], vnOptionsToken) {
    let distinctOptions = dedupeOptions(Array.isArray(existingOptions) ? existingOptions :[]);
    if (distinctOptions.length >= 3) return distinctOptions.slice(0, 3);

    for (let attempt = 0; attempt < 2 && distinctOptions.length < 3; attempt++) {
        if (!hasOptionsRequestBudget(vnOptionsToken)) break;
        const missingCount = 3 - distinctOptions.length;
        const existingSummary = distinctOptions.length > 0
            ? distinctOptions.map((option, index) => {
                const intent = String(option?.intent || '').trim() || `Вариант ${index + 1}`;
                const message = String(option?.message || '').trim().replace(/\s+/g, ' ').slice(0, 180);
                return `${index + 1}. ${intent}${message ? ` :: ${message}` : ''}`;
            }).join('\n')
            : 'Нет сохранённых вариантов.';

        const recoveryPrompt = `${basePrompt}

[RECOVERY MODE]
You already produced ${distinctOptions.length} usable options.
Generate EXACTLY ${missingCount} additional options that are clearly different from the existing ones below.
Do not repeat or lightly paraphrase them.
Return ONLY a valid JSON object containing an "options" array with the same schema.

[EXISTING OPTIONS]
${existingSummary}`;

        const recoveryResult = await generateFastPrompt(recoveryPrompt, {
            stage: 'Дополнение вариантов',
            vnOptionsToken,
            responseFormat: 'json',
            includeMeta: true,
            responseLength: JSON_REPAIR_RESPONSE_LENGTH_TOKENS,
            jsonSchema: getVnOptionsJsonSchema(missingCount),
        });
        const recoveryText = typeof recoveryResult === 'string'
            ? recoveryResult
            : recoveryResult?.content || '';
        const parsedRecovery = extractOptionsFromGeneration(recoveryText);
        if (!parsedRecovery.ok || !Array.isArray(parsedRecovery.options) || parsedRecovery.options.length === 0) {
            break;
        }

        distinctOptions = parseVnOptions(JSON.stringify([...distinctOptions, ...parsedRecovery.options])).options;
    }

    return distinctOptions.slice(0, 3);
}

async function diversifyOptionTones(basePrompt = '', existingOptions = [], vnOptionsToken) {
    const normalizedOptions = dedupeOptions(Array.isArray(existingOptions) ? existingOptions : []);
    if (!hasWeakToneDiversity(normalizedOptions)) {
        return normalizedOptions.slice(0, 3);
    }
    if (!hasOptionsRequestBudget(vnOptionsToken)) return normalizedOptions;

    const diversifyPrompt = `${basePrompt}

[TONE DIVERSITY RETRY]
The previous set was rejected because the tones repeated or felt too similar.
Generate a completely fresh set of EXACTLY 3 replacement options.

Hard rules:
1. All 3 "tone" values must be clearly different from each other.
2. Do NOT reuse the same emotional family twice. Avoid pairs like two soft tones, two cold tones, or two aggressive tones together.
3. The "forecast" must match the tone and the action.
4. Keep the intents clearly distinct and proactive.
5. Return ONLY a valid JSON object containing an "options" array with the same schema.

[REJECTED SET]
${summarizeOptionsForPrompt(normalizedOptions)}`;

    const diversifiedResult = await generateFastPrompt(diversifyPrompt, {
        stage: 'Разнообразие тонов',
        vnOptionsToken,
        responseFormat: 'json',
        includeMeta: true,
        responseLength: JSON_REPAIR_RESPONSE_LENGTH_TOKENS,
        jsonSchema: getVnOptionsJsonSchema(),
    });
    const diversifiedText = typeof diversifiedResult === 'string'
        ? diversifiedResult
        : diversifiedResult?.content || '';
    const parsedDiversified = extractOptionsFromGeneration(diversifiedText);
    if (!parsedDiversified.ok || !Array.isArray(parsedDiversified.options) || parsedDiversified.options.length === 0) {
        return normalizedOptions.slice(0, 3);
    }

    const filledDiversified = await fillMissingOptions(basePrompt, parsedDiversified.options, vnOptionsToken);
    if (!hasWeakToneDiversity(filledDiversified)) {
        return filledDiversified.slice(0, 3);
    }

    return normalizedOptions.slice(0, 3);
}

function isValidTraitResult(value = '') {
    const text = String(value || '').trim();
    if (!text || text.length > 240) return false;
    if (/[{}\[\]]/.test(text)) return false;
    if (isLikelyModelRefusalText(text)) return false;

    const separatorIndex = text.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= text.length - 2) return false;

    const traitName = text.slice(0, separatorIndex).trim();
    const traitDescription = text.slice(separatorIndex + 1).trim();
    if (!traitName || !traitDescription) return false;
    if (traitName.split(/\s+/).length > 6) return false;
    return traitDescription.length >= 8;
}

function sanitizeCharacterDescriptionResult(value = '') {
    return String(value || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^["'«»„“]+|["'«»„“]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 520);
}

function isValidCharacterDescriptionResult(value = '') {
    const text = sanitizeCharacterDescriptionResult(value);
    if (!text || text.length < 60) return false;
    if (/[{}\[\]]/.test(text)) return false;
    if (isLikelyModelRefusalText(text)) return false;
    return true;
}

function sanitizeStructuredCharacterDescriptionResult(value = '') {
    return String(value || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^["'«»„“]+|["'«»„“]+$/g, '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
}

function isValidStructuredCharacterDescriptionResult(value = '') {
    const text = sanitizeStructuredCharacterDescriptionResult(value);
    if (!text || text.length < 140) return false;
    if (/[{}\[\]]/.test(text)) return false;
    if (isLikelyModelRefusalText(text)) return false;
    return text.includes(':');
}

function collectCharacterDescriptionPromptContext() {
    try {
        const context = SillyTavern.getContext?.();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const userName = String(context?.substituteParams?.('{{user}}') || 'пользователь').trim() || 'пользователь';
        const personaText = clipPromptBlock(context?.substituteParams?.('{{persona}}') || '', 3200);

        let remainingChars = 5600;
        const recentLines = [];
        for (const message of chat.slice(-18).reverse()) {
            const rawText = String(message?.mes || message?.text || '')
                .replace(/\s+/g, ' ')
                .trim();
            if (!rawText) continue;

            const speaker = message?.is_user
                ? userName
                : String(message?.name || 'Сцена').trim() || 'Сцена';
            const line = `${speaker}: ${rawText}`;
            if (line.length > remainingChars && recentLines.length > 0) break;
            recentLines.unshift(line.slice(0, remainingChars));
            remainingChars -= line.length + 1;
            if (remainingChars <= 0) break;
        }

        return {
            userName,
            personaText,
            recentChat: recentLines.join('\n'),
        };
    } catch (error) {
        void error;
        return {
            userName: 'пользователь',
            personaText: '',
            recentChat: '',
        };
    }
}

function clipPromptBlock(value = '', maxLength = 1200, { singleLine = false } = {}) {
    let text = String(value || '')
        .replace(/\r/g, '')
        .trim();

    if (!text) return '';

    if (singleLine) {
        text = text.replace(/\s+/g, ' ');
    } else {
        text = text
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .join('\n')
            .replace(/\n{3,}/g, '\n\n');
    }

    return text.slice(0, maxLength).trim();
}

function normalizeCharacterNameForMatch(value = '') {
    return String(value || '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findMatchingContextCharacter(context, charName = '') {
    const target = normalizeCharacterNameForMatch(charName);
    if (!target || !Array.isArray(context?.characters)) return null;

    for (let index = 0; index < context.characters.length; index++) {
        const character = context.characters[index];
        if (!character) continue;
        if (normalizeCharacterNameForMatch(character.name) === target) {
            return { character, chid: index };
        }
    }

    return null;
}

async function collectCharacterDescriptionSourceContext({ charName = '', userName = '', personaText = '' } = {}) {
    const context = SillyTavern.getContext?.();
    const result = {
        matchedCharacterName: '',
        cardContext: '',
        worldInfoText: '',
    };

    if (!context || typeof context !== 'object') {
        return result;
    }

    const matched = findMatchingContextCharacter(context, charName);
    let cardFields = null;

    if (matched && typeof context.getCharacterCardFields === 'function') {
        try {
            cardFields = context.getCharacterCardFields({ chid: matched.chid }) || null;
            result.matchedCharacterName = String(matched.character?.name || '').trim();
        } catch (error) {
            console.debug('[BB VN] Failed to resolve character card fields for profile generation');
        }
    }

    if (cardFields) {
        const alternateGreetings = Array.isArray(cardFields.alternateGreetings)
            ? cardFields.alternateGreetings
                .map(item => clipPromptBlock(item, 320))
                .filter(Boolean)
                .slice(0, 2)
            : [];

        const cardLines = [
            result.matchedCharacterName ? `Совпавшая карточка: ${result.matchedCharacterName}` : '',
            cardFields.version ? `Версия карточки: ${clipPromptBlock(cardFields.version, 120, { singleLine: true })}` : '',
            cardFields.description ? `Описание карточки: ${clipPromptBlock(cardFields.description, 1500)}` : '',
            cardFields.personality ? `Характер из карточки: ${clipPromptBlock(cardFields.personality, 1000)}` : '',
            cardFields.scenario ? `Сценарий / сеттинг: ${clipPromptBlock(cardFields.scenario, 1000)}` : '',
            cardFields.creatorNotes ? `Creator notes: ${clipPromptBlock(cardFields.creatorNotes, 1200)}` : '',
            cardFields.charDepthPrompt ? `Глубинный prompt карточки: ${clipPromptBlock(cardFields.charDepthPrompt, 900)}` : '',
            cardFields.system ? `Системный prompt карточки: ${clipPromptBlock(cardFields.system, 900)}` : '',
            cardFields.firstMessage ? `Первое сообщение: ${clipPromptBlock(cardFields.firstMessage, 700)}` : '',
            cardFields.mesExamples ? `Примеры речи: ${clipPromptBlock(cardFields.mesExamples, 1200)}` : '',
            alternateGreetings.length > 0 ? `Альтернативные приветствия: ${alternateGreetings.join(' | ')}` : '',
        ].filter(Boolean);

        result.cardContext = cardLines.join('\n');
    }

    if (typeof context.getWorldInfoPrompt === 'function') {
        try {
            const chat = Array.isArray(context.chat) ? context.chat : [];
            const chatForWI = chat
                .slice(-18)
                .map(message => {
                    const rawText = clipPromptBlock(message?.mes || message?.text || '', 420, { singleLine: true });
                    if (!rawText) return '';

                    const speaker = message?.is_user
                        ? (String(userName || '').trim() || 'пользователь')
                        : String(message?.name || 'Сцена').trim() || 'Сцена';
                    return `${speaker}: ${rawText}`;
                })
                .filter(Boolean)
                .reverse();

            const globalScanData = {
                personaDescription: clipPromptBlock(personaText, 2600),
                characterDescription: clipPromptBlock(cardFields?.description, 1800),
                characterPersonality: clipPromptBlock(cardFields?.personality, 1200),
                characterDepthPrompt: clipPromptBlock(cardFields?.charDepthPrompt, 900),
                scenario: clipPromptBlock(cardFields?.scenario, 1000),
                creatorNotes: clipPromptBlock(cardFields?.creatorNotes, 1200),
                trigger: 'quiet',
            };

            const wiPrompt = await context.getWorldInfoPrompt(
                chatForWI,
                Number(context.maxContext) || 4096,
                true,
                globalScanData,
            );

            result.worldInfoText = clipPromptBlock(wiPrompt?.worldInfoString || '', 3200);
        } catch (error) {
            console.debug('[BB VN] Failed to collect World Info context for profile generation');
        }
    }

    return result;
}

async function generateStructuredCharacterDescription({ charName = '', stats = {}, currentDescription = '', signal } = {}) {
    const safeCharName = String(charName || '').trim() || 'персонаж';
    const affinity = parseInt(stats?.affinity, 10) || 0;
    const romance = parseInt(stats?.romance, 10) || 0;
    const status = String(stats?.status || '').trim() || 'нейтральный фактор';
    const memories = stats?.memories && typeof stats.memories === 'object' ? stats.memories : {};
    const coreTraits = Array.isArray(stats?.core_traits)
        ? stats.core_traits
            .map(item => String(item?.trait || '').trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];
    const notableMemories = [
        ...(Array.isArray(memories.deep) ? memories.deep.slice(-4) : []),
        ...(Array.isArray(memories.soft) ? memories.soft.slice(-3) : []),
    ]
        .map(memory => String(memory?.text || '').trim())
        .filter(Boolean)
        .slice(0, 5);
    const historySummary = Array.isArray(stats?.history)
        ? stats.history.slice(-6).map(entry => {
            const delta = parseInt(entry?.delta, 10) || 0;
            const reason = String(entry?.reason || '').replace(/\s+/g, ' ').trim();
            return `${delta > 0 ? '+' : ''}${delta}${reason ? ` :: ${reason}` : ''}`;
        }).filter(Boolean)
        : [];
    const currentProfile = clipPromptBlock(currentDescription, 3200);
    const { userName, personaText, recentChat } = collectCharacterDescriptionPromptContext();
    const sourceContext = await collectCharacterDescriptionSourceContext({
        charName: safeCharName,
        userName,
        personaText,
    });

    const prompt = `Собери цельный профиль персонажа для prompt-инжекта в ролевом чате.

Нужно вернуть не художественный абзац, а компактное досье: достаточно подробное, чтобы модель уверенно держала внешность, прошлое, голос, роль и внутреннюю логику персонажа в будущих сценах.
Опирайся на историю чата, персону пользователя, динамику отношений, карточку персонажа, creator notes, примеры речи и релевантный world info / lorebook.

[ФОРМАТ ОТВЕТА]
Верни только готовый профиль на русском языке, без markdown, без пояснений и без вступления.
Сделай ровно 10 строк в формате:
Имя: ...
Возраст / этап жизни: ...
Роль и положение: ...
Внешность: ...
Одежда и узнаваемые детали: ...
Характер и внутренняя опора: ...
Манера речи и поведения: ...
Прошлое и личный контекст: ...
Отношение к ${userName}: ...
Сценический гайд: ...

[ПРАВИЛА]
1. Профиль должен быть законченным. Не пиши "не указано", "данных мало", "может быть", "возможно", "неясно" и другие заглушки.
2. Если в источниках есть пробелы, аккуратно дострой образ до конца на основе уже известных фактов, тона сцены, world info, карточки и поведения персонажа.
3. Домысливание разрешено только там, где оно не ломает явный канон. Явные факты из карточки, creator notes, world info и чата важнее домысливания.
4. Если можно трактовать образ по-разному, выбери одну наиболее правдоподобную и согласованную версию, а не оставляй несколько вариантов.
5. Внешность должна быть конкретной: телосложение, лицо, волосы, глаза, голос, заметные привычки, шрамы, запах или манера двигаться, если это уместно.
6. Прошлое должно давать игровые крючки: происхождение, социальное положение, связи, тайны, травмы, цели, страхи или долг.
7. Сценический гайд должен объяснять, как писать персонажа: что подчёркивать в реакциях, чего избегать, какие темы цепляют сильнее всего.
8. Если текущее описание уже содержит полезные факты, сохрани их и расширь, а не игнорируй.
9. Не превращай профиль в анкету с пустыми пунктами. Каждая строка должна быть плотной и пригодной для prompt-инжекта.
10. Держи ответ компактным и насыщенным, обычно в пределах 1400-2800 символов.

[ДАННЫЕ О ПЕРСОНАЖЕ]
Имя: ${safeCharName}
Статус связи: ${status}
Доверие: ${affinity > 0 ? '+' : ''}${affinity}
Романтическая линия: ${romance > 0 ? '+' : ''}${romance}
Черты: ${coreTraits.length > 0 ? coreTraits.join('; ') : 'нет явных данных'}
Значимые события: ${notableMemories.length > 0 ? notableMemories.join(' | ') : 'нет явных данных'}
Последние сдвиги: ${historySummary.length > 0 ? historySummary.join(' | ') : 'нет данных'}
Текущее описание: ${currentProfile || 'пусто'}

[КАРТОЧКА / ДОПОЛНИТЕЛЬНЫЕ ИСТОЧНИКИ]
${sourceContext.cardContext || 'Совпавшая карточка в текущем чате не найдена или дополнительных полей нет.'}

[АКТИВНЫЙ WORLD INFO / LOREBOOK]
${sourceContext.worldInfoText || 'Нет активированных записей world info для этого среза контекста.'}

[ПЕРСОНА ПОЛЬЗОВАТЕЛЯ]
${personaText || 'не указана'}

[НЕДАВНИЙ ФРАГМЕНТ ЧАТА]
${recentChat || 'нет доступных сообщений'}`;

    const generated = await generateFastPrompt(prompt, { responseFormat: 'text', signal });
    const result = sanitizeStructuredCharacterDescriptionResult(generated);
    if (!isValidStructuredCharacterDescriptionResult(result)) {
        throw new Error('INVALID_CHARACTER_DESCRIPTION_RESULT');
    }
    return result;
}

export async function generateCharacterDescription({ charName = '', stats = {}, currentDescription = '', signal } = {}) {
    return await generateStructuredCharacterDescription({ charName, stats, currentDescription, signal });
    const safeCharName = String(charName || '').trim() || 'персонаж';
    const affinity = parseInt(stats?.affinity, 10) || 0;
    const romance = parseInt(stats?.romance, 10) || 0;
    const status = String(stats?.status || '').trim() || 'нейтральный фактор';
    const memories = stats?.memories && typeof stats.memories === 'object' ? stats.memories : {};
    const coreTraits = Array.isArray(stats?.core_traits)
        ? stats.core_traits
            .map(item => String(item?.trait || '').trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];
    const notableMemories = [
        ...(Array.isArray(memories.deep) ? memories.deep.slice(-3) : []),
        ...(Array.isArray(memories.soft) ? memories.soft.slice(-2) : []),
    ]
        .map(memory => String(memory?.text || '').trim())
        .filter(Boolean)
        .slice(0, 4);
    const trendText = Array.isArray(stats?.history) && stats.history.length > 1
        ? 'история отношений уже накопилась и менялась по ходу сюжета'
        : 'история отношений пока короткая';
    const currentProfile = String(currentDescription || '').trim();

    const prompt = `Собери краткое описание персонажа для ролевого prompt-инжекта.

Нужно описать, как ${safeCharName} воспринимает пользователя и какие черты особенно важны в текущем сюжете.

[ДАННЫЕ]
Имя: ${safeCharName}
Статус связи: ${status}
Доверие: ${affinity > 0 ? '+' : ''}${affinity}
Романтическая линия: ${romance > 0 ? '+' : ''}${romance}
Динамика: ${trendText}
Черты: ${coreTraits.length > 0 ? coreTraits.join('; ') : 'нет явных данных'}
Значимые события: ${notableMemories.length > 0 ? notableMemories.join(' | ') : 'нет явных данных'}
Текущее описание: ${currentProfile || 'пусто'}

[ПРАВИЛА]
1. Верни только итоговый текст без заголовков, markdown и комментариев.
2. Пиши по-русски.
3. Сделай 2-4 предложения, примерно 220-450 символов.
4. Описывай характер, отношение к пользователю, заметные поведенческие акценты и эмоциональный тон.
5. Не пиши от первого лица.
6. Не выдумывай новые факты вне этих данных, но можно аккуратно обобщать их в цельный профиль.
7. Текст должен подходить для прямой вставки в prompt о персонаже.`;

    const generated = await generateFastPrompt(prompt, { responseFormat: 'text' });
    const result = sanitizeCharacterDescriptionResult(generated);
    if (!isValidCharacterDescriptionResult(result)) {
        throw new Error('INVALID_CHARACTER_DESCRIPTION_RESULT');
    }
    return result;
}

export async function crystallizeTraitFromMemories({ charName = '', userName = '', memories =[], isPositive = true, signal } = {}) {
    const selectedMemories = Array.isArray(memories) ? memories.slice(-5) :[];
    if (selectedMemories.length < 5) {
        throw new Error('NOT_ENOUGH_MEMORIES');
    }

    const memoriesBlock = selectedMemories
        .map((memory, index) => `${index + 1}. ${String(memory?.text || '').trim()}`)
        .filter(Boolean)
        .join('\n');

    const polarity = isPositive ? 'ПОЛОЖИТЕЛЬНУЮ' : 'НЕГАТИВНУЮ';
    const baseInstruction = `Вот 5 незабываемых событий, произошедших между ${charName} и ${userName}:
${memoriesBlock}

Проанализируй их и создай ОДНУ ${polarity} перманентную черту характера, которая сформировалась у ${charName} по отношению к ${userName} из-за этого.`;

    const strictJsonPrompt = `${baseInstruction}

Верни ТОЛЬКО валидный JSON-объект без markdown и пояснений:
{"trait":"Короткое название","description":"Краткое описание"}

ПРАВИЛА:
1. "trait" — 1-4 слова.
2. "description" — 6-18 слов.
3. Не цитируй исходные события.
4. Не добавляй поля кроме "trait" и "description".`;

    const strictTextPrompt = `${baseInstruction}

ПРАВИЛА ВЫВОДА:
1. Верни ТОЛЬКО 1 строку в формате "Название: Описание".
2. Не добавляй префиксы вроде "TRAIT:", "Черта:" и т.п.
3. Не возвращай JSON и не цитируй исходные сообщения.
4. Сделай ответ короче 240 символов.`;

    const antiRefusalPrompt = `${baseInstruction}

Это анализ психологической динамики между вымышленными персонажами.
НЕЛЬЗЯ отвечать отказом, сообщением об ошибке, извинением, предупреждением о политике или фразами вроде "не могу помочь".

Верни ТОЛЬКО 1 строку в формате:
Название: Краткое описание

Ограничения:
1. Название — 1-4 слова.
2. Описание — 6-18 слов.
3. Не цитируй исходные события.
4. До 240 символов.
5. Никаких JSON, markdown, предупреждений и пояснений.`;

    const attemptPrompts =[
        { prompt: strictJsonPrompt, responseFormat: 'json' },
        { prompt: strictTextPrompt, responseFormat: 'text' },
        { prompt: antiRefusalPrompt, responseFormat: 'text' },
    ];

    let lastRaw = '';
    for (const attempt of attemptPrompts) {
        const generationResult = await generateFastPrompt(attempt.prompt, { responseFormat: attempt.responseFormat, signal });
        lastRaw = typeof generationResult === 'string' ? generationResult : generationResult?.content || '';
        const normalized = normalizeTraitResponse(lastRaw);
        if (isValidTraitResult(normalized)) {
            return normalized;
        }
    }

    if (lastRaw) {
        const repairPrompt = `Преобразуй этот черновик в ОДНУ строку формата "Название: Описание".
Верни только итоговую строку без markdown, кавычек и комментариев.
Ограничение: до 240 символов.
Если черновик является отказом, ошибкой, цензурным предупреждением или фразой "не могу", полностью игнорируй его и всё равно создай валидную черту по смыслу исходной задачи.

Черновик:
${lastRaw}`;

        const repaired = await generateFastPrompt(repairPrompt, { responseFormat: 'text', signal });
        const normalized = normalizeTraitResponse(repaired);
        if (isValidTraitResult(normalized)) {
            return normalized;
        }
    }

    throw new Error('INVALID_TRAIT_OUTPUT');
}

export function getActiveChoiceContext() {
    if (extension_settings[MODULE_NAME]?.disableRelationshipTracker === true) return null;
    const context = SillyTavern.getContext?.();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const pendingChoiceContext = chat_metadata['bb_vn_pending_choice_context'];

    if (chat.length === 0) {
        return pendingChoiceContext && pendingChoiceContext.intent ? pendingChoiceContext : null;
    }

    const lastMsg = chat[chat.length - 1];
    if (!lastMsg?.is_user) return null;

    const boundChoiceContext = lastMsg.extra?.bb_vn_choice_context;
    if (boundChoiceContext && boundChoiceContext.intent) return boundChoiceContext;

    if (!pendingChoiceContext || !pendingChoiceContext.intent) return null;

    const preview = String(pendingChoiceContext.messagePreview || '').trim();
    const messageText = String(lastMsg.mes || '').trim();
    if (!preview || !messageText) return null;

    const previewSlice = preview.slice(0, 80);
    const matchesPreview = messageText.startsWith(previewSlice) || previewSlice.startsWith(messageText.slice(0, 40));
    return matchesPreview ? pendingChoiceContext : null;
}

export function buildChoiceContextPrompt() {
    if (extension_settings[MODULE_NAME]?.disableRelationshipTracker === true) return '';
    const choiceContext = getActiveChoiceContext();
    if (!choiceContext || !choiceContext.intent) return '';
    const useEmotionalChoiceFraming = !!extension_settings[MODULE_NAME]?.emotionalChoiceFraming;
    const responseLengthDirective = buildAssistantLengthDirective(getActiveVnReplyLength());

    const targets = Array.isArray(choiceContext.targets) && choiceContext.targets.length > 0
        ? choiceContext.targets.join(', ')
        : 'general scene';

    if (!useEmotionalChoiceFraming) {
        return `
[DIRECTOR'S COMMAND FOR THIS TURN]:
The player has just made a SPECIFIC narrative choice. You MUST execute it in this very response.

- INTENT: "${choiceContext.intent}"
- FOCUS: ${targets !== 'general scene' ? `Make sure ${targets} reacts clearly to this.` : 'Shift the scene in a clear, noticeable way.'}

EXECUTION PROTOCOL:
1. Do not ignore, soften away, or overwrite the chosen action.
2. Advance the scene immediately instead of stalling or looping in place.
3. Keep the response natural to the scene without forcing extra tone or forecast framing.
4. LENGTH & PACING: ${responseLengthDirective}
`.trim();
    }

    return `
[DIRECTOR'S STRICT COMMAND FOR THIS TURN]:
The player has just made a SPECIFIC narrative choice. You MUST execute it.

- INTENT: "${choiceContext.intent}"
- MANDATORY EMOTIONAL TONE: ${choiceContext.tone || 'neutral'} (You MUST write your response heavily saturated with this exact emotion).
- FORCED OUTCOME / FORECAST: ${choiceContext.forecast || 'Follow the natural flow'}

EXECUTION PROTOCOL:
1. FOCUS: ${targets !== 'general scene' ? `Make sure ${targets} reacts strongly to this.` : 'Shift the entire scene dynamic based on the forecast.'}
2. OUTCOME: You are FORBIDDEN from stalling. The "FORCED OUTCOME" must actually happen or clearly begin to manifest in this very response.
3. THEME: Adapt your vocabulary, pacing, and character reactions to perfectly match the "${choiceContext.tone || 'neutral'}" tone.
4. LENGTH & PACING: ${responseLengthDirective}
`.trim();
}

export function tryBindPendingChoiceContextToMessage(msg) {
    if (extension_settings[MODULE_NAME]?.disableRelationshipTracker === true) return false;
    const pendingChoiceContext = chat_metadata['bb_vn_pending_choice_context'];
    if (!pendingChoiceContext || !msg || !msg.is_user) return false;
    if (msg.extra?.bb_vn_choice_context) return false;

    const preview = String(pendingChoiceContext.messagePreview || '').trim();
    const messageText = String(msg.mes || '').trim();
    if (!preview || !messageText) return false;

    const previewSlice = preview.slice(0, 80);
    const matchesPreview = messageText.startsWith(previewSlice) || previewSlice.startsWith(messageText.slice(0, 40));
    if (!matchesPreview) return false;

    if (!msg.extra) msg.extra = {};
    msg.extra.bb_vn_choice_context = {
        intent: pendingChoiceContext.intent || '',
        tone: pendingChoiceContext.tone || '',
        forecast: pendingChoiceContext.forecast || '',
        targets: Array.isArray(pendingChoiceContext.targets) ? pendingChoiceContext.targets :[],
        at: pendingChoiceContext.at || Date.now(),
    };

    delete chat_metadata['bb_vn_pending_choice_context'];
    return true;
}

export async function bbVnGenerateOptionsFlow(request = []) {
    const btn = jQuery('#bb-vn-btn-generate');
    const generationRequest = normalizeOptionsGenerationRequest(request);
    
    if (activeVnOptionsOperation) {
        invalidateVnOptionsGeneration();
        notifyInfo("Генерация вариантов отменена");
        return;
    }

    const requestToken = createVnOptionsGenerationToken();
    let completed = false;
    setIsVnGenerationCancelled(false);

    setVnGenerateButtonLoading();
    resetVnOptionsContainer({ clear: true });

    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) throw new Error("Чат пуст");
        const messageIndex = chat.length - 1;
        const message = chat[messageIndex];
        if (message.is_user) throw new Error('Дождитесь ответа персонажа.');
        activeVnOptionsOperation = {
            token: requestToken,
            chat,
            chatKey: getOptionsChatKey(context),
            personaKey: getCurrentPersonaScopeKey(),
            messageIndex,
            message,
            swipeId: message.swipe_id ?? 0,
            messageText: String(message.mes || ''),
            settings: { ...extension_settings[MODULE_NAME] },
            requestsMade: 0,
            jsonMode: '',
            controller: new AbortController(),
        };
        
        const recentMessages = chat.slice(-10).map(message => `${message.name}: ${message.mes}`).join('\\n\\n');
        const lastMessageText = chat[chat.length - 1]?.mes || '';
        const replyLength = getActiveVnReplyLength();
        const useEmotionalChoiceFraming = !!extension_settings[MODULE_NAME]?.emotionalChoiceFraming;

        let prompt = OPTIONS_PROMPT
            .replace('{{chat}}', recentMessages)
            .replace('{{lastMessage}}', lastMessageText);

        prompt = context.substituteParams(prompt);
        prompt += `\n\n[ACTIVE LENGTH DIRECTIVE]\n${buildOptionLengthDirective(replyLength)}`;
        prompt += '\n\n[STRUCTURED OUTPUT COMPATIBILITY]\nReturn {"options":[...]} with exactly 3 option objects and no extra fields.';

        if (useEmotionalChoiceFraming) {
            prompt += '\n\n[TONE DIVERSITY RULE]\nAll 3 options MUST use clearly different emotional colors. Do not reuse the same tone family twice, even with different wording.';
        }

        if (generationRequest.excludedIntents.length > 0) {
            prompt += `\n\n[DO NOT REPEAT THESE PREVIOUS ACTION IDEAS]\n${generationRequest.excludedIntents.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}\nGenerate clearly different actions instead of cosmetic rewrites.`;
        }

        if (generationRequest.excludedTones.length > 0) {
            prompt += `\n\n[AVOID REUSING THESE PREVIOUS TONES]\n${generationRequest.excludedTones.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}\nChoose other emotional colors this time.`;
        }

        if (generationRequest.guidance) {
            prompt += `\n\n[USER GUIDANCE FOR THIS GENERATION]\n${generationRequest.guidance}\nTreat this as a strong preference across intent, tone, forecast, and message while still keeping all 3 options clearly distinct.`;
        }

        if (generationRequest.mode === 'smart-reroll') {
            prompt += '\n\n[SMART REROLL MODE]\nThis is a guided reroll. Avoid shallow paraphrases of the previous set and produce noticeably fresher options.';
        } else if (generationRequest.mode === 'guided') {
            prompt += '\n\n[GUIDED GENERATION MODE]\nThis is the first guided generation. Apply the user guidance proactively across all 3 options instead of treating it like a reroll.';
        } else if (generationRequest.mode === 'reroll') {
            prompt += '\n\n[REROLL MODE]\nReturn a fresh set, not cosmetic rewrites of the previous options.';
        }

        if (typeof window['bbGetSceneDirectorPrompt'] === 'function') {
            const sceneVibe = window['bbGetSceneDirectorPrompt']();
            if (sceneVibe) {
                console.debug('[BB VN] Scene Director style applied');
                prompt = sceneVibe + "\n\n" + prompt;
            }
        }

        const finalizeOptionsSet = async (rawOptions = []) => {
            ensureActiveVnOptionsGeneration(requestToken);
            const rawCount = Array.isArray(rawOptions) ? rawOptions.length : 0;
            let finalOptions = await fillMissingOptions(prompt, rawOptions, requestToken);
            ensureActiveVnOptionsGeneration(requestToken);
            if (useEmotionalChoiceFraming && hasWeakToneDiversity(finalOptions)) {
                finalOptions = await diversifyOptionTones(prompt, finalOptions, requestToken);
                ensureActiveVnOptionsGeneration(requestToken);
            }
            return {
                rawCount,
                finalOptions: dedupeOptions(finalOptions).slice(0, 3),
            };
        };

        const generationResult = await generateFastPrompt(prompt, {
            vnOptionsToken: requestToken,
            responseFormat: 'json',
            includeMeta: true,
            responseLength: getOptionsResponseLength(replyLength),
            jsonSchema: getVnOptionsJsonSchema(),
        });
        ensureActiveVnOptionsGeneration(requestToken);
        const result = typeof generationResult === 'string'
            ? generationResult
            : generationResult?.content || '';
        const finishReason = generationResult?.meta?.finishReason || '';
        const provider = generationResult?.meta?.provider || 'unknown';
        console.debug('[BB VN] Options response received', { length: String(result || '').length, provider });

        if (provider === 'custom-api' && finishReason === 'length') {
            throw new Error('Кастомный API обрезал ответ по лимиту токенов (finish_reason=length). Уменьшите объём запроса, переключите длину на более короткую или сделайте реролл.');
        }

        ensureActiveVnOptionsGeneration(requestToken);

        let recoveredPayload = extractOptionsFromGeneration(result);
        if (isEmptyOptionsInput(result)) throw new VnRequestError('empty_options');
        let recoveredOptions = recoveredPayload.options;
        if (!recoveredPayload.ok) {
            console.warn('[BB VN] Initial options JSON parse failed. Attempting repair.');
            logOptionsJsonFailure(result, recoveredPayload.errors, 'initial');

            const repairedResult = await repairOptionsJson(result, requestToken);
            ensureActiveVnOptionsGeneration(requestToken);
            recoveredPayload = extractOptionsFromGeneration(repairedResult);
            recoveredOptions = recoveredPayload.options;
            if (!recoveredPayload.ok) {
                logOptionsJsonFailure(repairedResult, recoveredPayload.errors, 'repair');
            }
        }

        if (recoveredPayload.ok && recoveredOptions && recoveredOptions.length > 0) {
            const { rawCount, finalOptions } = await finalizeOptionsSet(recoveredOptions);
            ensureActiveVnOptionsGeneration(requestToken);
            const recoveredError = buildOptionsCountError(rawCount, finalOptions.length);
            if (recoveredError) throw new Error(recoveredError);
            maybeNotifyPartialOptions(finalOptions.length);

            persistOptionsForCurrentSwipe(requestToken, finalOptions);
            if (typeof window['renderVNOptionsFromData'] === 'function') {
                window['renderVNOptionsFromData'](finalOptions, true);
            }
            completed = true;
            return;
        }

        throw new Error('Модель вернула некорректные варианты. Сделайте реролл.');

    } catch (e) {
        if (!isActiveVnOptionsGenerationToken(requestToken)) return;
        if (activeVnOptionsOperation && !isCurrentOptionsOperation(requestToken)) return;
        if (e.message !== VN_GENERATION_CANCELLED_MESSAGE) {
            console.error('[BB VN] Generation failed:', normalizeRequestError(e).code);
            notifyError(e.message || 'Не удалось сгенерировать варианты');
        }
    } finally {
        if (!isActiveVnOptionsGenerationToken(requestToken)) return;
        reportOptionsStage(completed ? 'Готово' : 'Завершено без новых вариантов', activeVnOptionsOperation?.requestsMade || 0);
        activeVnOptionsOperation = null;

        if (!completed && btn.hasClass('loading')) {
            restoreVNOptions(false);
        }

        setIsVnGenerationCancelled(false);
    }
}

export function restoreVNOptions(autoOpen = false) {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) {
        clearVNOptions();
        return;
    }
    const lastMsg = chat[chat.length - 1];
    if (lastMsg.is_user) {
        clearVNOptions();
        return;
    }
    const swipeId = lastMsg.swipe_id || 0;
    const savedOptions = lastMsg.extra?.bb_vn_options_swipes?.[swipeId];

    if (savedOptions && Array.isArray(savedOptions) && savedOptions.length > 0) {
        if (typeof window['renderVNOptionsFromData'] === 'function') {
            window['renderVNOptionsFromData'](savedOptions, autoOpen);
        }
    } else {
        clearVNOptions();
    }
}

export function clearVNOptions() {
    resetVnOptionsContainer({ clear: true });
    const ta = document.querySelector('#send_textarea');
    const btn = jQuery('#bb-vn-btn-generate');
    setVnGenerateButtonIdle({ hasSaved: false });
    if (ta instanceof HTMLTextAreaElement && ta.value.trim().length > 0) {
        btn.hide();
        return;
    }
    btn.show();
}

export function clearSavedVNOptions() {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) {
        clearVNOptions();
        return false;
    }

    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || lastMsg.is_user) {
        clearVNOptions();
        return false;
    }

    const swipeId = lastMsg.swipe_id || 0;
    const swipesMap = lastMsg.extra?.bb_vn_options_swipes;
    if (swipesMap && Object.prototype.hasOwnProperty.call(swipesMap, swipeId)) {
        delete swipesMap[swipeId];
        if (Object.keys(swipesMap).length === 0 && lastMsg.extra) {
            delete lastMsg.extra.bb_vn_options_swipes;
        }
        saveChatDebounced();
    }

    clearVNOptions();
    return true;
}
