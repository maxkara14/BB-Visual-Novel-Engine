/* global jQuery, SillyTavern, toastr */

import { setExtensionPrompt, chat_metadata, saveChatDebounced, saveSettingsDebounced, extension_prompt_roles, extension_prompt_types, generateQuietPrompt, callPopup } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = "BB-Visual-Novel";
const DEFAULT_SETTINGS = {
    autoSend: true,
    autoGen: false,
    useCustomApi: false,
    customApiUrl: 'https://api.groq.com/openai/v1',
    customApiKey: '',
    customApiModel: '',
    useMacro: false,
    emotionalChoiceFraming: true,
};

extension_settings[MODULE_NAME] = {
    ...DEFAULT_SETTINGS,
    ...(extension_settings[MODULE_NAME] || {}),
};

let currentCalculatedStats = {};
let currentStoryMoments = [];
let vnGenerationAbortController = null; // Контроллер для прерывания fetch
let isVnGenerationCancelled = false; // Флаг отмены

/**
 * @typedef {Object} VNOption
 * @property {string=} intent
 * @property {string=} tone
 * @property {string=} forecast
 * @property {string=} risk
 * @property {string=} message
 * @property {string=} text
 * @property {string=} action
 * @property {string=} reply
 * @property {string=} response
 * @property {string=} dialogue
 * @property {string=} content
 * @property {string=} description
 * @property {string[]=} targets
 * @property {string=} target
 */

// ==========================================
// ФАЗА 1: СОЦИАЛЬНЫЙ ТРЕКИНГ (DEEP SYNC + УМНЫЕ СТАТЫ)
// ==========================================
const SOCIAL_PROMPT = `[SYSTEM INSTRUCTION: VISUAL NOVEL ENGINE]
You are tracking how the characters feel about {{user}}. 
At the VERY END of your response, you MUST generate a hidden JSON block evaluating how {{user}}'s last action affected the characters.

CRITICAL RULES:
1. ONLY evaluate characters actively present or directly reacting in this specific turn.
2. Keep JSON keys EXACTLY as written in English. Translate ONLY the values into Russian.

JSON KEYS:
- "name": (String) Concrete character name. (e.g., "Alex"). No collective nouns.
- "friendship_impact": (String) Choose strictly from: "none", "minor_positive", "major_positive", "life_changing", "minor_negative", "major_negative", "unforgivable". Evaluates trust, respect, and camaraderie.
- "romance_impact": (String) Same scale as above. STRICT RULE: Keep "none" for casual/combat/platonic scenes. ONLY change during vulnerable, flirty, deeply caring, or jealous moments.
- "role_dynamic": (String) 1-2 words describing {{user}}'s CURRENT role to them right now (e.g., "опасный союзник", "скрытая угроза", "надежный друг").
- "reason": (String) Short Russian explanation of WHY the impact happened.
- "emotion": (String) 1-2 words describing the character's internal emotional state. If using two nouns, separate with a comma (e.g., "шок, обида", "радость").

\`\`\`json
{
  "social_updates":[
    {
      "name": "CHARACTER_NAME",
      "friendship_impact": "minor_positive",
      "romance_impact": "none",
      "role_dynamic": "ОТНОШЕНИЕ_К_USER",
      "reason": "Краткая причина изменения",
      "emotion": "эмоция"
    }
  ]
}
\`\`\``;

function getCombinedSocial() {
    let combinedStr = SOCIAL_PROMPT;
    const characters = Object.keys(currentCalculatedStats);
    
    if (characters.length > 0) {
        combinedStr += `\n\n[CURRENT RELATIONSHIP STATUS]:\n`;
        const impactInstructions = [];

        characters.forEach(char => {
            const stats = currentCalculatedStats[char];
            const tier = getTierInfo(stats.affinity).label;
            const status = stats.status || getUnforgettableRoleStatus(stats.memories?.deep) || tier;
            
            const recent = (stats.memories?.soft || []).map(m => m.text).join('; ');
            const deepMemories = stats.memories?.deep || [];
            const recentDeep = deepMemories.slice(-5); 
            const unforgettable = recentDeep.map(m => m.text).join('; ');
            const coreTraits = stats.core_traits || []; 
            const traitsText = coreTraits.length > 0 ? coreTraits.map(t => t.trait).join(' ') : '';

            // ФОРМИРУЕМ СТРОКУ
            combinedStr += `- ${char}: [Status: ${status}] [Trust: ${stats.affinity}] [Romance: ${stats.romance || 0}]`;
            if (recent) combinedStr += ` [Recent: ${recent}]`;
            if (unforgettable) combinedStr += ` [Unforgettable: ${unforgettable}]`; 
            if (traitsText) combinedStr += ` [CORE TRAITS: ${traitsText}]`; 
            
            // Вшиваем платонический блок
            if (chat_metadata['bb_vn_platonic_chars'] && chat_metadata['bb_vn_platonic_chars'].includes(char)) {
                combinedStr += ` [CRITICAL: THIS CHARACTER IS STRICTLY PLATONIC. "romance_impact" MUST ALWAYS BE "none".]`;
            }
            combinedStr += `\n`;

            const impact = getUnforgettableImpact(stats.memories?.deep || []);
            let guideLines = [];
            
            if (impact.prompt) {
                guideLines.push(`- Current Focus: ${impact.label}`);
                guideLines.push(`- Unforgettable Directive: ${impact.prompt}`);
            }
            if (coreTraits.length > 0) {
                guideLines.push(`- CORE TRAIT (Permanent): ${traitsText}`);
                guideLines.push(`- Trait Directive: These core traits are fundamental to their psychology and MUST dictate their underlying behavior and reactions to {{user}}.`);
            }
            if (guideLines.length > 0) {
                impactInstructions.push(`### ${char} BEHAVIOR GUIDE:\n${guideLines.join('\n')}`);
            }
        });

        combinedStr += `\n[NARRATIVE DIRECTIVES]:\n`;
        combinedStr += `1. Behavior: Dialogue and actions must strictly match the Status and Relationship Tier.\n`;
        combinedStr += `2. Memory: Characters must act based on 'Recent' (short-term mood) and 'Unforgettable' (permanent emotional anchor) memories.\n`;
        combinedStr += `3. Name Consistency: When evaluating existing characters, use EXACTLY these names: ${characters.join(', ')}.`;

        if (impactInstructions.length > 0) {
            combinedStr += `\n\n[UNFORGETTABLE IMPACT LOGIC]:\n${impactInstructions.join('\n')}\n`;
            combinedStr += `\nCRITICAL: Unforgettable memory directives override temporary scene moods.`;
        }
    }

    combinedStr += buildChoiceContextPrompt();
    return combinedStr;
}

