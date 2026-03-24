/* global jQuery, SillyTavern, toastr */

import { setExtensionPrompt, chat_metadata, saveChatDebounced, saveSettingsDebounced, extension_prompt_roles, extension_prompt_types, generateQuietPrompt } from '../../../../script.js';
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
let hudVisibilityIntervalId = null;

/**
 * @typedef {Object} VNOption
 * @property {string=} intent
 * @property {string=} tone
 * @property {string=} forecast
 * @property {string=} risk
 * @property {string=} message
 * @property {string[]=} targets
 * @property {string=} target
 */

// ==========================================
// ФАЗА 1: СОЦИАЛЬНЫЙ ТРЕКИНГ (DEEP SYNC + УМНЫЕ СТАТЫ)
// ==========================================
const SOCIAL_PROMPT = `[SYSTEM INSTRUCTION: VISUAL NOVEL ENGINE]
You are tracking how the characters feel about {{user}}. 
At the VERY END of your response, you MUST generate a hidden JSON block evaluating how {{user}}'s last action affected each character's attitude, trust, and affection towards {{user}}.

CRITICAL RULES FOR JSON:
1. "base_affinity": INITIAL STARTING SCORE (-100 to 100). You MUST use this mechanical check:
Look at the [CURRENT RELATIONSHIP STATUS] block below.
- Is the block EMPTY or missing? -> YOU MUST OUTPUT "base_affinity".
- Is the character's name missing from that block? -> YOU MUST OUTPUT "base_affinity".
- Is the character already listed in that block? -> DO NOT output "base_affinity".
NO EXCEPTIONS. Even if it's the very first message or a known lore character, if they aren't physically printed in the list below, you MUST provide this score.
2. "status": A 1-3 word label defining WHO {{user}} IS to the character. CRITICAL RULE: DO NOT describe the character's own role.
Use a short role label that answers: "Who is {{user}} to this character?"
Think in placeholder terms like: "WHO_USER_IS_TO_THE_CHARACTER".
3. "delta": Integer representing the shift in the character's feelings towards {{user}}. Use this STRICT scale:
   0 = Neutral interaction (no change in opinion).
   1 to 3 = Mild positive (character appreciates politeness, small help).
   4 to 8 = Strong positive (deep bonding, major gift).
   9 to 30 = Extreme positive (heroic sacrifice, saving a life, profound revelation).
   -1 to -3 = Mild negative (character is annoyed, slight disagreement).
   -4 to -8 = Strong negative (serious fight, deep offense).
   -9 to -30 = Extreme negative (murder, ultimate betrayal, unforgivable atrocities).
4. "reason": Short explanation of WHY the character's opinion changed (the delta).

CRITICAL LANGUAGE RULE: Output the JSON values ENTIRELY IN RUSSIAN.

Use this SHORT JSON SHAPE as a template (placeholders are instructions, not literal text; include "base_affinity" ONLY for new characters):
\`\`\`json
{
  "social_updates": [
    {
      "name": "CHARACTER_NAME",
      "base_affinity": STARTING_SCORE_IF_NEW,
      "delta": POSITIVE_OR_NEGATIVE_INTEGER,
      "status": "WHO_USER_IS_TO_THE_CHARACTER",
      "reason": "SHORT_REASON_FOR_THE_CHANGE"
    }
  ]
}
\`\`\``;

function getCombinedSocial() {
    let combinedStr = SOCIAL_PROMPT;
    const characters = Object.keys(currentCalculatedStats);
    const unforgettableLines = [];
    const unforgettableImpactLines = [];
    if (characters.length > 0) {
        combinedStr += `\n\n[CURRENT RELATIONSHIP STATUS WITH {{user}}]:\n`;
        characters.forEach(char => {
            const tierLabel = getTierInfo(currentCalculatedStats[char].affinity).label;
            const softMemories = currentCalculatedStats[char].memories?.soft || [];
            const deepMemories = currentCalculatedStats[char].memories?.deep || [];
            const derivedRoleStatus = getUnforgettableRoleStatus(deepMemories);
            const statusLabel = currentCalculatedStats[char].status || derivedRoleStatus || tierLabel;
            const relationshipState = getAffinityNarrative(currentCalculatedStats[char].affinity);
            const unforgettableImpact = getUnforgettableImpact(deepMemories);
            const softLine = softMemories.length > 0
                ? ` | recent_memory: ${softMemories.map(m => m.text).join('; ')}`
                : '';
            const deepLine = deepMemories.length > 0
                ? ` | unforgettable: ${deepMemories.map(m => m.text).join('; ')}`
                : '';

            if (deepMemories.length > 0) {
                unforgettableLines.push(`- ${char}: ${deepMemories.map(m => m.text).join('; ')}`);
                if (unforgettableImpact.prompt) {
                    unforgettableImpactLines.push(`- ${char}: impact=${unforgettableImpact.label} | role_pressure=${derivedRoleStatus || 'нет'} | direction=${unforgettableImpact.prompt}`);
                }
            }

            combinedStr += `- ${char}: role_status=${statusLabel} | relationship_tier=${tierLabel} | relationship_state=${relationshipState}${softLine}${deepLine}${deepMemories.length > 0 ? ` | unforgettable_impact=${unforgettableImpact.label}` : ''}\n`;
        });
        combinedStr += "CRITICAL: Strictly align the characters' behavior, trust level, and dialogue towards {{user}} with these current relationship tiers, statuses, and emotional states.";
    }
    if (unforgettableLines.length > 0) {
        combinedStr += `\n\n[UNFORGETTABLE EVENTS]:\n${unforgettableLines.join('\n')}\nCRITICAL: These are persistent emotional anchors. Characters must continue to remember them across scenes, even when the recent interaction is calm.`;
    }
    if (unforgettableImpactLines.length > 0) {
        combinedStr += `\n\n[UNFORGETTABLE EVENTS IMPACT]:\n${unforgettableImpactLines.join('\n')}\nCRITICAL: Unforgettable events must outweigh small recent mood shifts when the scene is ambiguous.`;
    }
    combinedStr += buildChoiceContextPrompt();
    return combinedStr;
}

