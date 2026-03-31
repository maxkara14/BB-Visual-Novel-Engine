/**
 * Экранирует HTML символы
 */
export function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function buildIntentFallback(tone = "", risk = "") {
    const t = String(tone || '').toLowerCase();
    const r = String(risk || '').toLowerCase();
    if (t.includes('мяг') || t.includes('неж')) return 'Осторожный шаг';
    if (t.includes('холод') || t.includes('отстр')) return 'Холодный манёвр';
    if (t.includes('дерз') || t.includes('напор')) return 'Смелый ход';
    if (t.includes('опас') || r.includes('выс')) return 'Рискованный выбор';
    return 'Новый ход';
}

export function sanitizeIntentLabel(intent = "", tone = "", risk = "") {
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

export function normalizeGeneratedMessage(message = "") {
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

export function getLegacyToneFromRisk(risk = "") {
    const value = String(risk).toLowerCase();
    if (value.includes('низк') || value.includes('low')) return 'нежно';
    if (value.includes('выс') || value.includes('high')) return 'опасно';
    if (value.includes('сред') || value.includes('med') || value.includes('medium')) return 'дерзко';
    return 'нейтрально';
}

export function getLegacyForecastFromRisk(risk = "") {
    const value = String(risk).toLowerCase();
    if (value.includes('низк') || value.includes('low')) return 'Может мягко сблизить';
    if (value.includes('выс') || value.includes('high')) return 'Усилит напряжение';
    if (value.includes('сред') || value.includes('med') || value.includes('medium')) return 'Может резко сдвинуть динамику';
    return '';
}

export function normalizeOptionData(option = {}) {
    const legacyRisk = option.risk || "";
    const tone = option.tone || getLegacyToneFromRisk(legacyRisk);
    const forecast = option.forecast || getLegacyForecastFromRisk(legacyRisk);
    const targets = Array.isArray(option.targets)
        ? option.targets.filter(Boolean)
        : typeof option.target === 'string' && option.target.trim()
            ? [option.target.trim()]
            : [];

    let intentStr = sanitizeIntentLabel(option.intent || '', tone, legacyRisk);
    
    let rawMessage = option.message || option.text || option.action || option.reply || option.response || option.dialogue || option.content || option.description || '';
    
    let finalMessage = normalizeGeneratedMessage(rawMessage);
    
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

export function canonicalizeIntent(text = "") {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function dedupeOptions(options = []) {
    const seenIntents = new Set();
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

export function extractJsonStringMatches(input = "", field = "") {
    const isMessage = field.includes('message');
    const fieldRegex = field.includes('|') ? field : String(field || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (isMessage) {
        const regex = new RegExp(`"(?:${fieldRegex})"\\s*:\\s*"([\\s\\S]*?)"?(?=\\s*\\}|\\s*,\\s*"|$)`, 'gi');
        return [...String(input || '').matchAll(regex)].map(match => {
            let val = match[1] || '';
            const badTail = val.search(/["']?\s*\}[\s,]*\{/);
            if (badTail !== -1) val = val.substring(0, badTail);
            val = val.replace(/["']+\s*$/, '');
            return val.trim();
        });
    }

    const regex = new RegExp(`"(?:${fieldRegex})"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'gi');
    return [...String(input || '').matchAll(regex)].map(match => match[1] || '');
}

export function normalizeStatusLabel(value = "") {
    return String(value || '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function sanitizeRelationshipStatus(value = "") {
    const normalized = normalizeStatusLabel(value).replace(/[.!?;]+$/g, '').trim();
    if (!normalized) return '';
    return normalized.split(' ').slice(0, 4).join(' ');
}

export function sanitizeMoodlet(value = "") {
    const normalized = String(value || '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[.!?;]+$/g, '')
        .trim();
    if (!normalized) return '';
    return normalized.split(' ').slice(0, 4).join(' ');
}

export function isCollectiveEntityName(name = "") {
    const value = String(name || '').trim().toLowerCase();
    if (!value) return true;
    const collectiveTokenRegex = /(^|\b)(класс|class|коллектив|группа|отряд|команда|team|фракция|faction|клан|семья|family|все|ученики|students|народ|люди|совет|советники|гильдия|отряд|корпус)(\b|$)/i;
    const numberedClassRegex = /\b(\d{1,2}\s*[-–]?\s*[абвгa-z]|[абвгa-z]\s*[-–]?\s*\d{1,2})\b/i;
    const pluralRoleRegex = /\b(ученик(и|ов)|солдат(ы|ов)|охотник(и|ов)|геро(и|ев)|член(ы|ов))\b/i;
    return collectiveTokenRegex.test(value) || numberedClassRegex.test(value) || pluralRoleRegex.test(value);
}

export function isLikelySelfRoleStatus(status = "") {
    const value = normalizeStatusLabel(status).toLowerCase();
    if (!value) return false;
    const userFacingTokens = /(враг|союзник|ученик|соперник|угроза|цель|друг|пария|изгой|пешка|гость|интерес)/i;
    if (userFacingTokens.test(value)) return false;
    const selfRoleTokens = /(наставник|учитель|капитан|командир|лидер|хашира|столп|мастер|сенсей|директор)/i;
    return selfRoleTokens.test(value);
}

export function isNarrativeStatusLeak(status = "") {
    const value = normalizeStatusLabel(status).toLowerCase();
    if (!value) return false;
    return /(котор(ый|ая|ое|ые)|меня|мне|мой|моя|моё|мои)\b/i.test(value);
}

export function isValidUserFacingStatus(status = "") {
    const value = sanitizeRelationshipStatus(status);
    if (!value) return false;
    if (isLikelySelfRoleStatus(value)) return false;
    if (isNarrativeStatusLeak(value)) return false;
    return true;
}

export function coerceUserFacingStatus(candidateStatus = "", affinity = 0, previousStatus = "", delta = 0) {
    void affinity;
    void delta;
    const incoming = sanitizeRelationshipStatus(candidateStatus);
    if (isValidUserFacingStatus(incoming)) return incoming;

    const prev = sanitizeRelationshipStatus(previousStatus);
    if (isValidUserFacingStatus(prev)) return prev;
    return '';
}

export function getToneClass(tone = "") {
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

export function getMemoryBucket(delta) {
    const absDelta = Math.abs(delta);
    if (absDelta >= 15) return 'deep';
    if (absDelta >= 2) return 'soft';
    return '';
}

export function getMemoryTone(delta) {
    if (delta > 0) return 'positive';
    if (delta < 0) return 'negative';
    return 'neutral';
}

export function formatAffinityPoints(value) {
    const points = parseInt(value, 10) || 0;
    return points > 0 ? `+${points}` : `${points}`;
}

export function getShiftDescriptor(delta, moodlet = '') {
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

export function getAffinityNarrative(affinity) {
    if (affinity <= -50) return 'Глубокий разлом';
    if (affinity < -10) return 'Холод и настороженность';
    if (affinity <= 10) return 'Хрупкий нейтралитет';
    if (affinity <= 50) return 'Осторожное сближение';
    if (affinity <= 80) return 'Стабильное доверие';
    return 'Очень близкая связь';
}