function injectCombinedSocialPrompt() {
    try {
        if (extension_settings[MODULE_NAME].useMacro) {
            setExtensionPrompt('bb_social_injector', '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
        } else {
            const promptText = getCombinedSocial();
            setExtensionPrompt('bb_social_injector', promptText, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
        }
    } catch (e) { console.error("[BB VN] Ошибка инъекции:", e); }
}

function notifySuccess(message, title) {
    /** @type {any} */ (toastr).success(message, title);
}

function notifyInfo(message, title) {
    /** @type {any} */ (toastr).info(message, title);
}

function notifyError(message, title) {
    /** @type {any} */ (toastr).error(message, title);
}

const TOAST_LIFETIME_MS = 8500;
const TOAST_MAX_VISIBLE = 4;
let toastSequence = 0;

function ensureToastContainer() {
    if (!document.getElementById('bb-social-toast-container')) {
        $('body').append('<div id="bb-social-toast-container" aria-live="polite" aria-atomic="false"></div>');
    }
    syncToastContainerWithHud();
}

function syncToastContainerWithHud() {
    const container = document.getElementById('bb-social-toast-container');
    if (!container) return;

    const hud = document.getElementById('bb-social-hud');
    const hudIsOpen = !!hud && hud.classList.contains('open');
    container.classList.toggle('hud-open', hudIsOpen);

    if (!hudIsOpen) {
        container.style.removeProperty('--bb-toast-open-top');
        return;
    }

    const liveBadge = hud.querySelector('.bb-hud-live-dot');
    if (!liveBadge) return;

    const badgeRect = liveBadge.getBoundingClientRect();
    container.style.setProperty('--bb-toast-open-top', `${Math.max(12, Math.round(badgeRect.bottom + 8))}px`);
}

function removeToast(toastElement) {
    if (!toastElement || toastElement.dataset.state === 'closing') return;
    toastElement.dataset.state = 'closing';
    toastElement.classList.remove('is-visible');
    window.setTimeout(() => {
        if (toastElement.parentNode) toastElement.parentNode.removeChild(toastElement);
    }, 260);
}

function enforceToastLimit() {
    const activeToasts = Array.from(document.querySelectorAll('#bb-social-toast-container .bb-social-toast'));
    if (activeToasts.length < TOAST_MAX_VISIBLE) return;

    const excess = activeToasts.length - TOAST_MAX_VISIBLE + 1;
    activeToasts.slice(0, excess).forEach(removeToast);
}

function showHudToast({ title, text, badge = 'Система', variant = 'system', icon = 'fa-solid fa-sparkles', accent = '', meta = '' }) {
    ensureToastContainer();
    enforceToastLimit();
    const toastId = `bb-social-toast-${++toastSequence}`;
    const accentStyle = accent ? `style="--bb-toast-accent:${accent};"` : '';
    const toastHtml = `
        <article id="${toastId}" class="bb-social-toast ${variant}" ${accentStyle}>
            <div class="bb-st-glow"></div>
            <div class="bb-st-icon"><i class="${icon}"></i></div>
            <div class="bb-st-content">
                <div class="bb-st-topline">
                    <span class="bb-st-badge">${escapeHtml(badge)}</span>
                    ${meta ? `<span class="bb-st-meta">${escapeHtml(meta)}</span>` : ''}
                </div>
                <div class="bb-st-header">
                    <span class="bb-st-name">${escapeHtml(title)}</span>
                </div>
                <span class="bb-st-reason">${escapeHtml(text)}</span>
                <span class="bb-st-progress"></span>
            </div>
        </article>
    `;
    const toastContainer = document.getElementById('bb-social-toast-container');
    if (!toastContainer) return;
    toastContainer.insertAdjacentHTML('beforeend', toastHtml);
    const toastElement = document.getElementById(toastId);
    if (!toastElement) return;

    window.requestAnimationFrame(() => toastElement.classList.add('is-visible'));
    window.setTimeout(() => removeToast(toastElement), TOAST_LIFETIME_MS);
}

function showRelationshipToast(name, delta, reason, moodlet = '') {
    if (delta === 0) return;
    const shift = getShiftDescriptor(delta, moodlet);
    showHudToast({
        title: `${name} · ${shift.short}`,
        text: reason || shift.full,
        badge: 'Связи',
        variant: delta > 0 ? 'positive' : 'negative',
        icon: delta > 0 ? 'fa-solid fa-heart' : 'fa-solid fa-heart-crack',
        accent: shift.color,
        meta: delta > 0 ? `+${Math.abs(delta)}` : `−${Math.abs(delta)}`,
    });
}

function getMomentToastPriority(type = '') {
    const priorityMap = {
        'deep-positive': 5,
        'deep-negative': 5,
        'status-shift': 4,
        'tier-shift': 3,
        'soft-positive': 2,
        'soft-negative': 2,
        'intro': 1,
    };
    return priorityMap[type] || 0;
}

function pickToastMoment(currentMoment, nextMoment) {
    if (!nextMoment) return currentMoment;
    if (!currentMoment) return nextMoment;
    return getMomentToastPriority(nextMoment.type) >= getMomentToastPriority(currentMoment.type)
        ? nextMoment
        : currentMoment;
}

function showStoryMomentToast(moment) {
    if (!moment) return;

    const toastMap = {
        'deep-positive': { badge: 'Дневник', variant: 'milestone', icon: 'fa-solid fa-stars', accent: '#c084fc' },
        'deep-negative': { badge: 'Дневник', variant: 'alert', icon: 'fa-solid fa-bolt', accent: '#fb7185' },
        'soft-positive': { badge: 'Дневник', variant: 'positive', icon: 'fa-solid fa-book-open-reader', accent: '#4ade80' },
        'soft-negative': { badge: 'Дневник', variant: 'negative', icon: 'fa-solid fa-feather-pointed', accent: '#f87171' },
        'tier-shift': { badge: 'Маршрут', variant: 'system', icon: 'fa-solid fa-arrow-trend-up', accent: '#60a5fa' },
        'status-shift': { badge: 'Маршрут', variant: 'milestone', icon: 'fa-solid fa-user-pen', accent: '#f59e0b' },
        'intro': { badge: 'Трекер', variant: 'system', icon: 'fa-solid fa-user-plus', accent: '#93c5fd' },
        // НОВЫЕ ТОСТЫ ДЛЯ РОМАНТИКИ:
        'romance-positive': { badge: 'Влечение', variant: 'milestone', icon: 'fa-solid fa-heart', accent: '#f472b6' },
        'romance-negative': { badge: 'Отторжение', variant: 'alert', icon: 'fa-solid fa-heart-crack', accent: '#e11d48' },
    };
    const toastConfig = toastMap[moment.type] || toastMap['soft-positive'];
    const rawText = String(moment.text || '');
    const prefix = moment.char ? `${moment.char}: ` : '';
    const text = prefix && rawText.startsWith(prefix) ? rawText : `${moment.char || 'Сцена'}: ${rawText}`;
    showHudToast({
        title: moment.title || 'Новая запись',
        text,
        badge: toastConfig.badge,
        variant: toastConfig.variant,
        icon: toastConfig.icon,
        accent: toastConfig.accent,
    });
}

function getLegacyToneFromRisk(risk = "") {
    const value = String(risk).toLowerCase();
    if (value.includes('низк') || value.includes('low')) return 'нежно';
    if (value.includes('выс') || value.includes('high')) return 'опасно';
    if (value.includes('сред') || value.includes('med') || value.includes('medium')) return 'дерзко';
    return 'нейтрально';
}

function getLegacyForecastFromRisk(risk = "") {
    const value = String(risk).toLowerCase();
    if (value.includes('низк') || value.includes('low')) return 'Может мягко сблизить';
    if (value.includes('выс') || value.includes('high')) return 'Усилит напряжение';
    if (value.includes('сред') || value.includes('med') || value.includes('medium')) return 'Может резко сдвинуть динамику';
    return '';
}

function buildIntentFallback(tone = "", risk = "") {
    const t = String(tone || '').toLowerCase();
    const r = String(risk || '').toLowerCase();
    if (t.includes('мяг') || t.includes('неж')) return 'Осторожный шаг';
    if (t.includes('холод') || t.includes('отстр')) return 'Холодный манёвр';
    if (t.includes('дерз') || t.includes('напор')) return 'Смелый ход';
    if (t.includes('опас') || r.includes('выс')) return 'Рискованный выбор';
    return 'Новый ход';
}

function sanitizeIntentLabel(intent = "", tone = "", risk = "") {
    const raw = String(intent || '').trim();
    if (!raw) return buildIntentFallback(tone, risk);

    const cleaned = raw
        .replace(/[_]+/g, ' ')
        .replace(/[-]{2,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const hasCyrillic = /[а-яё]/i.test(cleaned);
    const latinChars = (cleaned.match(/[a-z]/gi) || []).length;
    const cyrillicChars = (cleaned.match(/[а-яё]/gi) || []).length;
    const looksLikeToken = /^[A-Z0-9_]+$/.test(raw) || /^[a-z0-9_]+$/.test(raw);
    const tooLatinHeavy = latinChars > 0 && cyrillicChars === 0;

    if (!cleaned || looksLikeToken || tooLatinHeavy || !hasCyrillic) {
        return buildIntentFallback(tone, risk);
    }

    const normalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    return normalized.slice(0, 64);
}

function normalizeGeneratedMessage(message = "") {
    return String(message || '')
        .replace(/\\\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\\\r/g, '\r')
        .replace(/\\r/g, '\r')
        .replace(/\\\\t/g, '\t')
        .replace(/\\t/g, '\t')
        .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\+$/g, '')
        .trim();
}

/**
 * @param {VNOption} option
 * @returns {VNOption}
 */
function normalizeOptionData(option = {}) {
    const legacyRisk = option.risk || "";
    const tone = option.tone || getLegacyToneFromRisk(legacyRisk);
    const forecast = option.forecast || getLegacyForecastFromRisk(legacyRisk);
    const targets = Array.isArray(option.targets)
        ? option.targets.filter(Boolean)
        : typeof option.target === 'string' && option.target.trim()
            ? [option.target.trim()]
            : [];

    let intentStr = sanitizeIntentLabel(option.intent || '', tone, legacyRisk);
    
    // Подхватываем все возможные галлюцинации ключей ИИ
    let rawMessage = option.message || option.text || option.action || option.reply || option.response || option.dialogue || option.content || option.description || '';
    
    let finalMessage = normalizeGeneratedMessage(rawMessage);
    
    // === ЖЕЛЕЗОБЕТОННЫЙ ФОЛБЭК ===
    if (!finalMessage) {
        finalMessage = `*${intentStr}*`;
    }

    return {
        ...option,
        intent: intentStr,
        message: finalMessage,
        tone,
        forecast,
        targets,
        risk: legacyRisk,
    };
}

function canonicalizeIntent(text = "") {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function dedupeOptions(options = []) {
    /** @type {Set<string>} */
    const seenIntents = new Set();
    /** @type {VNOption[]} */
    const unique = [];

    options.forEach(option => {
        const normalized = normalizeOptionData(option);
        const key = canonicalizeIntent(normalized.intent || normalized.message || '');
        if (!key || seenIntents.has(key)) return;
        seenIntents.add(key);
        unique.push(normalized);
    });

    return unique;
}

function extractJsonStringMatches(input = "", field = "") {
    const isMessage = field.includes('message');
    const fieldRegex = field.includes('|') ? field : String(field || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (isMessage) {
        // Ищем текст до закрывающей фигурной скобки, до следующего ключа (с запятой) ИЛИ до конца оборванной строки
        const regex = new RegExp(`"(?:${fieldRegex})"\\s*:\\s*"([\\s\\S]*?)"?(?=\\s*\\}|\\s*,\\s*"|$)`, 'gi');
        return [...String(input || '').matchAll(regex)].map(match => {
            let val = match[1] || '';
            // Броня: если регулярка сожрала следующий объект JSON, отрезаем его
            const badTail = val.search(/["']?\s*\}[\s,]*\{/);
            if (badTail !== -1) val = val.substring(0, badTail);
            // Зачищаем висящие кавычки в конце, если они попали в выборку
            val = val.replace(/["']+\s*$/, '');
            return val.trim();
        });
    }

    const regex = new RegExp(`"(?:${fieldRegex})"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'gi');
    return [...String(input || '').matchAll(regex)].map(match => match[1] || '');
}

function normalizeStatusLabel(value = "") {
    return String(value || '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeRelationshipStatus(value = "") {
    // Оставляем запятые, убираем только точки и спецсимволы в конце
    const normalized = normalizeStatusLabel(value).replace(/[.!?;]+$/g, '').trim();
    if (!normalized) return '';
    // Берем первые 3-4 слова, не вырезая союзы внутри фразы
    return normalized.split(' ').slice(0, 4).join(' ');
}

function sanitizeMoodlet(value = "") {
    // Не используем normalizeStatusLabel, чтобы не потерять запятые
    const normalized = String(value || '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[.!?;]+$/g, '')
        .trim();
    if (!normalized) return '';
    
    // Аккуратно разбиваем по пробелам, сохраняя приклеенные запятые
    return normalized.split(' ').slice(0, 4).join(' ');
}

function isCollectiveEntityName(name = "") {
    const value = String(name || '').trim().toLowerCase();
    if (!value) return true;
    const collectiveTokenRegex = /(^|\b)(класс|class|коллектив|группа|отряд|команда|team|фракция|faction|клан|семья|family|все|ученики|students|народ|люди|совет|советники|гильдия|отряд|корпус)(\b|$)/i;
    const numberedClassRegex = /\b(\d{1,2}\s*[-–]?\s*[абвгa-z]|[абвгa-z]\s*[-–]?\s*\d{1,2})\b/i;
    const pluralRoleRegex = /\b(ученик(и|ов)|солдат(ы|ов)|охотник(и|ов)|геро(и|ев)|член(ы|ов))\b/i;
    return collectiveTokenRegex.test(value) || numberedClassRegex.test(value) || pluralRoleRegex.test(value);
}

function isLikelySelfRoleStatus(status = "") {
    const value = normalizeStatusLabel(status).toLowerCase();
    if (!value) return false;

    const userFacingTokens = /(враг|союзник|ученик|соперник|угроза|цель|друг|пария|изгой|пешка|гость|интерес)/i;
    if (userFacingTokens.test(value)) return false;

    const selfRoleTokens = /(наставник|учитель|капитан|командир|лидер|хашира|столп|мастер|сенсей|директор)/i;
    return selfRoleTokens.test(value);
}

function isNarrativeStatusLeak(status = "") {
    const value = normalizeStatusLabel(status).toLowerCase();
    if (!value) return false;
    return /(котор(ый|ая|ое|ые)|меня|мне|мой|моя|моё|мои)\b/i.test(value);
}

function isValidUserFacingStatus(status = "") {
    const value = sanitizeRelationshipStatus(status);
    if (!value) return false;
    if (isLikelySelfRoleStatus(value)) return false;
    if (isNarrativeStatusLeak(value)) return false;
    return true;
}

function coerceUserFacingStatus(candidateStatus = "", affinity = 0, previousStatus = "", delta = 0) {
    void affinity;
    void delta;
    const incoming = sanitizeRelationshipStatus(candidateStatus);
    if (isValidUserFacingStatus(incoming)) return incoming;

    const prev = sanitizeRelationshipStatus(previousStatus);
    if (isValidUserFacingStatus(prev)) return prev;
    return '';
}

function getToneClass(tone = "") {
    const value = String(tone).toLowerCase();
    if (value.includes('неж') || value.includes('тепл') || value.includes('ласк')) return 'tone-gentle';
    if (value.includes('холод') || value.includes('лед')) return 'tone-cold';
    if (value.includes('сарка') || value.includes('ирон')) return 'tone-sarcastic';
    if (value.includes('дерз') || value.includes('смел') || value.includes('напор')) return 'tone-bold';
    if (value.includes('опас') || value.includes('темн') || value.includes('агресс')) return 'tone-danger';
    if (value.includes('низк') || value.includes('low')) return 'tone-gentle';
    if (value.includes('сред') || value.includes('med') || value.includes('medium')) return 'tone-bold';
    if (value.includes('выс') || value.includes('high')) return 'tone-danger';
    return 'tone-neutral';
}

function getMemoryBucket(delta) {
    const absDelta = Math.abs(delta);
    if (absDelta >= 15) return 'deep';
    if (absDelta >= 2) return 'soft';
    return '';
}

function getMemoryTone(delta) {
    if (delta > 0) return 'positive';
    if (delta < 0) return 'negative';
    return 'neutral';
}

function getShiftDescriptor(delta, moodlet = '') {
    const normalizedMoodlet = sanitizeMoodlet(moodlet);
    const absDelta = Math.abs(delta);
    const color = delta > 0
        ? (absDelta >= 9 ? '#c084fc' : absDelta >= 4 ? '#4ade80' : '#86efac')
        : (delta < 0 ? (absDelta >= 9 ? '#fca5a5' : absDelta >= 4 ? '#f87171' : '#fda4af') : '#94a3b8');
    const logType = delta > 0 ? 'plus' : delta < 0 ? 'minus' : 'system';
    if (normalizedMoodlet) {
        return {
            short: normalizedMoodlet,
            full: `Эмоциональный сдвиг: ${normalizedMoodlet}`,
            color,
            logType,
        };
    }
    if (delta === 0) return { short: '0', full: 'Сдвиг отношения 0', color, logType };
    const points = formatAffinityPoints(delta);
    return { short: points, full: `Сдвиг отношения ${points}`, color, logType };
}

function formatAffinityPoints(value) {
    const points = parseInt(value, 10) || 0;
    return points > 0 ? `+${points}` : `${points}`;
}

function getAffinityNarrative(affinity) {
    if (affinity <= -50) return 'Глубокий разлом';
    if (affinity < -10) return 'Холод и настороженность';
    if (affinity <= 10) return 'Хрупкий нейтралитет';
    if (affinity <= 50) return 'Осторожное сближение';
    if (affinity <= 80) return 'Стабильное доверие';
    return 'Очень близкая связь';
}

// === НОВАЯ ФУНКЦИЯ ДИНАМИКИ ===
function getTrendNarrative(history = []) {
    const recent = history.filter(h => h.delta !== 0).slice(-3);
    if (recent.length === 0) return 'Штиль';
    const sum = recent.reduce((acc, curr) => acc + curr.delta, 0);
    if (sum >= 8) return 'Уверенное сближение';
    if (sum > 0) return 'Позитивный сдвиг';
    if (sum <= -8) return 'Резкое отторжение';
    if (sum < 0) return 'Нарастание напряжения';
    return 'Неоднозначно';
}
// ===============================

function getUnforgettableImpact(memories = []) {
    if (!Array.isArray(memories) || memories.length === 0) {
        return { label: 'Нет активного следа', prompt: '' };
    }

    const total = memories.reduce((sum, memory) => sum + (parseInt(memory.delta) || 0), 0);
    const hasPositive = memories.some(memory => (parseInt(memory.delta) || 0) > 0);
    const hasNegative = memories.some(memory => (parseInt(memory.delta) || 0) < 0);

    let label = '';
    let prompt = '';

    // 1. Смешанные чувства (есть и плюсы, и минусы)
    if (hasPositive && hasNegative) {
        label = 'Противоречивая связь';
        prompt = 'Past unforgettable events create inner conflict: the character is torn between closeness and pain, so reactions should feel emotionally unstable and layered.';
    } 
    // 2. Тотальное обожание (сумма глубоких следов >= 18)
    else if (total >= 18) {
        label = 'Глубокая привязанность';
        prompt = 'Unforgettable positive events create a powerful pull toward {{user}}. Even in tense scenes, warmth, trust, or longing should leak through.';
    } 
    // 3. Просто хороший след (сумма > 0)
    else if (total > 0) {
        label = 'Тёплый осадок';
        prompt = 'Unforgettable positive events still shape the character. Small gestures from {{user}} should be interpreted more softly and personally.';
    } 
    // 4. Глубокая ненависть/травма (сумма <= -18)
    else if (total <= -18) {
        label = 'Непростительная обида';
        prompt = 'Unforgettable negative events still dominate the character’s perception. Suspicion, pain, or guardedness should override calm surface behavior.';
    } 
    // 5. Просто плохой след (сумма < 0)
    else {
        label = 'Тяжёлое воспоминание';
        prompt = 'Unforgettable negative events remain unresolved. Even neutral interactions should carry some hesitation, distance, or emotional recoil.';
    }

    return { label, prompt };
}

function getUnforgettableRoleStatus(memories = []) {
    void memories;
    return '';
}

function appendCharacterMemory(charStats, delta, reason, moodlet = '') {
    if (!charStats || !reason || delta === 0) return;
    const bucket = getMemoryBucket(delta);
    if (!bucket) return;
    const memory = {
        text: reason,
        delta,
        tone: getMemoryTone(delta),
        moodlet: sanitizeMoodlet(moodlet),
    };

    charStats.memories[bucket].push(memory);
    
    // Мягкие следы (сиюминутное настроение) по-прежнему чистим, они быстро забываются
    if (bucket === 'soft' && charStats.memories.soft.length > 4) {
        charStats.memories.soft.shift();
    }
    // ГЛУБОКИЕ СЛЕДЫ БОЛЬШЕ НЕ УДАЛЯЕМ! Они копятся вечно в истории персонажа.
}

function buildChoiceContextPrompt() {
    const choiceContext = chat_metadata['bb_vn_choice_context'];
    if (!choiceContext || !choiceContext.intent) return '';

    const targets = Array.isArray(choiceContext.targets) && choiceContext.targets.length > 0
        ? choiceContext.targets.join(', ')
        : 'general scene';

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
`.trim();
}

function maybeAddStoryMoment(moment) {
    if (!moment || !moment.title || !moment.text) return;
    currentStoryMoments.push(moment);
    if (currentStoryMoments.length > 30) currentStoryMoments.shift();
    return moment;
}

function tryBindPendingChoiceContextToMessage(msg) {
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
        targets: Array.isArray(pendingChoiceContext.targets) ? pendingChoiceContext.targets : [],
        at: pendingChoiceContext.at || Date.now(),
    };

    delete chat_metadata['bb_vn_pending_choice_context'];
    return true;
}

function getTierInfo(affinity) {
    if (affinity <= -50) return { label: 'Враг', class: 'tier-enemy', color: '#ef4444' };
    if (affinity < -10) return { label: 'Неприязнь', class: 'tier-enemy', color: '#f87171' };
    if (affinity <= 10) return { label: 'Незнакомец', class: 'tier-neutral', color: '#a1a1aa' };
    if (affinity <= 50) return { label: 'Приятель', class: 'tier-friend', color: '#4ade80' };
    if (affinity <= 80) return { label: 'Друг', class: 'tier-friend', color: '#22c55e' };
    return { label: 'Близкий', class: 'tier-close', color: '#c084fc' };
}

function addGlobalLog(type, text, timeString) {
    if (!chat_metadata['bb_vn_global_log']) chat_metadata['bb_vn_global_log'] = [];
    const time = timeString || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    chat_metadata['bb_vn_global_log'].push({ time, type, text });
    if (chat_metadata['bb_vn_global_log'].length > 100) chat_metadata['bb_vn_global_log'].shift();
}

function tryParseSocialUpdates(rawText) {
    const text = String(rawText || '');
    if (!text.trim()) return null;

    const candidates = [];

    const fenceRegex = /```(?:json|JSON|jsonc|JSONC|js|JS)?\s*([\s\S]*?)\s*```/g;
    let fenceMatch;
    while ((fenceMatch = fenceRegex.exec(text)) !== null) {
        if (fenceMatch[1] && fenceMatch[1].includes('social_updates')) {
            candidates.push(fenceMatch[1]);
        }
    }

    const htmlCommentRegex = /<!--\s*([\s\S]*?)\s*-->/g;
    let htmlMatch;
    while ((htmlMatch = htmlCommentRegex.exec(text)) !== null) {
        if (htmlMatch[1] && htmlMatch[1].includes('social_updates')) {
            candidates.push(htmlMatch[1]);
        }
    }

    const keywordIndex = text.indexOf('"social_updates"');
    if (keywordIndex !== -1) {
        let start = keywordIndex;
        while (start >= 0 && text[start] !== '{') start--;
        if (start >= 0) {
            let depth = 0;
            let end = -1;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (ch === '{') depth++;
                if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        end = i;
                        break;
                    }
                }
            }
            if (end > start) {
                candidates.push(text.slice(start, end + 1));
            }
        }
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate.trim());
            if (Array.isArray(parsed?.social_updates)) {
                return { parsed, source: candidate };
            }
        } catch (e) {}
    }

    return null;
}

function scanAndCleanMessage(msg, messageId) {
    if (!msg || msg.is_user) return false;
    let modified = false;
    const swipeId = msg.swipe_id || 0;
    
    const parsedPayload = tryParseSocialUpdates(msg.mes);

    // 1. Пытаемся распарсить и сохранить данные (если ИИ их сгенерировал)
    if (parsedPayload) {
        try {
            const parsed = parsedPayload.parsed;
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.bb_social_swipes) msg.extra.bb_social_swipes = {};

            msg.extra.bb_social_swipes[swipeId] = parsed.social_updates;
            // Вырезаем сам кусок кода из текста
            msg.mes = msg.mes.replace(parsedPayload.source, '').trim();
            modified = true;
        } catch(e) {}
    }
    
    // === 2. ЖЕЛЕЗОБЕТОННАЯ ЗАЧИСТКА МУСОРА ===
    // Выполняется ВСЕГДА, даже если ИИ оборвался из-за лимита токенов
    const oldMes = msg.mes;
    
    // Убираем пустые блоки (если ИИ закрыл скобки, но внутри пусто)
    msg.mes = msg.mes.replace(/```[a-zA-Z0-9_]*\s*```/gi, '').trim();
    
    // Убираем висящие открывающие бэктики СТРОГО В САМОМ КОНЦЕ сообщения
    msg.mes = msg.mes.replace(/```[a-zA-Z0-9_]*\s*$/gi, '').trim();
    
    if (oldMes !== msg.mes) {
        modified = true;
        if (msg.swipes && msg.swipes[swipeId] !== undefined) {
            msg.swipes[swipeId] = msg.mes; 
        }
    }
    
    // 3. Если текст изменился, обновляем его визуально в чате
    if (modified && messageId !== undefined) {
        const msgElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (msgElement) msgElement.innerHTML = SillyTavern.getContext().markdownToHtml(msg.mes);
    }
    
    return modified;
}

function recalculateAllStats(isNewMessage = false) {
    currentCalculatedStats = {};
    currentStoryMoments = [];
    chat_metadata['bb_vn_global_log'] = [];
    const chat = SillyTavern.getContext().chat;
    let latestChoiceContext = null;
    const newlyDiscoveredChars = [];
    
    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
    if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];

    let needsSave = false;

    // === МИГРАЦИЯ СТАРЫХ ЧЕРТ ХАРАКТЕРА В ТАЙМЛАЙН ===
    if (chat && chat.length > 0 && chat_metadata['bb_vn_char_traits'] && Object.keys(chat_metadata['bb_vn_char_traits']).length > 0) {
        const lastMsg = chat[chat.length - 1];
        const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        
        for (const cName in chat_metadata['bb_vn_char_traits']) {
            chat_metadata['bb_vn_char_traits'][cName].forEach(t => {
                lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName: cName, trait: t.trait, type: t.type });
            });
        }
        delete chat_metadata['bb_vn_char_traits'];
        needsSave = true;
    }

    if (!chat || !chat.length) {
        renderSocialHud();
        injectCombinedSocialPrompt();
        return;
    }

    chat.forEach((msg, idx) => {
        if (tryBindPendingChoiceContextToMessage(msg)) needsSave = true;

        if (msg?.is_user && msg.extra?.bb_vn_choice_context) {
            latestChoiceContext = msg.extra.bb_vn_choice_context;
        }

        if (scanAndCleanMessage(msg, idx)) needsSave = true;

        const swipeId = msg.swipe_id || 0;

       // --- СЧИТЫВАЕМ ЧЕРТЫ ХАРАКТЕРА ИЗ ЭТОГО СООБЩЕНИЯ ---
        const msgTraits = msg.extra?.bb_vn_char_traits_swipes?.[swipeId];
        if (msgTraits && Array.isArray(msgTraits)) {
            msgTraits.forEach(t => {
                const cName = t.charName;
                if (!cName || chat_metadata['bb_vn_ignored_chars'].includes(cName)) return;
                
               // === АВТО-ПОЧИНКА СЛОМАННЫХ ЧЕРТ (С ЗАСТРЯВШИМ JSON) ===
                if (t.trait && (t.trait.includes('```') || t.trait.includes('trait_type'))) {
                    const nameMatch = t.trait.match(/trait_type[\s"']*:[\s"']*([^,}\n"']+)/i);
                    const descMatch = t.trait.match(/description[\s"']*:[\s"']*([^}\n]+)/i);
                    
                    let extractedName = nameMatch ? nameMatch[1].trim() : '';
                    let extractedDesc = descMatch ? descMatch[1].replace(/["']/g, '').trim() : '';
                    
                    if (extractedName && extractedDesc) {
                        t.trait = `${extractedName}: ${extractedDesc}`;
                    } else if (extractedDesc) {
                        t.trait = extractedDesc;
                    } else {
                        // Безопасная регулярка, которая не ломает Markdown
                        t.trait = t.trait.replace(/`{3}json|`{3}/gi, '').replace(/[{}]/g, '').replace(/(trait_type|description)\s*:/gi, '').replace(/["']/g, '').trim();
                    }
                    needsSave = true;
                }
                
                if (!currentCalculatedStats[cName]) {
                    let base = chat_metadata['bb_vn_char_bases']?.[cName] ?? 0;
                    currentCalculatedStats[cName] = {
                        affinity: base, history: [], status: coerceUserFacingStatus("", base, "", 0),
                        memories: { soft: [], deep: [] }, core_traits: []
                    };
                }
                if (!currentCalculatedStats[cName].core_traits) currentCalculatedStats[cName].core_traits = [];
                currentCalculatedStats[cName].core_traits.push(t);
            });
        }

        let activeUpdates = msg.extra?.bb_social_swipes?.[swipeId];

        if (!activeUpdates || !Array.isArray(activeUpdates)) {
            if (msg.extra && msg.extra.bb_social_swipes) {
                for (const key in msg.extra.bb_social_swipes) {
                    if (Array.isArray(msg.extra.bb_social_swipes[key])) {
                        activeUpdates = msg.extra.bb_social_swipes[key];
                        break; 
                    }
                }
            }
        }

        if (activeUpdates && Array.isArray(activeUpdates)) {
            activeUpdates.forEach(update => {
                const charName = update.name;
                if (!charName || isCollectiveEntityName(charName)) return;
                if (chat_metadata['bb_vn_ignored_chars'].includes(charName)) return;

                const IMPACT_MAP = {
                    "unforgivable": -20, "major_negative": -8, "minor_negative": -2, "none": 0,
                    "minor_positive": 2, "major_positive": 8, "life_changing": 20
                };

                // Фолбэк для старых сохранений (impact_level)
                const f_delta = IMPACT_MAP[update.friendship_impact || update.impact_level] || 0;
                let r_delta = IMPACT_MAP[update.romance_impact] || 0;
                
                // Защита: если персонаж платонический, жестко обнуляем романтику
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (chat_metadata['bb_vn_platonic_chars'].includes(charName)) r_delta = 0;

                const currentStatus = update.role_dynamic || update.status || ""; 
                const currentEmotion = update.emotion || update.moodlet || "";
                
                if (!currentCalculatedStats[charName]) {
                    let base = 0;
                    let baseRomance = 0;
                    let isBrandNew = false;

                    if (chat_metadata['bb_vn_char_bases'] && chat_metadata['bb_vn_char_bases'][charName] !== undefined) {
                        base = parseInt(chat_metadata['bb_vn_char_bases'][charName]);
                    } else {
                        if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
                        chat_metadata['bb_vn_char_bases'][charName] = 0;
                        isBrandNew = true;
                        newlyDiscoveredChars.push(charName);
                    }
                    
                    if (!chat_metadata['bb_vn_char_bases_romance']) chat_metadata['bb_vn_char_bases_romance'] = {};
                    if (chat_metadata['bb_vn_char_bases_romance'][charName] !== undefined) {
                        baseRomance = parseInt(chat_metadata['bb_vn_char_bases_romance'][charName]);
                    }

                    currentCalculatedStats[charName] = {
                        affinity: base,
                        romance: baseRomance,
                        history: [],
                        status: coerceUserFacingStatus(currentStatus, base, "", f_delta),
                        memories: { soft: [], deep: [] },
                        core_traits: []
                    };
                    
                    if (isBrandNew) {
                        const formattedName = escapeHtml(charName).replace(/ /g, '<br>');
                        const introMoment = maybeAddStoryMoment({ type: 'intro', char: charName, title: 'Новый контакт', text: `${charName} появился в трекере отношений.` });
                        if (isNewMessage && idx === chat.length - 1) showStoryMomentToast(introMoment);
                    }
                }

                const previousAffinity = currentCalculatedStats[charName].affinity;
                const previousStatus = currentCalculatedStats[charName].status || "";
                
                // Применяем математику с лимитами
                currentCalculatedStats[charName].affinity += f_delta;
                currentCalculatedStats[charName].romance = (currentCalculatedStats[charName].romance || 0) + r_delta;
                
                if (currentCalculatedStats[charName].affinity > 100) currentCalculatedStats[charName].affinity = 100;
                if (currentCalculatedStats[charName].affinity < -100) currentCalculatedStats[charName].affinity = -100;
                if (currentCalculatedStats[charName].romance > 100) currentCalculatedStats[charName].romance = 100;
                if (currentCalculatedStats[charName].romance < -100) currentCalculatedStats[charName].romance = -100;

                const safeStatus = coerceUserFacingStatus(currentStatus, currentCalculatedStats[charName].affinity, previousStatus, f_delta);
                if (safeStatus) currentCalculatedStats[charName].status = safeStatus;

                const moodlet = sanitizeMoodlet(currentEmotion);
                // Для истории берем доминирующий сдвиг, чтобы не дублировать логи
                const isRomanceShift = Math.abs(r_delta) > Math.abs(f_delta);
                const dominantDelta = isRomanceShift ? r_delta : f_delta;
                
                currentCalculatedStats[charName].history.push({ delta: dominantDelta, reason: update.reason || "", moodlet });
                appendCharacterMemory(currentCalculatedStats[charName], dominantDelta, update.reason || "", moodlet);

                const previousTier = getTierInfo(previousAffinity).label;
                const newTier = getTierInfo(currentCalculatedStats[charName].affinity).label;
                let toastMoment = null;
                
                if (previousTier !== newTier) {
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: 'tier-shift', char: charName, title: 'Сдвиг в отношениях', text: `${charName}: статус изменился с «${previousTier}» на «${newTier}».` }));
                }

                // === ВОТ ЭТОТ БЛОК ДНЕВНИКА МЫ ПОТЕРЯЛИ ===
                if (Math.abs(dominantDelta) >= 2 && update.reason) {
                    const shift = getShiftDescriptor(dominantDelta, moodlet);
                    
                    // Если это романтика, используем новые типы моментов для розовой/красной обводки
                    let momentType = dominantDelta > 0 ? 'soft-positive' : 'soft-negative';
                    if (isRomanceShift) momentType = dominantDelta > 0 ? 'romance-positive' : 'romance-negative';
                    
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: momentType, char: charName, title: shift.full, text: `${charName}: ${update.reason}` }));
                }
                // ==========================================

                if (Math.abs(dominantDelta) >= 15 && update.reason) {
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: dominantDelta > 0 ? 'deep-positive' : 'deep-negative', char: charName, title: 'Незабываемое событие', text: `${charName}: ${update.reason}` }));
                }
                
                if (dominantDelta !== 0 && isNewMessage && idx === chat.length - 1 && toastMoment) {
                    showStoryMomentToast(toastMoment);
                }

                // === СИСТЕМНЫЙ ЖУРНАЛ: Восстанавливаем записи из истории ===
                if (f_delta !== 0 || r_delta !== 0) {
                    const totalDelta = f_delta + r_delta;
                    const logType = totalDelta > 0 ? 'plus' : (totalDelta < 0 ? 'minus' : 'system');
                    let pointsHtml = '';
                    
                    if (f_delta !== 0) {
                        const fSign = f_delta > 0 ? '+' : '';
                        pointsHtml += `<div class="bb-glog-points" style="margin-right: 4px; padding: 4px 10px; border-radius: 8px;">🤝 Доверие: ${fSign}${f_delta}</div>`;
                    }
                    if (r_delta !== 0) {
                        const rSign = r_delta > 0 ? '+' : '';
                        pointsHtml += `<div class="bb-glog-points" style="color: #f472b6; border-color: rgba(244,114,182,0.35); background: rgba(190,24,93,0.28); margin-right: 4px; padding: 4px 10px; border-radius: 8px;">💖 Влечение: ${rSign}${r_delta}</div>`;
                    }

                    let timeStr = "";
                    if (msg.send_date) {
                        try {
                            const d = new Date(msg.send_date);
                            timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                        } catch(e) {}
                    }
                    
                    const logText = `
                        <div class="bb-glog-main" style="display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%;">
                            <span class="bb-glog-char">${escapeHtml(charName)}</span>
                            ${moodlet ? `<span class="bb-glog-delta" style="align-self: flex-start;">${escapeHtml(moodlet)}</span>` : ''}
                        </div>
                        ${update.reason ? `<div class="bb-glog-reason" style="margin-top: 4px;">${escapeHtml(update.reason)}</div>` : ''}
                        <div style="display:flex; flex-wrap:wrap; margin-top:6px;">${pointsHtml}</div>
                    `;
                    addGlobalLog(logType, logText, timeStr);
                }
            });
        }
    });

    // === АРХИВАЦИЯ ПАМЯТИ ===
    for (const char in currentCalculatedStats) {
        const stats = currentCalculatedStats[char];
        if (!stats.core_traits) stats.core_traits = []; 
        
        let posTraitsCount = 0;
        let negTraitsCount = 0;
        let legacyTraitsCount = 0;

        stats.core_traits.forEach(t => {
            if (t.type === 'positive') posTraitsCount++;
            else if (t.type === 'negative') negTraitsCount++;
            else legacyTraitsCount++; 
        });

        const posToArchive = (posTraitsCount * 5) + (legacyTraitsCount * 5);
        const negToArchive = (negTraitsCount * 5) + (legacyTraitsCount * 5);

        stats.memories.archive = [];
        const newDeep = [];
        let posArchived = 0;
        let negArchived = 0;

        for (const m of stats.memories.deep) {
            if (m.tone === 'positive' && posArchived < posToArchive) {
                stats.memories.archive.push(m);
                posArchived++;
            } else if (m.tone === 'negative' && negArchived < negToArchive) {
                stats.memories.archive.push(m);
                negArchived++;
            } else {
                newDeep.push(m);
            }
        }
        stats.memories.deep = newDeep;
    }

    if (latestChoiceContext) {
        chat_metadata['bb_vn_choice_context'] = latestChoiceContext;
    } else if (chat_metadata['bb_vn_pending_choice_context']) {
        chat_metadata['bb_vn_choice_context'] = chat_metadata['bb_vn_pending_choice_context'];
    } else {
        delete chat_metadata['bb_vn_choice_context'];
    }

    if (needsSave) saveChatDebounced();
    injectCombinedSocialPrompt();
    renderSocialHud();

    if (newlyDiscoveredChars.length > 0) {
        handleNewCharacterInterviews(newlyDiscoveredChars);
    }
}