function injectCombinedSocialPrompt() {
    try {
        if (extension_settings[MODULE_NAME].useMacro) {
            setExtensionPrompt('bb_social_injector', '', extension_prompt_types.IN_CHAT, 3, false, extension_prompt_roles.SYSTEM);
        } else {
            const promptText = getCombinedSocial();
            setExtensionPrompt('bb_social_injector', promptText, extension_prompt_types.IN_CHAT, 3, false, extension_prompt_roles.SYSTEM);
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

const TOAST_LIFETIME_MS = 5200;
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

function showRelationshipToast(name, delta, reason) {
    if (delta === 0) return;
    const shift = getShiftDescriptor(delta);
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

    return {
        ...option,
        tone,
        forecast,
        targets,
        risk: legacyRisk,
    };
}

function normalizeStatusLabel(value = "") {
    return String(value || '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
    if (absDelta >= 9) return 'deep';
    if (absDelta >= 2) return 'soft';
    return '';
}

function getMemoryTone(delta) {
    if (delta > 0) return 'positive';
    if (delta < 0) return 'negative';
    return 'neutral';
}

function getShiftDescriptor(delta) {
    const absDelta = Math.abs(delta);
    if (delta > 0) {
        if (absDelta >= 9) return { short: 'Сильная связь', full: 'Сильное сближение', color: '#c084fc', logType: 'plus' };
        if (absDelta >= 4) return { short: 'Сближение', full: 'Сильное сближение', color: '#4ade80', logType: 'plus' };
        if (absDelta >= 2) return { short: 'Симпатия', full: 'Положительное изменение', color: '#86efac', logType: 'plus' };
        return { short: 'Лёгкий плюс', full: 'Лёгкое улучшение', color: '#bbf7d0', logType: 'plus' };
    }
    if (delta < 0) {
        if (absDelta >= 9) return { short: 'Разрыв', full: 'Глубокая трещина', color: '#fca5a5', logType: 'minus' };
        if (absDelta >= 4) return { short: 'Конфликт', full: 'Сильное ухудшение', color: '#f87171', logType: 'minus' };
        if (absDelta >= 2) return { short: 'Напряжение', full: 'Нарастающее напряжение', color: '#fda4af', logType: 'minus' };
        return { short: 'Лёгкий минус', full: 'Лёгкое ухудшение', color: '#fecdd3', logType: 'minus' };
    }
    return { short: 'Без изменений', full: 'Без ощутимых изменений', color: '#94a3b8', logType: 'system' };
}

function getAffinityNarrative(affinity) {
    if (affinity <= -50) return 'Глубокий разлом';
    if (affinity < -10) return 'Холод и настороженность';
    if (affinity <= 10) return 'Хрупкий нейтралитет';
    if (affinity <= 50) return 'Осторожное сближение';
    if (affinity <= 80) return 'Стабильное доверие';
    return 'Очень близкая связь';
}

function getUnforgettableImpact(memories = []) {
    if (!Array.isArray(memories) || memories.length === 0) {
        return { label: 'Нет активного следа', prompt: '' };
    }

    const total = memories.reduce((sum, memory) => sum + (parseInt(memory.delta) || 0), 0);
    const hasPositive = memories.some(memory => (parseInt(memory.delta) || 0) > 0);
    const hasNegative = memories.some(memory => (parseInt(memory.delta) || 0) < 0);

    if (hasPositive && hasNegative) {
        return {
            label: 'Противоречивый след',
            prompt: 'Past unforgettable events create inner conflict: the character is torn between closeness and pain, so reactions should feel emotionally unstable and layered.',
        };
    }
    if (total >= 18) {
        return {
            label: 'Тянется сквозь всё',
            prompt: 'Unforgettable positive events create a powerful pull toward {{user}}. Even in tense scenes, warmth, trust, or longing should leak through.',
        };
    }
    if (total > 0) {
        return {
            label: 'Глубокое доверие',
            prompt: 'Unforgettable positive events still shape the character. Small gestures from {{user}} should be interpreted more softly and personally.',
        };
    }
    if (total <= -18) {
        return {
            label: 'Шрам не зажил',
            prompt: 'Unforgettable negative events still dominate the character’s perception. Suspicion, pain, or guardedness should override calm surface behavior.',
        };
    }
    return {
        label: 'Подспудная настороженность',
        prompt: 'Unforgettable negative events remain unresolved. Even neutral interactions should carry some hesitation, distance, or emotional recoil.',
    };
}

function getUnforgettableRoleStatus(memories = []) {
    if (!Array.isArray(memories) || memories.length === 0) return '';

    const total = memories.reduce((sum, memory) => sum + (parseInt(memory.delta) || 0), 0);
    const hasPositive = memories.some(memory => (parseInt(memory.delta) || 0) > 0);
    const hasNegative = memories.some(memory => (parseInt(memory.delta) || 0) < 0);
    const memoryText = memories.map(memory => String(memory.text || '').toLowerCase()).join(' | ');

    const keywordStatusMap = [
        { pattern: /(спас|защит|выручил|прикрыл|уберег)/i, label: 'Спасший меня' },
        { pattern: /(тайн|секрет|доверил|доверяю|открылся)/i, label: 'Хранитель тайны' },
        { pattern: /(поцел|объят|нежн|люб|сердц|забот)/i, label: 'Тронувший сердце' },
        { pattern: /(опираюсь|поддержал|рядом|не бросил|помог)/i, label: 'Тот, на кого опираюсь' },
        { pattern: /(предал|обман|солгал|измен|подстав)/i, label: 'Предавший доверие' },
        { pattern: /(униз|оскорб|отверг|презр|стыд)/i, label: 'Задевший гордость' },
        { pattern: /(рана|шрам|сломал|разрушил|ударил)/i, label: 'Оставивший шрам' },
        { pattern: /(ревност|одержим|опасн|искуш)/i, label: 'Опасно близкий' },
    ];

    for (const candidate of keywordStatusMap) {
        if (candidate.pattern.test(memoryText)) return candidate.label;
    }

    if (hasPositive && hasNegative) return 'Болезненно важный';
    if (total >= 18) return 'Тот, кто изменил меня';
    if (total > 0) return 'Тот, кому тянусь';
    if (total <= -18) return 'Тот, кто оставил шрам';
    return 'Тот, кому не верю';
}

function appendCharacterMemory(charStats, delta, reason) {
    if (!charStats || !reason || delta === 0) return;
    const bucket = getMemoryBucket(delta);
    if (!bucket) return;
    const memory = {
        text: reason,
        delta,
        tone: getMemoryTone(delta),
    };

    charStats.memories[bucket].push(memory);
    const limit = bucket === 'deep' ? 3 : 4;
    if (charStats.memories[bucket].length > limit) {
        charStats.memories[bucket].shift();
    }
}

function buildChoiceContextPrompt() {
    const choiceContext = chat_metadata['bb_vn_choice_context'];
    if (!choiceContext || !choiceContext.intent) return '';

    const targets = Array.isArray(choiceContext.targets) && choiceContext.targets.length > 0
        ? choiceContext.targets.join(', ')
        : 'не указаны';

    return `\n\n[LAST PLAYER CHOICE VECTOR]:\n- intent: ${choiceContext.intent}\n- tone: ${choiceContext.tone || 'не указан'}\n- forecast: ${choiceContext.forecast || 'не указан'}\n- targets: ${targets}\nCRITICAL: Reflect the emotional direction of this choice in the next response. If the listed targets are present in the scene, they must react to it more strongly than bystanders.`;
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

function addGlobalLog(type, text) {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) return;
    if (!chat_metadata['bb_vn_global_log']) chat_metadata['bb_vn_global_log'] = [];
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    chat_metadata['bb_vn_global_log'].push({ time, type, text });
    if (chat_metadata['bb_vn_global_log'].length > 50) chat_metadata['bb_vn_global_log'].shift();
}

function scanAndCleanMessage(msg, messageId) {
    if (!msg || msg.is_user) return false;
    let modified = false;
    const jsonRegex = /```json\s*({[\s\S]*?"social_updates"[\s\S]*?})\s*```/;
    const match = msg.mes.match(jsonRegex);
    const swipeId = msg.swipe_id || 0;

    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.bb_social_swipes) msg.extra.bb_social_swipes = {};

            msg.extra.bb_social_swipes[swipeId] = parsed.social_updates;
            msg.mes = msg.mes.replace(match[0], '').trim();
            if (msg.swipes && msg.swipes[swipeId] !== undefined) {
                msg.swipes[swipeId] = msg.mes; 
            }
            modified = true;
            
            if (messageId !== undefined) {
                const msgElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
                if (msgElement) msgElement.innerHTML = SillyTavern.getContext().markdownToHtml(msg.mes);
            }
        } catch(e) {}
    }
    return modified;
}

function recalculateAllStats(isNewMessage = false) {
    currentCalculatedStats = {};
    currentStoryMoments = [];
    const chat = SillyTavern.getContext().chat;
    let latestChoiceContext = null;
    
    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
    if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];

    if (!chat || !chat.length) {
        renderSocialHud();
        injectCombinedSocialPrompt();
        return;
    }

    let needsSave = false;

    chat.forEach((msg, idx) => {
        if (tryBindPendingChoiceContextToMessage(msg)) needsSave = true;

        if (msg?.is_user && msg.extra?.bb_vn_choice_context) {
            latestChoiceContext = msg.extra.bb_vn_choice_context;
        }

        if (scanAndCleanMessage(msg, idx)) needsSave = true;

        const swipeId = msg.swipe_id || 0;
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
                if (!charName) return;

                if (chat_metadata['bb_vn_ignored_chars'].includes(charName)) return;

                const delta = parseInt(update.delta) || 0;
                let base = 0;
                
                if (!currentCalculatedStats[charName]) {
                    // ФИКС РЕДАКТОРА (Абсолютный приоритет глобальной базы)
                    if (chat_metadata['bb_vn_char_bases'][charName] !== undefined) {
                        base = parseInt(chat_metadata['bb_vn_char_bases'][charName]);
                    } else {
                        base = update.base_affinity !== undefined ? parseInt(update.base_affinity) : 0;
                        if (isNaN(base)) base = 0;
                        chat_metadata['bb_vn_char_bases'][charName] = base;
                    }
                    
                    currentCalculatedStats[charName] = {
                        affinity: base,
                        history: [],
                        status: normalizeStatusLabel(update.status || ""),
                        memories: { soft: [], deep: [] }
                    };
                    
                    // === ОБНОВЛЕННЫЙ ЛОГ ДЛЯ ИНИЦИАЛИЗАЦИИ ===
                    if (isNewMessage && idx === chat.length - 1 && update.base_affinity !== undefined) {
                        // Меняем пробелы на перенос строки
                        const formattedName = escapeHtml(charName).replace(/ /g, '<br>');
                        const introMoment = maybeAddStoryMoment({
                            type: 'intro',
                            char: charName,
                            title: 'Новый контакт',
                            text: `${charName} появился в трекере отношений.`,
                        });
                        showStoryMomentToast(introMoment);
                        addGlobalLog('init', `
                            <div class="bb-glog-main">
                                <span class="bb-glog-char">${formattedName}</span>
                                <span class="bb-glog-delta">Новый контакт</span>
                            </div>
                            <div class="bb-glog-reason">Первая встреча в трекере</div>
                        `);
                    }

                }

                const previousAffinity = currentCalculatedStats[charName].affinity;
                const previousStatus = currentCalculatedStats[charName].status || "";
                currentCalculatedStats[charName].affinity += delta;
                if (currentCalculatedStats[charName].affinity > 100) currentCalculatedStats[charName].affinity = 100;
                if (currentCalculatedStats[charName].affinity < -100) currentCalculatedStats[charName].affinity = -100;
                
                if (update.status) currentCalculatedStats[charName].status = normalizeStatusLabel(update.status);

                currentCalculatedStats[charName].history.push({ delta, reason: update.reason || "" });
                appendCharacterMemory(currentCalculatedStats[charName], delta, update.reason || "");

                const previousTier = getTierInfo(previousAffinity).label;
                const newTier = getTierInfo(currentCalculatedStats[charName].affinity).label;
                let toastMoment = null;
                if (previousTier !== newTier) {
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({
                        type: 'tier-shift',
                        char: charName,
                        title: 'Сдвиг в отношениях',
                        text: `${charName}: статус изменился с «${previousTier}» на «${newTier}».`,
                    }));
                }

                if (update.status && previousStatus && previousStatus !== update.status) {
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({
                        type: 'status-shift',
                        char: charName,
                        title: 'Новый образ в его глазах',
                        text: `${charName}: теперь вы для него — «${normalizeStatusLabel(update.status)}».`,
                    }));
                }

                if (Math.abs(delta) >= 2 && update.reason) {
                    const shift = getShiftDescriptor(delta);
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({
                        type: delta > 0 ? 'soft-positive' : 'soft-negative',
                        char: charName,
                        title: shift.full,
                        text: `${charName}: ${update.reason}`,
                    }));
                }

                if (Math.abs(delta) >= 9 && update.reason) {
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({
                        type: delta > 0 ? 'deep-positive' : 'deep-negative',
                        char: charName,
                        title: 'Незабываемое событие',
                        text: `${charName}: ${update.reason}`,
                    }));
                }
                
                // === ОБНОВЛЕННЫЙ ЛОГ ДЛЯ ИЗМЕНЕНИЯ ОТНОШЕНИЙ ===
                if (isNewMessage && idx === chat.length - 1 && delta !== 0) {
                    if (toastMoment) {
                        showStoryMomentToast(toastMoment);
                    } else {
                        showRelationshipToast(charName, delta, update.reason || "");
                    }
                    const shift = getShiftDescriptor(delta);
                    // Меняем пробелы на перенос строки
                    const formattedName = escapeHtml(charName).replace(/ /g, '<br>');
                    addGlobalLog(shift.logType, `
                        <div class="bb-glog-main">
                            <span class="bb-glog-char">${formattedName}</span>
                            <span class="bb-glog-delta">${shift.short}</span>
                        </div>
                        <div class="bb-glog-reason">"${escapeHtml(update.reason)}"</div>
                    `);
                }
            });
        }
    });

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
                const spotlightLabel = index === 0 ? 'Главная связь' : index === 1 ? 'Важная связь' : 'Связь';
                const softCount = memories.soft.length;
                const deepCount = memories.deep.length;

                let barStyle = '';
                if (affinity >= 0) {
                    const w = Math.min(100, affinity);
                    barStyle = `left: 50%; width: ${w / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
                } else {
                    const w = Math.min(100, Math.abs(affinity));
                    barStyle = `right: 50%; width: ${w / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
                }

                let historyHtml = '';
                const historyArr = currentCalculatedStats[charName].history || [];
                [...historyArr].reverse().forEach(h => {
                    const shift = getShiftDescriptor(h.delta);
                    if (h.delta !== 0) {
                        historyHtml += `
                            <div class="bb-log-entry">
                                <span class="bb-log-delta" style="color:${shift.color}">${escapeHtml(shift.short)}</span>
                                <span class="bb-log-reason">${escapeHtml(h.reason)}</span>
                            </div>
                        `;
                    }
                });
                if (historyHtml === '') historyHtml = '<i style="color:#64748b;">Нет записей</i>';

                const softMemoriesHtml = memories.soft.length > 0
                    ? [...memories.soft].reverse().map(memory => `<div class="bb-memory-pill ${memory.tone}">${escapeHtml(memory.text)}</div>`).join('')
                    : '<i style="color:#64748b;">Пока нет</i>';
                const deepMemoriesHtml = memories.deep.length > 0
                    ? [...memories.deep].reverse().map(memory => `<div class="bb-memory-pill deep ${memory.tone}">${escapeHtml(memory.text)}</div>`).join('')
                    : '<i style="color:#64748b;">Ничего незабываемого</i>';

                cardsHtml += `
                    <div class="bb-char-card" data-char="${escapeHtml(charName)}">
                        <div class="bb-char-card-shell">
                            <div class="bb-char-card-topline">
                                <span class="bb-char-route-tag" style="color:${tier.color}; border-color:${tier.color};">${escapeHtml(spotlightLabel)}</span>
                                <button type="button" class="bb-char-edit-btn" data-char="${escapeHtml(charName)}" title="Настройки персонажа">
                                    <i class="fa-solid fa-sliders"></i>
                                </button>
                            </div>
                            <div class="bb-char-hero">
                                <div class="bb-char-identity">
                                    <div class="bb-char-name-wrap">
                                        <span class="bb-char-name">${escapeHtml(charName)}</span>
                                        <span class="bb-char-score" style="color:${tier.color};">${affinity > 0 ? '+' : ''}${affinity}</span>
                                    </div>
                                    <div class="bb-char-subtitle">
                                        <span class="bb-char-direction"><i class="fa-solid fa-bookmark"></i> как персонаж вас видит</span>
                                        <div class="bb-char-signals">
                                            <span class="bb-char-tier ${tier.class}" title="${escapeHtml(displayStatus)}">${escapeHtml(displayStatus)}</span>
                                            ${memories.deep.length > 0 ? `<span class="bb-unforgettable-impact">${escapeHtml(unforgettableImpact.label)}</span>` : ''}
                                        </div>
                                    </div>
                                </div>
                                <div class="bb-char-route-meta">
                                    <div class="bb-char-meta-card">
                                        <span class="bb-char-meta-label">Последний сдвиг</span>
                                        <strong>${lastHistory ? escapeHtml(getShiftDescriptor(lastHistory.delta).full) : 'Пока ровно'}</strong>
                                    </div>
                                    <div class="bb-char-meta-card">
                                        <span class="bb-char-meta-label">Основа</span>
                                        <strong>${baseAffinity > 0 ? '+' : ''}${baseAffinity}</strong>
                                    </div>
                                </div>
                            </div>
                            <div class="bb-progress-wrapper">
                                <div class="bb-progress-labels">
                                    <span>Отчуждение</span>
                                    <span>Нейтрально</span>
                                    <span>Сближение</span>
                                </div>
                                <div class="bb-progress-bg">
                                    <div class="bb-progress-center-line"></div>
                                    <div class="bb-progress-fill" style="${barStyle}"></div>
                                </div>
                                <div class="bb-char-stats">
                                    Общее ощущение: <strong style="color:${tier.color}; font-size:13px;">${getAffinityNarrative(affinity)}</strong>
                                </div>
                            </div>
                            <div class="bb-char-insight-grid">
                                <div class="bb-char-insight-tile">
                                    <span class="bb-char-insight-label">Мягкие следы</span>
                                    <strong>${softCount}</strong>
                                </div>
                                <div class="bb-char-insight-tile">
                                    <span class="bb-char-insight-label">Глубокие следы</span>
                                    <strong>${deepCount}</strong>
                                </div>
                                <div class="bb-char-insight-tile bb-char-insight-wide">
                                    <span class="bb-char-insight-label">Текущий вектор</span>
                                    <strong>${escapeHtml(displayStatus)}</strong>
                                </div>
                            </div>
                        </div>

                        <div class="bb-char-editor" style="display:none; cursor: default;">
                            <div class="bb-editor-title">Редактирование связи</div>
                            <div class="bb-editor-hint">Измените базовое отношение или скройте персонажа из трекера.</div>
                            <input type="number" class="text_pole bb-edit-base-input" value="${baseAffinity}" style="width:100%; margin-bottom:8px; box-sizing:border-box;">
                            <div class="bb-editor-actions">
                                <button class="menu_button bb-btn-save-char" data-char="${escapeHtml(charName)}" style="flex:1;"><i class="fa-solid fa-check"></i>&ensp;Сохранить</button>
                                <button class="menu_button bb-btn-hide-char" data-char="${escapeHtml(charName)}" style="flex:1;"><i class="fa-solid fa-eye-slash"></i>&ensp;Скрыть</button>
                            </div>
                        </div>

                        <div class="bb-char-log">
                            <div class="bb-char-log-section">
                                <div class="bb-section-eyebrow">Изменения</div>
                                ${historyHtml}
                            </div>
                            <div class="bb-memory-section">
                                <div class="bb-memory-title">Быстрые эмоции</div>
                                <div class="bb-memory-list">${softMemoriesHtml}</div>
                            </div>
                            <div class="bb-memory-section">
                                <div class="bb-memory-title">Незабываемые события</div>
                                <div class="bb-memory-list">${deepMemoriesHtml}</div>
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
                if ($(e.target).closest('.bb-char-editor, .bb-char-edit-btn, .bb-btn-save-char, .bb-btn-hide-char').length === 0) {
                    $(this).toggleClass('expanded');
                }
            });

            $('.bb-char-edit-btn').off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                $(this).closest('.bb-char-card').toggleClass('expanded').find('.bb-char-editor').slideToggle(200);
            });

            $('.bb-btn-save-char').off('click').on('click', function() {
                const charName = $(this).attr('data-char');
                const rawBase = $(this).closest('.bb-char-editor').find('.bb-edit-base-input').val();
                const newBase = parseInt(String(rawBase), 10);
                if (!isNaN(newBase)) {
                    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
                    chat_metadata['bb_vn_char_bases'][charName] = newBase;
                    saveChatDebounced();
                    recalculateAllStats();
                    notifySuccess("Настройки сохранены!");
                }
            });

            $('.bb-btn-hide-char').off('click').on('click', function() {
                const charName = $(this).attr('data-char');
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
    const characterId = context.characterId;
    const groupId = context.groupId;
    const hasChatMessages = Array.isArray(context.chat) && context.chat.length > 0;
    const hasConversationTarget = Boolean(characterId || groupId);
    const chatViewportVisible = $('#chat').is(':visible');
    const chatInputVisible = $('#send_form:visible, #send_textarea:visible, #chat-input:visible, #chat_input:visible').length > 0;
    const inChatUi = chatViewportVisible && chatInputVisible;
    const hasActiveChat = inChatUi && (Boolean(chatId) || hasChatMessages || hasConversationTarget);

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
                <span class="bb-toggle-label">HUD</span>
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
        syncToastContainerWithHud();
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

CRITICAL JSON AND FORMATTING RULES:
1. Return STRICTLY a valid JSON array. DO NOT output any conversational text outside the JSON.
2. INSIDE the "message" field, you MUST use standard roleplay formatting: asterisks for *actions/thoughts* and quotes for dialogue.
3. You MUST escape all internal double quotes inside the "message" string (e.g., \\"Hello\\") to ensure the JSON remains valid.
4. To create paragraphs, use escaped newlines (\\n\\n) inside the "message" string. DO NOT use actual line breaks in the string, or it will break the JSON.

Use this SHORT JSON SHAPE as a template. The placeholders below are instructions, not literal values. Return exactly 3 objects with this structure:
[
  {
    "intent": "SHORT_ACTION_LABEL",
    "tone": "SHORT_RUSSIAN_TONE",
    "forecast": "SHORT_RUSSIAN_OUTCOME_HINT",
    "targets": ["MOST_AFFECTED_CHARACTER"],
    "risk": "OPTIONAL_RISK_LABEL",
    "message": "LONG_RUSSIAN_ROLEPLAY_REPLY_WITH_ESCAPED_QUOTES_AND_\n\n_PARAGRAPHS"
  }
]

[USER PERSONA REFERENCE]:
{{persona}}

[RECENT CONTEXT (For background)]:
"""{{chat}}"""

[IMMEDIATE TRIGGER (You MUST directly respond to the exact ending of this message)]:
"""{{lastMessage}}"""`;

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
            const baseUrl = s.customApiUrl.replace(/\/$/, '');
            const endpoint = baseUrl + '/chat/completions';
            
            const response = await fetch(endpoint, {
                method: 'POST',
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
            console.warn(`[BB VN] Ошибка кастомного API (${e.message}), перехват на основной API...`);
            return await runMainGen(promptText);
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

        optionsHtml += `
            <div class="bb-vn-option ${riskClass} ${toneClass}" data-intent="${escapeHtml(opt.intent)}" data-message="${encodeURIComponent(opt.message || '')}" data-tone="${escapeHtml(opt.tone || '')}" data-forecast="${escapeHtml(opt.forecast || '')}" data-targets="${encodeURIComponent(JSON.stringify(opt.targets || []))}">
                <div class="bb-vn-op-topline"><span class="bb-vn-op-index">Сцена</span><div class="bb-vn-op-risk">${useEmotionalChoiceFraming ? 'Тон' : 'Риск'}: ${escapeHtml(metaLabel)}</div></div>
                <div class="bb-vn-op-head">${escapeHtml(opt.intent)}</div>
                ${useEmotionalChoiceFraming ? `<div class="bb-vn-targets">${targetsText}</div>` : ''}
                ${forecastHtml}
            </div>
        `;
    });
    
    optionsHtml += `
        <div class="bb-vn-utility-row">
            <div class="bb-vn-option risk-med bb-vn-utility-card" id="bb-vn-btn-reroll">
                <div class="bb-vn-op-topline"><span class="bb-vn-op-index">Сервис</span></div>
                <div class="bb-vn-op-head"><i class="fa-solid fa-rotate-right"></i>&nbsp; Реролл вариантов</div>
            </div>
            <div class="bb-vn-option risk-med bb-vn-utility-card" id="bb-vn-btn-cancel">
                <div class="bb-vn-op-topline"><span class="bb-vn-op-index">Сервис</span></div>
                <div class="bb-vn-op-head"><i class="fa-solid fa-chevron-up"></i>&nbsp; Свернуть</div>
            </div>
        </div>
    `;

    $('#bb-vn-options-container').html(optionsHtml);

    if (autoOpen) {
        $('#bb-vn-options-container').addClass('active');
        $('#bb-vn-btn-generate').removeClass('loading').hide();
    } else {
        $('#bb-vn-options-container').removeClass('active');
        $('#bb-vn-btn-generate').removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия (Сохранены)').show();
    }

    $('.bb-vn-option[data-intent]').off('click').on('click', function() {
        const message = decodeURIComponent($(this).attr('data-message') || '');
        const targetsRaw = decodeURIComponent($(this).attr('data-targets') || '[]');
        let parsedTargets = [];
        try {
            parsedTargets = JSON.parse(targetsRaw);
        } catch (e) {}
        const choiceContext = {
            intent: $(this).attr('data-intent') || '',
            tone: $(this).attr('data-tone') || '',
            forecast: $(this).attr('data-forecast') || '',
            targets: Array.isArray(parsedTargets) ? parsedTargets : [],
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
                $('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)');
                const sendBtn = document.getElementById('send_but');
                if (sendBtn) sendBtn.click();
            }
        }
    });

    $('#bb-vn-btn-cancel').off('click').on('click', function() {
        $('#bb-vn-options-container').removeClass('active');
        $('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия (Сохранены)');
    });

    $('#bb-vn-btn-reroll').off('click').on('click', async function() {
        await window['bbVnGenerateOptionsFlow']();
    });
};