// Новая асинхронная функция для показа окон
async function handleNewCharacterInterviews(chars) {
    let madeChanges = false;
    
    // Вытаскиваем актуальное имя юзера из движка Таверны
    // @ts-ignore
    const userName = SillyTavern.getContext().substituteParams('{{user}}');

    for (const charName of chars) {
        // Нативный инпут-попап SillyTavern с реальным именем!
        const result = await callPopup(`<h3>Новая связь: ${escapeHtml(charName)}</h3><p>Этот персонаж впервые появился в трекере.<br>Задайте базовое отношение к <strong>${escapeHtml(userName)}</strong> (от -100 до 100).<br><br><span style="font-size:12px; color:#94a3b8;">0 — незнакомец, 50 — друг, -50 — враг.</span></p>`, 'input', '0');
        
        if (result !== undefined && result !== null && result !== false) {
            const parsed = parseInt(String(result).trim(), 10);
            if (!isNaN(parsed)) {
                chat_metadata['bb_vn_char_bases'][charName] = parsed;
                madeChanges = true;
            }
        }
    }
    
    // Если мы ввели новые базы, делаем быстрый пересчет, чтобы HUD обновился
    if (madeChanges) {
        saveChatDebounced();
        recalculateAllStats();
    }
}

// ==========================================
// ФАЗА 2: ОТРИСОВКА ХУДА (SOCIAL LINK)
// ==========================================
function renderSocialHud() {
    const characterEntries = Object.keys(currentCalculatedStats)
        .sort((a, b) => currentCalculatedStats[b].affinity - currentCalculatedStats[a].affinity);
    const visibleCharacters = characterEntries.length;
    const topCharacterName = visibleCharacters > 0 ? characterEntries[0] : '';
    const topAffinity = topCharacterName ? currentCalculatedStats[topCharacterName].affinity : 0;
    const deepMomentsCount = currentStoryMoments.filter(moment => String(moment.type || '').includes('deep')).length;
    const lastChoiceTone = chat_metadata['bb_vn_choice_context']?.tone || 'не зафиксирован';
    const latestMoment = currentStoryMoments.length > 0 ? currentStoryMoments[currentStoryMoments.length - 1] : null;

    const charsBox = document.getElementById('bb-hud-chars');
    if (charsBox) {
        if (visibleCharacters === 0) {
            charsBox.innerHTML = `
                <div class="bb-panel-hero bb-panel-hero-route">
                    <div class="bb-panel-kicker">Связи</div>
                    <div class="bb-panel-headline">Пока нет активных связей</div>
                    <div class="bb-panel-subtitle">Появится после сообщений, где есть взаимодействия с персонажами.</div>
                </div>
                <div class="bb-empty-hud">Здесь пока пусто.<br>Взаимодействуйте с персонажами.</div>
            `;
        } else {
            let cardsHtml = '';
            characterEntries.forEach((charName, index) => {
                const affinity = currentCalculatedStats[charName].affinity;
                const tier = getTierInfo(affinity);
                const baseAffinity = chat_metadata['bb_vn_char_bases']?.[charName] ?? 0;
                const memories = currentCalculatedStats[charName].memories || { soft: [], deep: [] };
                const displayStatus = currentCalculatedStats[charName].status || getUnforgettableRoleStatus(memories.deep) || tier.label;
                const unforgettableImpact = getUnforgettableImpact(memories.deep);
                const lastHistory = [...(currentCalculatedStats[charName].history || [])].reverse().find(h => h.delta !== 0);
                const lastShift = lastHistory ? getShiftDescriptor(lastHistory.delta, lastHistory.moodlet || '') : null;
                const lastShiftPoints = lastHistory ? formatAffinityPoints(lastHistory.delta) : '0';
                const lastShiftToneClass = lastHistory
                    ? (lastHistory.delta > 0 ? 'positive' : lastHistory.delta < 0 ? 'negative' : 'neutral')
                    : 'neutral';
                const spotlightLabel = index === 0 ? 'Главная связь' : index === 1 ? 'Важная связь' : 'Связь';
                const softCount = memories.soft.length;
                const allDeepMemories = [...(memories.archive || []), ...memories.deep];
                const deepCount = allDeepMemories.length;
                const trend = getTrendNarrative(currentCalculatedStats[charName].history || []); 

                let barStyle = '';
                if (affinity >= 0) {
                    const w = Math.min(100, affinity);
                    barStyle = `left: 50%; width: ${w / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
                } else {
                    const w = Math.min(100, Math.abs(affinity));
                    barStyle = `right: 50%; width: ${w / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
                }

                // РОМАНТИКА: Рисуем шкалу только если она не равна 0
                const romance = currentCalculatedStats[charName].romance || 0;
                let romanceBarStyle = '';
                if (romance >= 0) {
                    romanceBarStyle = `left: 50%; width: ${Math.min(100, romance) / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), #ec4899); box-shadow: 0 0 18px #ec4899;`;
                } else {
                    romanceBarStyle = `right: 50%; width: ${Math.min(100, Math.abs(romance)) / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), #ec4899); box-shadow: 0 0 18px #ec4899;`;
                }

                const romanceHtml = romance !== 0 ? `
                    <div class="bb-progress-wrapper bb-progress-wrapper-romance">
                        <div class="bb-progress-labels" style="color:#f472b6; position: relative;">
                            <span>Отторжение</span>
                            <span class="bb-label-center">Влечение <i class="fa-solid fa-heart" style="font-size:8px;"></i></span>
                            <span>Одержимость</span>
                        </div>
                        <div class="bb-progress-bg">
                            <div class="bb-progress-center-line"></div>
                            <div class="bb-progress-fill" style="${romanceBarStyle}"></div>
                        </div>
                    </div>
                ` : '';

                // Данные для редактора
                const baseRomance = chat_metadata['bb_vn_char_bases_romance']?.[charName] ?? 0;
                const isPlatonic = (chat_metadata['bb_vn_platonic_chars'] || []).includes(charName);

                const softMemoriesHtml = memories.soft.length > 0
                    ? [...memories.soft].reverse().map(memory => `<div class="bb-memory-pill ${memory.tone}">${escapeHtml(memory.text)}</div>`).join('')
                    : '<i style="color:#64748b; font-size: 11px;">Пока нет мягких следов</i>';

                const deepMemoriesHtml = allDeepMemories.length > 0
                    ? [...allDeepMemories].reverse().map(memory => `<div class="bb-memory-pill deep ${memory.tone}">${escapeHtml(memory.text)}</div>`).join('')
                    : '<i style="color:#64748b; font-size: 11px;">Ничего незабываемого</i>';

                const coreTraits = currentCalculatedStats[charName].core_traits || [];
                let posTraitsCount = 0;
                let negTraitsCount = 0;
                
                const traitsHtml = coreTraits.length > 0 
                    ? coreTraits.map(t => {
                        if (t.type === 'positive') posTraitsCount++;
                        else if (t.type === 'negative') negTraitsCount++;
                        
                        const isPos = t.type === 'positive';
                        const isNeg = t.type === 'negative';
                        const color = isPos ? '#4ade80' : (isNeg ? '#fb7185' : '#fbbf24');
                        const bg = isPos ? 'rgba(74, 222, 128, 0.12)' : (isNeg ? 'rgba(244, 63, 94, 0.12)' : 'rgba(251, 191, 36, 0.12)');
                        const shadow = isPos ? 'rgba(74, 222, 128, 0.2)' : (isNeg ? 'rgba(244, 63, 94, 0.2)' : 'rgba(251, 191, 36, 0.2)');
                        
                        // ФОРМАТИРОВАНИЕ ИМЕНИ ЧЕРТЫ
                        let traitText = escapeHtml(t.trait);
                        const colonIdx = traitText.indexOf(':');
                        // Если есть двоеточие недалеко от начала, делаем левую часть жирным заголовком
                        if (colonIdx !== -1 && colonIdx < 50) { 
                            const boldName = traitText.substring(0, colonIdx).trim();
                            const restDesc = traitText.substring(colonIdx + 1).trim();
                            traitText = `<b style="color:inherit; filter:brightness(1.5); text-transform:uppercase; font-size:10px; margin-right:4px; letter-spacing:0.5px;">${boldName}:</b> ${restDesc}`;
                        }
                        
                        return `<div class="bb-memory-pill deep" style="border-color:${color}; color:${color}; background:${bg}; box-shadow:0 0 12px ${shadow};"><i class="fa-solid fa-gem"></i> <span>${traitText}</span></div>`;
                    }).join('')
                    : '';

                const deepPos = memories.deep.filter(m => m.tone === 'positive');
                const deepNeg = memories.deep.filter(m => m.tone === 'negative');
                const deepPosCount = deepPos.length;
                const deepNegCount = deepNeg.length;
                
                // ПОКАЗЫВАТЬ ТРЕКЕР, если есть текущий прогресс ИЛИ если уже есть черта такого типа
                const showPosTracker = deepPosCount > 0 || posTraitsCount > 0;
                const showNegTracker = deepNegCount > 0 || negTraitsCount > 0;
                
                let crystalTrackerHtml = '';
                if (showPosTracker || showNegTracker) {
                    const buildRow = (count, type) => {
                        const isPos = type === 'positive';
                        const max = Math.min(5, count);
                        let gems = '';
                        for(let i=0; i<5; i++) {
                            gems += `<i class="${i < max ? 'fa-solid' : 'fa-regular'} fa-gem"></i>`;
                        }
                        
                        if (count >= 5) {
                            return `<button type="button" class="bb-crystal-row-btn ${type} bb-btn-crystallize-${isPos ? 'pos' : 'neg'}" data-char="${escapeHtml(charName)}">
                                        <div class="bb-cr-gems">${gems}</div>
                                        <span class="bb-cr-text"><i class="fa-solid fa-wand-magic-sparkles"></i> Создать ${isPos ? 'светлую' : 'мрачную'} черту</span>
                                    </button>`;
                        } else {
                            return `<div class="bb-crystal-row-static ${type}">
                                        <div class="bb-cr-gems">${gems}</div>
                                        <span class="bb-cr-text">${count} / 5</span>
                                    </div>`;
                        }
                    };

                    crystalTrackerHtml = `
                        <div class="bb-crystal-tracker">
                            ${showPosTracker ? buildRow(deepPosCount, 'positive') : ''}
                            ${showNegTracker ? buildRow(deepNegCount, 'negative') : ''}
                        </div>
                    `;
                }

                // Сборка идеальной карточки
                cardsHtml += `
                    <div class="bb-char-card" data-char="${escapeHtml(charName)}">
                        <div class="bb-char-card-shell">
                            <div class="bb-char-hero">
                                <div class="bb-char-identity" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
                                    
                                    <div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0;">
                                        <div class="bb-char-name" style="font-size: 16px; line-height: 1.15; display: flex; flex-direction: column; word-wrap: break-word;">
                                            ${escapeHtml(charName).split(' ').join('<br>')}
                                        </div>
                                        <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 2px; flex-wrap: wrap;">
                                            <span class="bb-char-score" style="color:${tier.color}; line-height: 1; font-size: 20px;">${affinity > 0 ? '+' : ''}${affinity}</span>
                                            ${romance !== 0 ? `<span style="font-size: 13px; font-weight: 700; color: #f472b6; display: flex; align-items: center; gap: 4px;"><i class="fa-solid fa-heart" style="font-size:10px;"></i>${romance > 0 ? '+' : ''}${romance}</span>` : ''}
                                        </div>
                                    </div>

                                    <div style="display: flex; align-items: flex-start; gap: 10px; text-align: right; flex-shrink: 0;">
                                        <div class="bb-char-subtitle" style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; margin: 0; padding-top: 2px;">
                                            <span class="bb-char-direction" style="margin-bottom: 0;"><i class="fa-solid fa-eye"></i> отношение к вам:</span>
                                            <div class="bb-char-signals" style="display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">
                                                <span class="bb-char-tier ${tier.class}" style="text-align: center; max-width: 130px; line-height: 1.3;" title="${escapeHtml(displayStatus)}">${escapeHtml(displayStatus)}</span>
                                                ${memories.deep.length > 0 ? `<span class="bb-unforgettable-impact" style="text-align: center; max-width: 130px; line-height: 1.3;">${escapeHtml(unforgettableImpact.label)}</span>` : ''}
                                            </div>
                                        </div>
                                        <button type="button" class="bb-char-edit-btn" data-char="${escapeHtml(charName)}" title="Настройки персонажа" style="background: none; border: none; color: #64748b; cursor: pointer; padding: 0; font-size: 14px; min-width: auto; margin-top: -2px;">
                                            <i class="fa-solid fa-sliders"></i>
                                        </button>
                                    </div>

                                </div>
                                <div class="bb-char-route-meta">
                                    <div class="bb-char-meta-card">
                                        <span class="bb-char-meta-label">Последний сдвиг</span>
                                        <strong style="color: ${lastShift ? lastShift.color : '#f8fafc'};">${escapeHtml(lastShiftPoints)}</strong>
                                    </div>
                                    <div class="bb-char-meta-card">
                                        <span class="bb-char-meta-label">Динамика</span>
                                        <strong style="color: #cbd5e1;">${escapeHtml(trend)}</strong>
                                    </div>
                                </div>
                            </div>
                            
                            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 6px; min-height: 30px;">
                                <div class="bb-progress-wrapper">
                                    <div class="bb-progress-labels">
                                        <span>Вражда</span>
                                        <span>Доверие</span>
                                        <span>Братство</span>
                                    </div>
                                    <div class="bb-progress-bg">
                                        <div class="bb-progress-center-line"></div>
                                        <div class="bb-progress-fill" style="${barStyle}"></div>
                                    </div>
                                </div>
                                ${romanceHtml.replace('margin-top: 8px;', '')}
                            </div>
                            
                            <div class="bb-char-insight-grid" style="margin-top: 6px;">
                                <div class="bb-char-insight-tile">
                                    <span class="bb-char-insight-label">Мягкие следы</span>
                                    <strong>${softCount}</strong>
                                </div>
                                <div class="bb-char-insight-tile">
                                    <span class="bb-char-insight-label">Глубокие следы</span>
                                    <strong>${deepCount}</strong>
                                </div>
                            </div>
                            ${crystalTrackerHtml}
                        </div>

                        ${(softCount > 0 || deepCount > 0) ? `
                        <div class="bb-char-log" style="border-radius: 0;">
                            ${coreTraits.length > 0 ? `
                            <div class="bb-memory-section" style="padding-top: 4px; margin-bottom: 8px;">
                                <div class="bb-memory-title" style="color:#fbbf24;">Черты Характера</div>
                                <div class="bb-memory-list bb-memory-list-deep">${traitsHtml}</div>
                            </div>` : ''}
                            ${softCount > 0 ? `
                            <div class="bb-memory-section" style="padding-top: 4px;">
                                <div class="bb-memory-title">Мягкие следы</div>
                                <div class="bb-memory-list">${softMemoriesHtml}</div>
                            </div>` : ''}
                            ${deepCount > 0 ? `
                            <div class="bb-memory-section">
                                <div class="bb-memory-title">Незабываемые события</div>
                                <div class="bb-memory-list bb-memory-list-deep">${deepMemoriesHtml}</div>
                            </div>` : ''}
                        </div>
                        ` : ''}

                        <div class="bb-char-editor" style="display:none; cursor: default; border-top: 1px solid rgba(255,255,255,0.06); border-radius: 0 0 22px 22px; margin: 0; background: rgba(0,0,0,0.2);">
                            <div class="bb-editor-title">Настройки связи</div>
                            <div class="bb-editor-hint">Измените стартовые очки или заблокируйте романтику.</div>
                            
                            <div style="display:flex; gap: 8px; margin-bottom: 8px;">
                                <div style="flex:1;">
                                    <span style="font-size: 9px; color:#94a3b8; text-transform:uppercase;">База Доверия:</span>
                                    <input type="number" class="text_pole bb-edit-base-input" value="${baseAffinity}" style="width:100%; box-sizing:border-box;">
                                </div>
                                <div style="flex:1;">
                                    <span style="font-size: 9px; color:#f472b6; text-transform:uppercase;">База Романтики:</span>
                                    <input type="number" class="text_pole bb-edit-romance-input" value="${baseRomance}" style="width:100%; box-sizing:border-box;">
                                </div>
                            </div>
                            
                            <label class="checkbox_label" style="margin-bottom: 10px;">
                                <input type="checkbox" class="bb-edit-platonic-cb" ${isPlatonic ? 'checked' : ''}>
                                <span style="font-size: 11px; color:#fca5a5;">Строго платонически (Блокирует флирт)</span>
                            </label>

                            <div class="bb-editor-actions">
                                <button class="menu_button bb-btn-save-char" data-char="${escapeHtml(charName)}" style="flex:1;"><i class="fa-solid fa-check"></i>&ensp;Сохранить</button>
                                <button class="menu_button bb-btn-hide-char" data-char="${escapeHtml(charName)}" style="flex:1; background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.35);"><i class="fa-solid fa-eye-slash"></i>&ensp;Скрыть</button>
                            </div>
                        </div>
                    </div>
                `;
            });


            charsBox.innerHTML = `
                <div class="bb-panel-hero bb-panel-hero-route">
                    <div class="bb-panel-kicker">Связи</div>
                    <div class="bb-panel-headline">Состояние отношений</div>
                    <div class="bb-panel-subtitle">Здесь показаны текущие связи, изменения и важные воспоминания по персонажам.</div>
                    <div class="bb-panel-stat-grid">
                        <div class="bb-panel-stat">
                            <span class="bb-panel-stat-label">Связей</span>
                            <strong>${visibleCharacters}</strong>
                        </div>
                        <div class="bb-panel-stat">
                            <span class="bb-panel-stat-label">Главный фокус</span>
                            <strong>${escapeHtml(topCharacterName || '—')}</strong>
                        </div>
                        <div class="bb-panel-stat">
                            <span class="bb-panel-stat-label">Макс. значение</span>
                            <strong>${topCharacterName ? (topAffinity > 0 ? '+' : '') + topAffinity : '—'}</strong>
                        </div>
                        <div class="bb-panel-stat">
                            <span class="bb-panel-stat-label">Глубоких следов</span>
                            <strong>${deepMomentsCount}</strong>
                        </div>
                    </div>
                </div>
                <div class="bb-route-card-stack">${cardsHtml}</div>
            `;

            $('.bb-char-card').off('click').on('click', function(e) {
                // Игнорируем клики по кнопкам внутри карточки
                if ($(e.target).closest('.bb-char-edit-btn, .bb-char-editor, .bb-btn-crystallize-pos, .bb-btn-crystallize-neg').length) return;
                $(this).toggleClass('expanded');
            });

            $('.bb-char-edit-btn').off('click').on('click', function(e) {
                e.stopPropagation();
                const card = $(this).closest('.bb-char-card');
                const editor = card.find('.bb-char-editor');
                editor.slideToggle(200);
            });

             $('.bb-btn-save-char').off('click').on('click', function() {
                const charName = $(this).attr('data-char');
                const editor = $(this).closest('.bb-char-editor');
                
                const newBase = parseInt(String(editor.find('.bb-edit-base-input').val()), 10);
                const newRomance = parseInt(String(editor.find('.bb-edit-romance-input').val()), 10);
                const isPlatonic = editor.find('.bb-edit-platonic-cb').is(':checked');
                
                if (!isNaN(newBase)) {
                    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
                    chat_metadata['bb_vn_char_bases'][charName] = newBase;
                }
                if (!isNaN(newRomance)) {
                    if (!chat_metadata['bb_vn_char_bases_romance']) chat_metadata['bb_vn_char_bases_romance'] = {};
                    chat_metadata['bb_vn_char_bases_romance'][charName] = newRomance;
                }
                
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (isPlatonic) {
                    if (!chat_metadata['bb_vn_platonic_chars'].includes(charName)) chat_metadata['bb_vn_platonic_chars'].push(charName);
                } else {
                    chat_metadata['bb_vn_platonic_chars'] = chat_metadata['bb_vn_platonic_chars'].filter(c => c !== charName);
                }

                saveChatDebounced();
                recalculateAllStats();
                notifySuccess("Настройки сохранены!");
            });
            
            $('.bb-btn-crystallize-pos, .bb-btn-crystallize-neg').off('click').on('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                const charName = $(this).attr('data-char');
                const isPositive = $(this).hasClass('bb-btn-crystallize-pos');
                const stats = currentCalculatedStats[charName];
                if (!stats) return;

                const targetMemories = stats.memories.deep.filter(m => m.tone === (isPositive ? 'positive' : 'negative'));
                if (targetMemories.length < 5) return;

                const btn = $(this);
                const originalHtml = btn.html();
                btn.html('<i class="fa-solid fa-spinner fa-spin"></i> Анализ воспоминаний...').css('pointer-events', 'none');

                const memoriesToCompress = targetMemories.slice(0, 5).map(m => m.text).join('; ');
                // @ts-ignore
                const userName = SillyTavern.getContext().substituteParams('{{user}}');

                const traitTypeStr = isPositive 
                    ? "ПОЛОЖИТЕЛЬНУЮ перманентную черту характера (Привязанность, Преданность, Особое доверие, Теплота)" 
                    : "НЕГАТИВНУЮ перманентную черту характера (Травма, Фобия, Одержимость, Глубокая обида)";

                const prompt = `Вот 5 незабываемых событий, произошедших между ${charName} и ${userName}:\n${memoriesToCompress}\n\nПроанализируй их и создай ОДНУ ${traitTypeStr}, которая сформировалась у ${charName} по отношению к ${userName} из-за этого.\n\nПРАВИЛА ВЫВОДА:\n1. ВЕРНИ ТОЛЬКО ОДНУ СТРОКУ в формате "Название: Описание".\n2. Название — 1-3 слова. Описание — одно короткое предложение.\n3. НИКАКОГО JSON, никаких скобок или ключей.\n\nПРИМЕР:\n${isPositive ? 'Абсолютное доверие: Алиса прониклась глубоким доверием и теперь всегда ищет защиты.' : 'Параноидальный страх: У Алисы сформировался глубокий страх потери, из-за чего она болезненно реагирует на уход.'}`;

                try {
                    let result = await generateFastPrompt(prompt);
                    result = String(result).replace(/["']/g, '').trim();
                    if (result) {
                        const chat = SillyTavern.getContext().chat;
                        if (chat && chat.length > 0) {
                            const lastMsg = chat[chat.length - 1];
                            const sId = lastMsg.swipe_id || 0;
                            if (!lastMsg.extra) lastMsg.extra = {};
                            if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
                            if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
                            
                            lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName: charName, trait: result, type: isPositive ? 'positive' : 'negative' });
                            
                            saveChatDebounced();
                            recalculateAllStats();
                            notifySuccess(`Черта характера для ${charName} кристаллизована!`);
                        }
                    } else { throw new Error("Пустой ответ от ИИ"); }
                } catch (e) {
                    console.error(e);
                    notifyError("Не удалось кристаллизовать память.");
                    btn.html(originalHtml).css('pointer-events', 'auto');
                }
            });

            $('.bb-btn-hide-char').off('click').on('click', async function() {
                const charName = $(this).attr('data-char');
                
                // Нативный Popup SillyTavern 1.17!
                const confirmed = await callPopup(`<h3>Скрыть персонажа?</h3><p>Персонаж <strong>${charName}</strong> пропадёт из трекера. Его можно будет вернуть в настройках расширения.</p>`, 'confirm');
                
                if (!confirmed) return;
                
                if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];
                if (!chat_metadata['bb_vn_ignored_chars'].includes(charName)) {
                    chat_metadata['bb_vn_ignored_chars'].push(charName);
                }
                saveChatDebounced();
                recalculateAllStats();
                notifyInfo(`${charName} скрыт.`);
            });
        }
    }

    const logBox = document.getElementById('bb-hud-log');
    if (logBox) {
        const logs = chat_metadata['bb_vn_global_log'] || [];
        const promptPreviewHtml = `
            <div class="bb-panel-hero bb-panel-hero-system">
                <div class="bb-panel-kicker">Журнал</div>
                <div class="bb-panel-headline">Системный журнал</div>
                <div class="bb-panel-subtitle">Здесь показаны изменения отношений и текущий инжектируемый prompt.</div>
                <div class="bb-panel-stat-grid">
                    <div class="bb-panel-stat">
                        <span class="bb-panel-stat-label">Событий</span>
                        <strong>${logs.length}</strong>
                    </div>
                    <div class="bb-panel-stat">
                        <span class="bb-panel-stat-label">Последний тон выбора</span>
                        <strong>${escapeHtml(lastChoiceTone)}</strong>
                    </div>
                    <div class="bb-panel-stat">
                        <span class="bb-panel-stat-label">Последнее событие</span>
                        <strong>${escapeHtml(latestMoment?.title || '—')}</strong>
                    </div>
                    <div class="bb-panel-stat">
                        <span class="bb-panel-stat-label">Инжект</span>
                        <strong>Текущий prompt</strong>
                    </div>
                </div>
            </div>
            <details class="bb-prompt-card" open>
                <summary class="bb-prompt-summary">
                    <span>🧠 Inject Prompt</span>
                    <button type="button" class="menu_button bb-copy-prompt-btn"><i class="fa-solid fa-copy"></i>&nbsp; Копировать</button>
                </summary>
                <div class="bb-prompt-hint">Текущий системный текст, который BB VNE добавляет в инжект.</div>
                <pre class="bb-prompt-pre">${escapeHtml(getCombinedSocial())}</pre>
            </details>
        `;
        if (logs.length === 0) {
            logBox.innerHTML = `${promptPreviewHtml}<div class="bb-empty-hud">Журнал событий пуст.</div>`;
        } else {
            let logHtml = '<div class="bb-system-log-list">';
            [...logs].reverse().forEach(log => {
                logHtml += `
                    <div class="bb-glog-item ${log.type}">
                        <span class="bb-glog-time">[${log.time}]</span>
                        <span class="bb-glog-text">${log.text}</span>
                    </div>
                `;
            });
            logHtml += '</div>';
            logBox.innerHTML = promptPreviewHtml + logHtml;
        }

        const copyPromptBtn = logBox.querySelector('.bb-copy-prompt-btn');
        if (copyPromptBtn) {
            copyPromptBtn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(getCombinedSocial());
                    notifySuccess("Prompt скопирован!");
                } catch (error) {
                    notifyError("Не удалось скопировать prompt.");
                }
            });
        }
    }

    const momentsBox = document.getElementById('bb-hud-moments');
    if (momentsBox) {
        if (currentStoryMoments.length === 0) {
            momentsBox.innerHTML = `
                <div class="bb-panel-hero bb-panel-hero-diary">
                    <div class="bb-panel-kicker">Дневник событий</div>
                    <div class="bb-panel-headline">Дневник ещё пуст</div>
                    <div class="bb-panel-subtitle">Здесь будут сохраняться важные изменения и заметные события.</div>
                </div>
                <div class="bb-empty-hud">Памятные моменты пока не накопились.</div>
            `;
        } else {
            let momentsHtml = `
                <div class="bb-panel-hero bb-panel-hero-diary">
                    <div class="bb-panel-kicker">Дневник событий</div>
                    <div class="bb-panel-headline">События</div>
                    <div class="bb-panel-subtitle">Здесь собраны важные события, которые расширение зафиксировало по ходу чата.</div>
                    <div class="bb-panel-stat-grid">
                        <div class="bb-panel-stat">
                            <span class="bb-panel-stat-label">Записей</span>
                            <strong>${currentStoryMoments.length}</strong>
                        </div>
                        <div class="bb-panel-stat">
                            <span class="bb-panel-stat-label">Последняя</span>
                            <strong>${escapeHtml(currentStoryMoments[currentStoryMoments.length - 1]?.title || '—')}</strong>
                        </div>
                    </div>
                </div>
                <div class="bb-diary-stack">
            `;
            [...currentStoryMoments].reverse().forEach((moment, index) => {
                momentsHtml += `
                    <div class="bb-moment-card ${escapeHtml(moment.type || 'neutral')}">
                        <div class="bb-moment-pin"></div>
                        <div class="bb-moment-header">
                            <div class="bb-moment-meta">
                                <span class="bb-moment-stamp">Запись ${currentStoryMoments.length - index}</span>
                                <span class="bb-moment-char">${escapeHtml(moment.char || 'Сцена')}</span>
                            </div>
                            <span class="bb-moment-title">${escapeHtml(moment.title)}</span>
                        </div>
                        <div class="bb-moment-divider"></div>
                        <div class="bb-moment-body">
                            <div class="bb-moment-text">${escapeHtml(moment.text)}</div>
                        </div>
                    </div>
                `;
            });
            momentsHtml += '</div>';
            momentsBox.innerHTML = momentsHtml;
        }
    }

    syncToastContainerWithHud();
}

function updateHudVisibility() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const hasActiveChat = Boolean(chatId);

    if (hasActiveChat) {
        $('#bb-social-hud-toggle').show();
        $('#bb-social-hud-mobile-launcher').show();
    } else {
        $('#bb-social-hud-toggle').hide();
        $('#bb-social-hud-mobile-launcher').hide();
        closeSocialHud();
    }
    syncToastContainerWithHud();
}

function openSocialHud() {
    const hud = $('#bb-social-hud');
    if (!hud.length) return;

    hud.addClass('open');
    $('#bb-social-hud-backdrop').addClass('open');
    $('body').addClass('bb-social-hud-active');
    $('#bb-social-toast-container').addClass('hud-open');
    $('#bb-hud-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right');
    renderSocialHud();
    syncToastContainerWithHud();
}

function closeSocialHud() {
    $('#bb-social-hud').removeClass('open');
    $('#bb-social-hud-backdrop').removeClass('open');
    $('body').removeClass('bb-social-hud-active');
    $('#bb-social-toast-container').removeClass('hud-open');
    $('#bb-hud-arrow').removeClass('fa-chevron-right').addClass('fa-chevron-left');
    syncToastContainerWithHud();
}

function ensureHudContainer() {
    if (document.getElementById('bb-social-hud')) return;
    const hudHtml = `
        <button type="button" id="bb-social-hud-backdrop" aria-label="Закрыть HUD"></button>
        <button type="button" id="bb-social-hud-mobile-launcher" aria-label="Открыть HUD">
            <i class="fa-solid fa-users-viewfinder"></i>
            <span>VNE</span>
        </button>
        <div id="bb-social-hud">
            <div id="bb-social-hud-toggle" title="VNE HUD">
                <i class="fa-solid fa-users-viewfinder"></i>
                <span class="bb-toggle-label">VNE</span>
                <i class="fa-solid fa-chevron-left" id="bb-hud-arrow"></i>
            </div>
            <div class="bb-hud-header">
                <div class="bb-hud-header-top">
                    <span class="bb-hud-badge">Visual Novel Engine</span>
                    <div class="bb-hud-status-row">
                        <span class="bb-hud-live-dot"><i class="fa-solid fa-circle"></i> активно</span>
                        <button type="button" class="bb-hud-mobile-close" aria-label="Закрыть HUD">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
                <div class="bb-hud-title">VNE</div>
                <div class="bb-hud-subtitle">связи · журнал · дневник событий</div>
            </div>
            
            <div class="bb-hud-tabs">
                <div class="bb-hud-tab active" data-tab="chars"><i class="fa-solid fa-heart-pulse"></i><span>Связи</span></div>
                <div class="bb-hud-tab" data-tab="log"><i class="fa-solid fa-terminal"></i><span>Система</span></div>
                <div class="bb-hud-tab" data-tab="moments"><i class="fa-solid fa-book-open"></i><span>Дневник</span></div>
            </div>
            <div class="bb-hud-content active" id="bb-hud-chars"></div>
            <div class="bb-hud-content" id="bb-hud-log"></div>
            <div class="bb-hud-content" id="bb-hud-moments"></div>
        </div>
    `;
    $('body').append(hudHtml);

    $('.bb-hud-tab').on('click', function() {
        $('.bb-hud-tab').removeClass('active');
        $('.bb-hud-content').removeClass('active');
        $(this).addClass('active');
        $(`#bb-hud-${$(this).data('tab')}`).addClass('active');
    });

    $('#bb-social-hud-toggle').on('click', function() {
        if ($('#bb-social-hud').hasClass('open')) {
            closeSocialHud();
        } else {
            openSocialHud();
        }
    });

    $('#bb-social-hud-mobile-launcher').on('click', function() {
        openSocialHud();
    });

    $('#bb-social-hud-backdrop, .bb-hud-mobile-close').on('click', function() {
        closeSocialHud();
    });

    const toggleElement = document.getElementById('bb-social-hud-toggle');
    let toggleIdleTimer = null;
    const scheduleToggleIdle = () => {
        if (!toggleElement) return;
        window.clearTimeout(toggleIdleTimer);
        toggleElement.classList.remove('bb-toggle-idle');
        if (window.innerWidth > 760) return;
        toggleIdleTimer = window.setTimeout(() => {
            toggleElement.classList.add('bb-toggle-idle');
        }, 1500);
    };
    scheduleToggleIdle();

    if (toggleElement) {
        ['pointerdown', 'touchstart', 'mouseenter', 'focus'].forEach(eventName => {
            toggleElement.addEventListener(eventName, scheduleToggleIdle);
        });
    }

    let lastHudTouchTap = 0;
    $('#bb-social-hud').on('pointerup', function(event) {
        if (!event || event.pointerType !== 'touch') return;
        const now = Date.now();
        if (now - lastHudTouchTap <= 320) {
            lastHudTouchTap = 0;
            closeSocialHud();
            return;
        }
        lastHudTouchTap = now;
    });

    $('#bb-social-hud').on('dblclick', function() {
        closeSocialHud();
    });

    window.addEventListener('resize', function() {
        if (window.innerWidth > 760) {
            $('#bb-social-hud-backdrop').removeClass('open');
            $('body').removeClass('bb-social-hud-active');
        } else if ($('#bb-social-hud').hasClass('open')) {
            $('#bb-social-hud-backdrop').addClass('open');
            $('body').addClass('bb-social-hud-active');
        }
        scheduleToggleIdle();
        syncToastContainerWithHud();
    });

    window.addEventListener('hashchange', function() {
        updateHudVisibility();
    });

    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) updateHudVisibility();
    });
}