// ГЛОБАЛЬНАЯ ФУНКЦИЯ ДЛЯ ГЕНЕРАЦИИ
window['bbVnGenerateOptionsFlow'] = async function() {
    const btn = $('#bb-vn-btn-generate');
    if (btn.hasClass('loading')) return;

    btn.show().addClass('loading').html('<i class="fa-solid fa-spinner fa-spin"></i> Сценарий в обработке...');
    $('#bb-vn-options-container').removeClass('active').empty();

    try {
       const chat = SillyTavern.getContext().chat;
        if (!chat || chat.length === 0) throw new Error("Чат пуст");
        
        const recentMessages = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');
        const lastMessageText = chat[chat.length - 1] ? chat[chat.length - 1].mes : ""; // Достаем самое свежее сообщение

        // @ts-ignore
        const persona = SillyTavern.getContext().substituteParams('{{persona}}');
        
        let prompt = OPTIONS_PROMPT
            .replace('{{chat}}', recentMessages)
            .replace('{{persona}}', persona)
            .replace('{{lastMessage}}', lastMessageText); // Вшиваем триггер в промпт

// --- ПОДКЛЮЧАЕМ РЕЖИССЁРА (ЕСЛИ ОН ЕСТЬ) ---
        if (typeof window['bbGetSceneDirectorPrompt'] === 'function') {
            const sceneVibe = window['bbGetSceneDirectorPrompt']();
            if (sceneVibe) {
                // ВЫВОДИМ В КОНСОЛЬ БРАУЗЕРА:
                console.log("[BB VNE] 🎬 Успешно подхватили стиль Режиссёра:\n", sceneVibe);
                
                prompt = sceneVibe + "\n\n" + prompt;
            }
        }
        // ------------------------------------------

        const result = await generateFastPrompt(prompt);

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
            const intentMatches = [...cleanResult.matchAll(/"intent"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const toneMatches = [...cleanResult.matchAll(/"tone"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const forecastMatches = [...cleanResult.matchAll(/"forecast"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const riskMatches = [...cleanResult.matchAll(/"risk"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const messageMatches = [...cleanResult.matchAll(/"message"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const targetsMatches = [...cleanResult.matchAll(/"targets"\s*:\s*\[([^\]]*)\]/gi)].map(m =>
                m[1]
                    .split(',')
                    .map(item => item.replace(/["']/g, '').trim())
                    .filter(Boolean)
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
            parsedOptions = parsedOptions.map(normalizeOptionData);
            // СОХРАНЕНИЕ КНОПОК В ПАМЯТЬ СВАЙПА!
            const lastMsg = chat[chat.length - 1];
            const swipeId = lastMsg.swipe_id || 0;
            if (!lastMsg.extra) lastMsg.extra = {};
            if (!lastMsg.extra.bb_vn_options_swipes) lastMsg.extra.bb_vn_options_swipes = {};
            lastMsg.extra.bb_vn_options_swipes[swipeId] = parsedOptions;
            saveChatDebounced();

            window['renderVNOptionsFromData'](parsedOptions, true);
        } else { throw new Error("Ответ пуст"); }

    } catch (e) {
        console.error("[BB VN] Ошибка генерации:", e);
        // @ts-ignore
        notifyError("Не удалось сгенерировать варианты");
        btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)').show();
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
        $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)');
    }
};

function injectVNActionsUI() {
    if (document.getElementById('bb-vn-action-bar')) return;

    const barHtml = `
        <div id="bb-vn-action-bar" style="display: flex;">
            <div id="bb-vn-btn-generate" class="bb-vn-main-btn">
                <i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)
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
        if (msg.extra && msg.extra.bb_social_swipes) {
            delete msg.extra.bb_social_swipes;
        }
        if (msg.extra && msg.extra.bb_vn_options_swipes) {
            delete msg.extra.bb_vn_options_swipes;
        }
    });
    chat_metadata['bb_vn_global_log'] = [];
    chat_metadata['bb_vn_char_bases'] = {};
    chat_metadata['bb_vn_ignored_chars'] = [];
    delete chat_metadata['bb_vn_choice_context'];
    delete chat_metadata['bb_vn_pending_choice_context'];
    addGlobalLog('system', 'Все отношения сброшены до нуля.');
    saveChatDebounced();
    recalculateAllStats();
    // @ts-ignore
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
<button id="bb-social-restore-chars-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;"><i class="fa-solid fa-users-viewfinder"></i>&nbsp; Вернуть скрытых персонажей</button>
<button id="bb-social-clear-log-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;"><i class="fa-solid fa-eraser"></i>&nbsp; Очистить Журнал событий</button>
<button id="bb-social-wipe-btn" class="menu_button" style="width: 100%; background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;"><i class="fa-solid fa-trash-can"></i>&nbsp; Сбросить отношения в этом чате</button>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);

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

        if (!hudVisibilityIntervalId) {
            hudVisibilityIntervalId = window.setInterval(() => {
                updateHudVisibility();
            }, 1200);
        }

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