// ==========================================
// ФАЗА 3: ИНТЕРАКТИВНОЕ КИНО С КЭШИРОВАНИЕМ
// ==========================================

const OPTIONS_PROMPT = `Analyze the recent chat. Generate exactly 3 highly distinct, engaging actions {{user}} can take right now to DRIVE THE STORY FORWARD.

CRITICAL: Your generated messages MUST logically continue from the VERY LAST sentence of the [IMMEDIATE TRIGGER]. Do not ignore the character's final question, movement, or action. React directly to it!

For EACH action, write a LONG, HIGHLY DETAILED roleplay message (2-4 paragraphs) from {{user}}'s perspective. Include rich sensory details, deep internal monologues, and complex actions. DO NOT just react passively; make {{user}} take initiative to progress the plot or shift the dynamic. Match {{user}}'s persona perfectly. Write in Russian.

CRITICAL RULES FOR EMOTIONAL CHOICE FRAMING:
1. "tone": Describe the emotional flavor of the answer in 1-2 Russian words. Think in placeholder terms like "SHORT_RUSSIAN_TONE".
2. "forecast": A SHORT Russian hint for what this action may cause. Think in placeholder terms like "SHORT_RUSSIAN_OUTCOME_HINT".
3. "targets": Array of 1-3 character names that are most affected by this action. If no single character stands out, return an empty array.
4. "risk": OPTIONAL legacy field for backward compatibility. If you include it, use "Низкий", "Средний", or "Высокий". Do not make it the main focus.
5. "intent": Must be a natural Russian phrase (2-5 words). Never use placeholders, ALL_CAPS tokens, snake_case, or English-only labels.

CRITICAL JSON AND FORMATTING RULES:
1. Return STRICTLY a valid JSON array. DO NOT output any conversational text outside the JSON.
2. INSIDE the "message" field, you MUST use standard roleplay formatting: asterisks for *actions/thoughts* and quotes for dialogue.
3. NEVER use standard double quotes (") inside the "message" text! Use ONLY guillemets (« ») or single quotes (' ') for dialogue and thoughts to avoid breaking the JSON.
4. To create paragraphs, use escaped newlines (\\n\\n) inside the "message" string. DO NOT use actual line breaks in the string, or it will break the JSON.
5. Each option must be clearly different in intent from the others. Never output near-duplicates with only wording changes.

Use this SHORT JSON SHAPE as a template. The placeholders below are instructions, not literal values. Return exactly 3 objects with this structure:
[
  {
    "intent": "SHORT_ACTION_LABEL",
    "tone": "SHORT_RUSSIAN_TONE",
    "forecast": "SHORT_RUSSIAN_OUTCOME_HINT",
    "targets": ["MOST_AFFECTED_CHARACTER"],
    "risk": "OPTIONAL_RISK_LABEL",
    "message": "LONG_RUSSIAN_ROLEPLAY_REPLY_WITH_ESCAPED_QUOTES_AND_\\n\\n_PARAGRAPHS"
  }
]

[USER PERSONA REFERENCE]:
{{persona}}

[RECENT CONTEXT (For background)]:
"""{{chat}}"""

[IMMEDIATE TRIGGER (You MUST directly respond to the exact ending of this message)]:
"""{{lastMessage}}"""`;

// ============================================

async function runMainGen(promptText) {
    if (typeof generateQuietPrompt === 'function') {
        return await generateQuietPrompt(promptText);
    } else if (typeof window['generateQuietPrompt'] === 'function') {
        return await window['generateQuietPrompt'](promptText);
    } else {
        throw new Error("Функция генерации Таверны не найдена. Обновите SillyTavern.");
    }
}

async function generateFastPrompt(promptText) {
    const s = extension_settings[MODULE_NAME];
    if (s.useCustomApi && s.customApiUrl && s.customApiModel) {
        try {
            vnGenerationAbortController = new AbortController();
            const baseUrl = s.customApiUrl.replace(/\/$/, '');
            const endpoint = baseUrl + '/chat/completions';
            
            const response = await fetch(endpoint, {
                method: 'POST',
                signal: vnGenerationAbortController.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${s.customApiKey || ''}`
                },
                body: JSON.stringify({
                    model: s.customApiModel,
                    messages: [
                        { role: 'system', content: 'You are an internal JSON generator. You MUST output ONLY valid JSON format. No conversational text.' },
                        { role: 'user', content: promptText }
                    ],
                    temperature: 0.7,
                    max_tokens: 4000,
                    stream: false
                })
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content || "";
            if (!content.trim()) throw new Error("Прокси вернул пустой текст (Сработал фильтр).");
            return content;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error("Отменено пользователем");
            console.warn(`[BB VN] Ошибка кастомного API (${e.message}), перехват на основной API...`);
            return await runMainGen(promptText);
        } finally {
            vnGenerationAbortController = null;
        }
    } else {
        return await runMainGen(promptText);
    }
}

// ОТРИСОВКА КНОПОК ИЗ МАССИВА (РАБОТАЕТ ДЛЯ ГЕНЕРАЦИИ И КЭША)
window['renderVNOptionsFromData'] = function(/** @type {VNOption[]} */ parsedOptions, autoOpen = false) {
    let optionsHtml = '';
    const useEmotionalChoiceFraming = !!extension_settings[MODULE_NAME].emotionalChoiceFraming;
    parsedOptions.forEach(rawOption => {
        const opt = normalizeOptionData(rawOption);
        let riskClass = 'risk-med';
        const r = (opt.risk || '').toLowerCase();
        if (r.includes('низкий') || r.includes('low')) riskClass = 'risk-low';
        if (r.includes('высокий') || r.includes('high')) riskClass = 'risk-high';
        const toneClass = getToneClass(opt.tone);
        const metaLabel = useEmotionalChoiceFraming
            ? (opt.tone || opt.risk || 'Нейтрально')
            : (opt.risk || opt.tone || 'Средний');
        const targetsText = opt.targets.length > 0
            ? opt.targets.map(target => `<span class="bb-vn-target">${escapeHtml(target)}</span>`).join('')
            : `<span class="bb-vn-target muted">Сцена в целом</span>`;
        
        const forecastHtml = useEmotionalChoiceFraming && opt.forecast
            ? `<div class="bb-vn-forecast-hover"><div class="bb-vn-forecast-title">Прогноз</div><div class="bb-vn-forecast-text">${escapeHtml(opt.forecast)}</div></div>`
            : '';

        const infoBtnHtml = `<div class="bb-vn-op-info-btn" title="Подробнее"><i class="fa-solid fa-info"></i></div>`;

        optionsHtml += `
            <div class="bb-vn-option ${riskClass} ${toneClass}" data-intent="${escapeHtml(opt.intent)}" data-message="${encodeURIComponent(opt.message || '')}" data-tone="${escapeHtml(opt.tone || '')}" data-forecast="${escapeHtml(opt.forecast || '')}" data-targets="${encodeURIComponent(JSON.stringify(opt.targets ||[]))}">
                <div class="bb-vn-op-topline">
                    <span class="bb-vn-op-index">Сцена</span>
                    <div class="bb-vn-op-risk">${useEmotionalChoiceFraming ? 'Тон' : 'Риск'}: ${escapeHtml(metaLabel)}</div>
                    ${infoBtnHtml}
                </div>
                <div class="bb-vn-op-head">${escapeHtml(opt.intent)}</div>
                ${useEmotionalChoiceFraming ? `<div class="bb-vn-targets">${targetsText}</div>` : ''}
                ${forecastHtml}
            </div>
        `;
    });
    
    optionsHtml += `
        <div class="bb-vn-utility-row">
            <div class="bb-vn-option risk-med bb-vn-utility-card bb-vn-utility-compact" id="bb-vn-btn-reroll" title="Реролл вариантов" aria-label="Реролл вариантов">
                <i class="fa-solid fa-rotate-right"></i>
                <span class="bb-vn-sr-only">Реролл вариантов</span>
            </div>
            <div class="bb-vn-option risk-med bb-vn-utility-card bb-vn-utility-compact" id="bb-vn-btn-cancel" title="Свернуть варианты" aria-label="Свернуть варианты">
                <i class="fa-solid fa-chevron-up"></i>
                <span class="bb-vn-sr-only">Свернуть варианты</span>
            </div>
        </div>
    `;

    $('#bb-vn-options-container').html(optionsHtml);

    if (autoOpen) {
        $('#bb-vn-options-container').addClass('active');
        $('#bb-vn-btn-generate').removeClass('loading').hide();
    } else {
        $('#bb-vn-options-container').removeClass('active');
        $('#bb-vn-btn-generate').removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> VN · сохранено').show();
    }

    // Клик по самой карточке: МОМЕНТАЛЬНАЯ ОТПРАВКА
    $('.bb-vn-option[data-intent]').off('click').on('click', function(e) {
        // Если кликнули по кнопке [i], останавливаем выполнение (не отправляем текст)
        if ($(e.target).closest('.bb-vn-op-info-btn').length > 0) return;

        const message = decodeURIComponent($(this).attr('data-message') || '');
        const targetsRaw = decodeURIComponent($(this).attr('data-targets') || '[]');
        let parsedTargets =[];
        try {
            parsedTargets = JSON.parse(targetsRaw);
        } catch (e) {}
        const choiceContext = {
            intent: $(this).attr('data-intent') || '',
            tone: $(this).attr('data-tone') || '',
            forecast: $(this).attr('data-forecast') || '',
            targets: Array.isArray(parsedTargets) ? parsedTargets :[],
            at: Date.now(),
            messagePreview: message.slice(0, 140),
        };
        chat_metadata['bb_vn_choice_context'] = choiceContext;
        chat_metadata['bb_vn_pending_choice_context'] = choiceContext;
        saveChatDebounced();
        injectCombinedSocialPrompt();
        
        const textarea = document.querySelector('#send_textarea');
        if (textarea && message) {
            // @ts-ignore
            textarea.value = message;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            
            if (extension_settings[MODULE_NAME].autoSend) {
                $('#bb-vn-options-container').removeClass('active');
                $('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия VN');
                const sendBtn = document.getElementById('send_but');
                if (sendBtn) sendBtn.click();
            }
        }
    });

    // Клик по кнопке [ i ]: РАЗВОРАЧИВАЕТ ГАРМОШКУ
    $('.bb-vn-op-info-btn').off('click').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const card = $(this).closest('.bb-vn-option');
        const wasExpanded = card.hasClass('info-expanded');
        
        // Закрываем все открытые гармошки (по желанию, но так аккуратнее)
        $('.bb-vn-option').removeClass('info-expanded');
        
        // Если текущая была закрыта — открываем
        if (!wasExpanded) {
            card.addClass('info-expanded');
        }
    });

    $('#bb-vn-btn-cancel').off('click').on('click', function() {
        $('#bb-vn-options-container').removeClass('active');
        $('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия VN');
    });

    $('#bb-vn-btn-reroll').off('click').on('click', async function() {
        const previousIntents = $('#bb-vn-options-container .bb-vn-option[data-intent]')
            .map(function() { return $(this).attr('data-intent') || ''; })
            .get()
            .filter(Boolean);
        await window['bbVnGenerateOptionsFlow'](previousIntents);
    });
};

window['bbVnGenerateOptionsFlow'] = async function(excludedIntents = []) {
    const btn = $('#bb-vn-btn-generate');
    
    // ЕСЛИ КНОПКА КРУТИТСЯ И МЫ НАЖАЛИ ЕЁ — ЭТО ОТМЕНА!
    if (btn.hasClass('loading')) {
        isVnGenerationCancelled = true;
        if (vnGenerationAbortController) vnGenerationAbortController.abort();
        btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия VN').show();
        notifyInfo("Генерация вариантов отменена");
        return;
    }

    isVnGenerationCancelled = false;

    // Классический надежный визуальный лоадер на кнопке (теперь с крестиком)
    btn.show().addClass('loading').html('<i class="fa-solid fa-spinner fa-spin"></i> Сценарий в обработке... <i class="fa-solid fa-xmark" style="margin-left: 6px; color: #ef4444;" title="Отменить"></i>');
    $('#bb-vn-options-container').removeClass('active').empty();

    try {
        const chat = SillyTavern.getContext().chat;
        if (!chat || chat.length === 0) throw new Error("Чат пуст");
        
        const recentMessages = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');
        const lastMessageText = chat[chat.length - 1] ? chat[chat.length - 1].mes : ""; 

        // @ts-ignore
        const persona = SillyTavern.getContext().substituteParams('{{persona}}');
        
        let prompt = OPTIONS_PROMPT
            .replace('{{chat}}', recentMessages)
            .replace('{{persona}}', persona)
            .replace('{{lastMessage}}', lastMessageText); 

        const cleanedExcludedIntents = Array.isArray(excludedIntents)
            ? excludedIntents.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        if (cleanedExcludedIntents.length > 0) {
            prompt += `\n\n[DO NOT REPEAT THESE PREVIOUS ACTION IDEAS]\n${cleanedExcludedIntents.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}\nGenerate clearly different actions.`;
        }

        if (typeof window['bbGetSceneDirectorPrompt'] === 'function') {
            const sceneVibe = window['bbGetSceneDirectorPrompt']();
            if (sceneVibe) {
                console.log("[BB VNE] 🎬 Успешно подхватили стиль Режиссёра:\n", sceneVibe);
                prompt = sceneVibe + "\n\n" + prompt;
            }
        }

        const result = await generateFastPrompt(prompt);

        // ПРОВЕРКА ПОСЛЕ ГЕНЕРАЦИИ: Если успели нажать отмену, выбрасываем результат
        if (isVnGenerationCancelled) throw new Error("Отменено пользователем");

        let cleanResult = String(result || "").trim();
        cleanResult = cleanResult.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
        
        const start = cleanResult.indexOf('[');
        const end = cleanResult.lastIndexOf(']');
        if (start !== -1 && end !== -1) {
            cleanResult = cleanResult.substring(start, end + 1);
        } else {
            cleanResult = '[' + cleanResult.replace(/}\s*{/g, '},{') + ']';
        }
        cleanResult = cleanResult.replace(/,\s*([\]}])/g, '$1');

        /** @type {VNOption[]} */
        let parsedOptions;
        try {
            parsedOptions = JSON.parse(cleanResult);
        } catch (err) {
            parsedOptions = [];
            const intentMatches = extractJsonStringMatches(cleanResult, 'intent');
            const toneMatches = extractJsonStringMatches(cleanResult, 'tone');
            const forecastMatches = extractJsonStringMatches(cleanResult, 'forecast');
            const riskMatches = extractJsonStringMatches(cleanResult, 'risk');
            const messageMatches = extractJsonStringMatches(cleanResult, 'message|text|action|reply|response|dialogue|content|description');
            const targetsMatches = [...cleanResult.matchAll(/"targets"\s*:\s*\[([^\]]*)\]/gi)].map(m =>
                m[1].split(',').map(item => item.replace(/["']/g, '').trim()).filter(Boolean)
            );
            
            for (let i = 0; i < intentMatches.length; i++) {
                parsedOptions.push({
                    intent: intentMatches[i],
                    tone: toneMatches[i] || "",
                    forecast: forecastMatches[i] || "",
                    targets: targetsMatches[i] || [],
                    risk: riskMatches[i] || "Средний",
                    message: messageMatches[i] || ""
                });
            }
            if (parsedOptions.length === 0) throw new Error("Модель вернула сломанный код.");
        }

        if (parsedOptions && parsedOptions.length > 0) {
            parsedOptions = dedupeOptions(parsedOptions);
            if (parsedOptions.length < 3) throw new Error("Модель вернула слишком похожие варианты. Попробуйте реролл ещё раз.");
            
            const lastMsg = chat[chat.length - 1];
            const swipeId = lastMsg.swipe_id || 0;
            if (!lastMsg.extra) lastMsg.extra = {};
            if (!lastMsg.extra.bb_vn_options_swipes) lastMsg.extra.bb_vn_options_swipes = {};
            lastMsg.extra.bb_vn_options_swipes[swipeId] = parsedOptions;
            saveChatDebounced();

            window['renderVNOptionsFromData'](parsedOptions, true);
        } else { throw new Error("Ответ пуст"); }

    } catch (e) {
        if (e.message !== "Отменено пользователем") {
            console.error("[BB VN] Ошибка генерации:", e);
            // @ts-ignore
            notifyError("Не удалось сгенерировать варианты");
            btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия VN').show();
        }
    }
};

// ВОССТАНОВЛЕНИЕ КЭША ПРИ СВАЙПЕ
window['restoreVNOptions'] = function(autoOpen = false) {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) {
        window['clearVNOptions']();
        return;
    }
    const lastMsg = chat[chat.length - 1];
    if (lastMsg.is_user) {
        window['clearVNOptions']();
        return;
    }
    const swipeId = lastMsg.swipe_id || 0;
    const savedOptions = lastMsg.extra?.bb_vn_options_swipes?.[swipeId];

    if (savedOptions && Array.isArray(savedOptions) && savedOptions.length > 0) {
        window['renderVNOptionsFromData'](savedOptions, autoOpen);
    } else {
        window['clearVNOptions']();
    }
};

// ОЧИСТКА ВАРИАНТОВ ПРИ СМЕНЕ КОНТЕКСТА
window['clearVNOptions'] = function() {
    $('#bb-vn-options-container').empty().removeClass('active');
    const ta = document.querySelector('#send_textarea');
    // @ts-ignore
    if (!ta || ta.value.trim().length === 0) {
        $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия VN');
    }
};

function injectVNActionsUI() {
    if (document.getElementById('bb-vn-action-bar')) return;

    const barHtml = `
        <div id="bb-vn-action-bar" style="display: flex;">
            <div id="bb-vn-btn-generate" class="bb-vn-main-btn">
                <i class="fa-solid fa-clapperboard"></i> Действия VN
            </div>
            <div id="bb-vn-options-container"></div>
        </div>
    `;

    $('#send_form').prepend(barHtml);

    const ta = document.querySelector('#send_textarea');
    if (ta) {
        ta.addEventListener('input', () => {
            const btnGen = document.getElementById('bb-vn-btn-generate');
            const opts = document.getElementById('bb-vn-options-container');
            if (!btnGen || !opts) return;
            
            // @ts-ignore
            if (ta.value.trim().length > 0) {
                btnGen.style.display = 'none';
            } else if (!opts.classList.contains('active')) {
                btnGen.style.display = 'block';
            }
        });
    }

    $('#bb-vn-btn-generate').on('click', async function() {
        const container = $('#bb-vn-options-container');
        if (container.children('.bb-vn-option[data-intent]').length > 0) {
            container.addClass('active');
            $(this).hide();
        } else {
            await window['bbVnGenerateOptionsFlow']();
        }
    });
}

function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function wipeGlobalLog() {
    chat_metadata['bb_vn_global_log'] = [];
    saveChatDebounced();
    renderSocialHud();
    // @ts-ignore
    notifySuccess("Журнал событий очищен!");
}

function wipeAllSocialData() {
    const chat = SillyTavern.getContext().chat;
    if (!chat) return;
    chat.forEach(msg => {
        if (msg.extra && msg.extra.bb_social_swipes) delete msg.extra.bb_social_swipes;
        if (msg.extra && msg.extra.bb_vn_options_swipes) delete msg.extra.bb_vn_options_swipes;
        if (msg.extra && msg.extra.bb_vn_char_traits_swipes) delete msg.extra.bb_vn_char_traits_swipes; // Удаляем черты из истории
    });
    chat_metadata['bb_vn_global_log'] = [];
    chat_metadata['bb_vn_char_bases'] = {};
    chat_metadata['bb_vn_ignored_chars'] = [];
    delete chat_metadata['bb_vn_char_traits']; // Зачищаем легаси-мету, если осталась
    delete chat_metadata['bb_vn_choice_context'];
    delete chat_metadata['bb_vn_pending_choice_context'];
    addGlobalLog('system', 'Все отношения сброшены до нуля.');
    saveChatDebounced();
    recalculateAllStats();
    notifySuccess("История отношений в этом чате полностью сброшена!");
}

function setupExtensionSettings() {
    if (document.getElementById('bb-social-settings-wrapper')) return;
    
    const s = extension_settings[MODULE_NAME];
    
    const settingsHtml = `
        <div id="bb-social-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💖 BB Visual Novel Engine</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">Настройки Интерактивного Кино:</span>
                
                <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-autosend" ${s.autoSend ? 'checked' : ''}>
                        <span>Авто-отправка при выборе (откл для предпросмотра)</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-autogen" ${s.autoGen ? 'checked' : ''}>
                        <span>Авто-показ 3 вариантов действий при ответе ИИ</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-emotional-choice" ${s.emotionalChoiceFraming ? 'checked' : ''}>
                        <span>Emotional Choice Framing: тон, прогноз и цели выбора</span>
                    </label>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                
                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">⚡ Custom API (Для быстрой генерации ответов):</span>
                <label class="checkbox_label" style="margin-top: 5px;">
                    <input type="checkbox" id="bb-vn-cfg-usecustom" ${s.useCustomApi ? 'checked' : ''}>
                    <span>Использовать свой API-ключ</span>
                </label>
                
                <div id="bb-vn-custom-api-block" style="display: ${s.useCustomApi ? 'flex' : 'none'}; flex-direction: column; gap: 8px; margin-top: 8px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px;">
                    <input type="text" id="bb-vn-cfg-url" class="text_pole" placeholder="URL: http://example:1234/v1" value="${s.customApiUrl || ''}">
                    <input type="password" id="bb-vn-cfg-key" class="text_pole" placeholder="API Ключ" value="${s.customApiKey || ''}">
                    <button id="bb-vn-btn-connect" class="menu_button"><i class="fa-solid fa-plug"></i>&nbsp; Подключиться / Обновить</button>
                    <select id="bb-vn-cfg-model" class="text_pole" ${!s.customApiModel ? 'disabled' : ''}>
                        <option value="${s.customApiModel || ''}">${s.customApiModel || 'Модели не загружены'}</option>
                    </select>
                    <span style="font-size: 10px; color: #94a3b8; line-height: 1.2;">* Работает по стандарту OpenAI. Идеально для Flash-моделей.</span>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">

                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">⚙️ Для пресетов:</span>
                <label class="checkbox_label" style="margin-top: 5px;">
                    <input type="checkbox" id="bb-vn-cfg-usemacro" ${s.useMacro ? 'checked' : ''}>
                    <span>Использовать макрос <code>{{bb_vn}}</code> вместо авто-вставки</span>
                </label>
                <span style="font-size: 10px; color: #94a3b8; line-height: 1.2; margin-bottom: 5px; display:block;">* Отключит автоматическое внедрение инструкций системы отношений в промпт. Вам нужно будет вручную вписать <code>{{bb_vn}}</code> в ваш пресет.</span>
                
                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header" onclick="$(this).parent().toggleClass('open'); $(this).find('.fa-chevron-down').toggleClass('up down');">
                        <b>🛠️ Консоль Разработчика</b>
                        <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content" style="padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; margin-top: 8px; display: none; flex-direction: column; gap: 8px;">
                        <input type="text" id="bb-debug-char-name" class="text_pole" placeholder="Имя персонажа (вводите точно)">
                        <input type="text" id="bb-debug-reason" class="text_pole" placeholder="Текст (Причина / Черта / Статус)" value="Сгенерировано через дебаг-консоль">
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                            <button id="bb-dbg-add-pts" class="menu_button">➕ Дружба (+8)</button>
                            <button id="bb-dbg-sub-pts" class="menu_button">➖ Дружба (-8)</button>
                            <button id="bb-dbg-add-romance" class="menu_button" style="color:#f472b6; border-color:rgba(244,114,182,0.3);">💖 Романтика (+8)</button>
                            <button id="bb-dbg-sub-romance" class="menu_button" style="color:#e11d48; border-color:rgba(225,29,72,0.3);">💔 Романтика (-8)</button>
                            <button id="bb-dbg-add-deep-pos" class="menu_button" style="color:#86efac; border-color:rgba(74,222,128,0.3);">🟢 Глубокий светлый</button>
                            <button id="bb-dbg-add-deep-neg" class="menu_button" style="color:#fca5a5; border-color:rgba(251,113,133,0.3);">🔴 Глубокий мрачный</button>
                            <button id="bb-dbg-add-trait-pos" class="menu_button" style="color:#86efac; border-color:rgba(74,222,128,0.3);">💎 Светлая черта</button>
                            <button id="bb-dbg-add-trait-neg" class="menu_button" style="color:#fca5a5; border-color:rgba(251,113,133,0.3);">💎 Мрачная черта</button>
                        </div>
                        <button id="bb-dbg-set-status" class="menu_button" style="color:#93c5fd; border-color:rgba(147,197,253,0.3);">🔄 Изменить статус к вам</button>
                        
                        <hr style="border-color: rgba(255,255,255,0.05); margin: 4px 0;">
                        <span style="font-size: 11px; color: #cbd5e1; font-weight:bold;">🧬 Слияние дубликатов:</span>
                        <div style="display: flex; gap: 6px;">
                            <input type="text" id="bb-dbg-merge-from" class="text_pole" placeholder="Кого (с опечаткой)" style="flex:1;">
                            <input type="text" id="bb-dbg-merge-to" class="text_pole" placeholder="В кого (правильное)" style="flex:1;">
                        </div>
                        <button id="bb-dbg-btn-merge" class="menu_button" style="color:#c084fc; border-color:rgba(192, 132, 252, 0.3);"><i class="fa-solid fa-code-merge"></i> Слить в одного</button>
                        <hr style="border-color: rgba(255,255,255,0.05); margin: 4px 0;">

                        <button id="bb-dbg-reset-char" class="menu_button" style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;">💀 Полностью обнулить персонажа</button>
                        <button id="bb-dbg-toast" class="menu_button"><i class="fa-solid fa-bell"></i>&ensp; Рандомное уведомление</button>
                    </div>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">

                <button id="bb-social-restore-chars-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;"><i class="fa-solid fa-users-viewfinder"></i>&nbsp; Вернуть скрытых персонажей</button>
                <button id="bb-social-clear-log-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;"><i class="fa-solid fa-eraser"></i>&nbsp; Очистить Журнал событий</button>
                <button id="bb-social-wipe-btn" class="menu_button" style="width: 100%; background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;"><i class="fa-solid fa-trash-can"></i>&nbsp; Сбросить историю чата</button>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);

    // --- СТАНДАРТНЫЕ НАСТРОЙКИ ---
    $('#bb-vn-cfg-autosend').on('change', function() {
        extension_settings[MODULE_NAME].autoSend = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#bb-vn-cfg-autogen').on('change', function() {
        extension_settings[MODULE_NAME].autoGen = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#bb-vn-cfg-emotional-choice').on('change', function() {
        extension_settings[MODULE_NAME].emotionalChoiceFraming = $(this).is(':checked');
        saveSettingsDebounced();
        window['restoreVNOptions'](true);
    });

    $('#bb-vn-cfg-usecustom').on('change', function() {
        const isChecked = $(this).is(':checked');
        extension_settings[MODULE_NAME].useCustomApi = isChecked;
        if (isChecked) {
            $('#bb-vn-custom-api-block').slideDown(200);
        } else {
            $('#bb-vn-custom-api-block').slideUp(200);
        }
        saveSettingsDebounced();
    });

    $('#bb-vn-cfg-url, #bb-vn-cfg-key').on('change input', function() {
        extension_settings[MODULE_NAME].customApiUrl = String($('#bb-vn-cfg-url').val() || "");
        extension_settings[MODULE_NAME].customApiKey = String($('#bb-vn-cfg-key').val() || "");
        saveSettingsDebounced();
    });
    
    $(document).on('change', '#bb-vn-cfg-model', function() {
         extension_settings[MODULE_NAME].customApiModel = String($(this).val() || "");
         saveSettingsDebounced();
    });

    $('#bb-vn-cfg-usemacro').on('change', function() {
        extension_settings[MODULE_NAME].useMacro = $(this).is(':checked');
        saveSettingsDebounced();
        injectCombinedSocialPrompt();
    });

    $('#bb-vn-btn-connect').on('click', async function() {
        const btn = $(this);
        // @ts-ignore
        const url = String($('#bb-vn-cfg-url').val() || '').replace(/\/$/, '');
        const key = String($('#bb-vn-cfg-key').val() || '');

        btn.html('<i class="fa-solid fa-spinner fa-spin"></i> Подключение...');

        try {
            const modelsUrl = url + '/models';
            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Ошибка ${response.status}: ${errText}`);
            }
            const data = await response.json();
            
            if (data && data.data && Array.isArray(data.data)) {
                const select = $('#bb-vn-cfg-model');
                select.empty();
                data.data.forEach(m => {
                    select.append(`<option value="${m.id}">${m.id}</option>`);
                });
                select.prop('disabled', false);
                
                if (extension_settings[MODULE_NAME].customApiModel && select.find(`option[value="${extension_settings[MODULE_NAME].customApiModel}"]`).length) {
                    select.val(extension_settings[MODULE_NAME].customApiModel);
                } else {
                    extension_settings[MODULE_NAME].customApiModel = String(select.val() || '');
                }
                
                // @ts-ignore
                notifySuccess("Модели успешно загружены!", "BB Visual Novel");
                saveSettingsDebounced();
            } else {
                throw new Error("API не вернул список моделей.");
            }
        } catch (e) {
            console.error("[BB VN] Ошибка подключения к API:", e);
            // @ts-ignore
            notifyError(`Не удалось подключиться: ${e.message}`, "BB Visual Novel");
        } finally {
            btn.html('<i class="fa-solid fa-plug"></i> Подключиться / Обновить');
        }
    });

    // --- ДЕБАГ КОНСОЛЬ (ИНЖЕКШЕНЫ) ---
    function injectDebugData(impactLevel, isRomance = false) {
        const charName = String($('#bb-debug-char-name').val() || "").trim();
        const reason = String($('#bb-debug-reason').val() || "Дебаг-действие").trim();
        if(!charName) return notifyError("Укажите имя персонажа!");

        const chat = SillyTavern.getContext().chat;
        if (!chat || chat.length === 0) return notifyError("Чат пуст! Напишите хотя бы одно сообщение.");
        
        const lastMsg = chat[chat.length - 1];
        const swipeId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {};
        if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
        if (!lastMsg.extra.bb_social_swipes[swipeId]) lastMsg.extra.bb_social_swipes[swipeId] = [];

        lastMsg.extra.bb_social_swipes[swipeId].push({
            name: charName,
            friendship_impact: isRomance ? "none" : impactLevel,
            romance_impact: isRomance ? impactLevel : "none",
            role_dynamic: "Дебаг статус",
            reason: reason,
            emotion: "тест"
        });
        saveChatDebounced();
        recalculateAllStats(false); 
        notifySuccess("Данные внедрены.");
    }

    $('#bb-dbg-add-pts').on('click', () => injectDebugData('major_positive', false));
    $('#bb-dbg-sub-pts').on('click', () => injectDebugData('major_negative', false));
    $('#bb-dbg-add-romance').on('click', () => injectDebugData('major_positive', true));
    $('#bb-dbg-sub-romance').on('click', () => injectDebugData('major_negative', true));
    $('#bb-dbg-add-deep-pos').on('click', () => injectDebugData('life_changing', false));
    $('#bb-dbg-add-deep-neg').on('click', () => injectDebugData('unforgivable', false));

    // НОВАЯ КНОПКА: ИЗМЕНИТЬ СТАТУС
    $('#bb-dbg-set-status').on('click', function() {
        const charName = String($('#bb-debug-char-name').val() || "").trim();
        const newStatus = String($('#bb-debug-reason').val() || "").trim();
        if(!charName) return notifyError("Укажите имя персонажа!");
        if(!newStatus) return notifyError("Впишите новый статус в поле 'Текст'!");

        const chat = SillyTavern.getContext().chat;
        if (!chat || chat.length === 0) return notifyError("Чат пуст! Напишите хотя бы одно сообщение.");
        
        const lastMsg = chat[chat.length - 1];
        const swipeId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {};
        if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
        if (!lastMsg.extra.bb_social_swipes[swipeId]) lastMsg.extra.bb_social_swipes[swipeId] = [];

        lastMsg.extra.bb_social_swipes[swipeId].push({
            name: charName,
            impact_level: "none", // 0 очков, просто меняем статус
            role_dynamic: newStatus,
            reason: "Изменение статуса через консоль",
            emotion: "дебаг"
        });
        saveChatDebounced();
        recalculateAllStats(false); 
        notifySuccess(`Статус изменен на: ${newStatus}`);
    });

    $('#bb-dbg-btn-merge').on('click', function() {
        const fromName = String($('#bb-dbg-merge-from').val() || "").trim();
        const toName = String($('#bb-dbg-merge-to').val() || "").trim();
        if(!fromName || !toName) return notifyError("Укажите оба имени!");
        if(fromName === toName) return notifyError("Имена одинаковые!");

        const chat = SillyTavern.getContext().chat;
        let mergedCount = 0;

        if (chat) {
            chat.forEach(msg => {
                // Переносим очки отношений и историю
                if (msg.extra && msg.extra.bb_social_swipes) {
                    for (const sId in msg.extra.bb_social_swipes) {
                        if (Array.isArray(msg.extra.bb_social_swipes[sId])) {
                            msg.extra.bb_social_swipes[sId].forEach(u => {
                                if (u.name === fromName) {
                                    u.name = toName;
                                    mergedCount++;
                                }
                            });
                        }
                    }
                }
                // Переносим черты характера
                if (msg.extra && msg.extra.bb_vn_char_traits_swipes) {
                    for (const sId in msg.extra.bb_vn_char_traits_swipes) {
                        if (Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) {
                            msg.extra.bb_vn_char_traits_swipes[sId].forEach(t => {
                                if (t.charName === fromName) {
                                    t.charName = toName;
                                }
                            });
                        }
                    }
                }
            });
        }
        
        // Удаляем базовое отношение клона, если оно было
        if (chat_metadata['bb_vn_char_bases'] && chat_metadata['bb_vn_char_bases'][fromName] !== undefined) {
            delete chat_metadata['bb_vn_char_bases'][fromName];
        }

        if (mergedCount > 0) {
            saveChatDebounced();
            recalculateAllStats(false);
            notifySuccess(`Слияние успешно! Перенесено записей: ${mergedCount}`);
            $('#bb-dbg-merge-from').val('');
            $('#bb-dbg-merge-to').val('');
        } else {
            notifyError(`Персонаж "${fromName}" не найден в истории.`);
        }
    });

    $('#bb-dbg-reset-char').on('click', function() {
        const charName = String($('#bb-debug-char-name').val() || "").trim();
        if(!charName) return notifyError("Укажите точное имя для обнуления!");
        
        if (chat_metadata['bb_vn_char_bases']) delete chat_metadata['bb_vn_char_bases'][charName];
        delete chat_metadata['bb_vn_char_traits']; // Сносим легаси
        
        const chat = SillyTavern.getContext().chat;
        if (chat) {
            chat.forEach(msg => {
                if (msg.extra && msg.extra.bb_social_swipes) {
                    for (const sId in msg.extra.bb_social_swipes) {
                        if (Array.isArray(msg.extra.bb_social_swipes[sId])) {
                            msg.extra.bb_social_swipes[sId] = msg.extra.bb_social_swipes[sId].filter(u => u.name !== charName);
                        }
                    }
                }
                // Вырезаем черты из истории сообщений!
                if (msg.extra && msg.extra.bb_vn_char_traits_swipes) {
                    for (const sId in msg.extra.bb_vn_char_traits_swipes) {
                        if (Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) {
                            msg.extra.bb_vn_char_traits_swipes[sId] = msg.extra.bb_vn_char_traits_swipes[sId].filter(t => t.charName !== charName);
                        }
                    }
                }
            });
        }
        saveChatDebounced();
        recalculateAllStats(false);
        notifySuccess(`Вся история персонажа ${charName} стерта.`);
    });

    $('#bb-dbg-toast').on('click', function() {
        const types = ['system', 'positive', 'negative', 'milestone', 'alert'];
        const randomType = types[Math.floor(Math.random() * types.length)];
        showHudToast({
            title: 'Тестовое уведомление',
            text: 'Это сгенерировано через консоль.',
            badge: 'Дебаг',
            variant: randomType,
            icon: 'fa-solid fa-bug'
        });
    });

    // --- УТИЛИТЫ ---
    $('#bb-social-restore-chars-btn').on('click', function() {
        chat_metadata['bb_vn_ignored_chars'] = [];
        saveChatDebounced();
        recalculateAllStats();
        // @ts-ignore
        notifySuccess("Скрытые персонажи восстановлены!");
    });

    const clearLogBtn = document.getElementById('bb-social-clear-log-btn');
    if (clearLogBtn) clearLogBtn.addEventListener('click', wipeGlobalLog);

    const wipeBtn = document.getElementById('bb-social-wipe-btn');
    if (wipeBtn) wipeBtn.addEventListener('click', wipeAllSocialData);
}

// Запуск и привязка событий
jQuery(async () => {
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        
        setupExtensionSettings();

        const context = SillyTavern.getContext();
        if (context.registerMacro) {
            context.registerMacro('bb_vn', () => {
                return extension_settings[MODULE_NAME].useMacro ? getCombinedSocial() : '';
            });
        }

        injectCombinedSocialPrompt();
        ensureHudContainer();
        injectVNActionsUI();
        updateHudVisibility();

        eventSource.on(event_types.APP_READY, () => {
            setupExtensionSettings();
            injectCombinedSocialPrompt();
            ensureHudContainer();
            injectVNActionsUI();
            recalculateAllStats(); 
            updateHudVisibility();
        });
        
        eventSource.on(event_types.CHAT_CHANGED, () => {
            window['restoreVNOptions'](false);
            injectCombinedSocialPrompt();
            injectVNActionsUI();
            recalculateAllStats(); 
            updateHudVisibility();
        });

        // ПРИ СВАЙПЕ ИЛИ НОВОМ СООБЩЕНИИ ПЫТАЕМСЯ ВОССТАНОВИТЬ КЭШ КНОПОК
        eventSource.on(event_types.MESSAGE_RECEIVED, () => { window['restoreVNOptions'](false); recalculateAllStats(true); }); 
        eventSource.on(event_types.MESSAGE_DELETED, () => { window['restoreVNOptions'](false); recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_SWIPED, () => { window['restoreVNOptions'](false); recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_UPDATED, () => { recalculateAllStats(); });
        eventSource.on(event_types.GENERATION_STOPPED, () => { recalculateAllStats(); });

        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (extension_settings[MODULE_NAME].autoGen) {
                setTimeout(() => {
                    const btn = $('#bb-vn-btn-generate');
                    if (btn.is(':visible') && !btn.hasClass('loading')) btn.click();
                }, 1500);
            }
        });

        eventSource.on(event_types.GENERATE_AFTER_DATA, (generate_data) => {
            if (extension_settings[MODULE_NAME].useMacro && generate_data && Array.isArray(generate_data.messages)) {
                const promptText = getCombinedSocial();
                generate_data.messages.forEach(msg => {
                    if (msg && msg.content && typeof msg.content === 'string' && msg.content.includes('{{bb_vn}}')) {
                        msg.content = msg.content.replace(/\{\{bb_vn\}\}/g, promptText);
                    }
                });
            }
        });

    } catch (e) { console.error("[BB VN] Ошибка запуска:", e); }
});
