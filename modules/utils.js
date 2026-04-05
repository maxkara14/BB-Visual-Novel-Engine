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

export function cleanupMarkdownFences(raw = "") {
    return String(raw || '')
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
}

export function extractBalancedSegment(raw = "", openChar = "[", closeChar = "]") {
    const source = String(raw || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        if (ch === '\\') {
            escapeNext = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === openChar) {
            if (start === -1) start = i;
            depth++;
            continue;
        }
        if (ch === closeChar && depth > 0) {
            depth--;
            if (start !== -1 && depth === 0) {
                return source.substring(start, i + 1);
            }
        }
    }

    return '';
}

export function escapeUnescapedJsonStringChars(raw = "") {
    const source = String(raw || '');
    let result = '';
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];

        if (escapeNext) {
            result += ch;
            escapeNext = false;
            continue;
        }

        if (ch === '\\') {
            result += ch;
            escapeNext = true;
            continue;
        }

        if (ch === '"') {
            result += ch;
            inString = !inString;
            continue;
        }

        if (inString) {
            if (ch === '\n') {
                result += '\\n';
                continue;
            }
            if (ch === '\r') {
                result += '\\r';
                continue;
            }
            if (ch === '\t') {
                result += '\\t';
                continue;
            }
        }

        result += ch;
    }

    return result;
}

export function repairJsonCandidate(raw = "") {
    return escapeUnescapedJsonStringChars(
        cleanupMarkdownFences(raw)
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/,\s*([\]}])/g, '$1')
            .trim(),
    );
}

function normalizeParsedJsonResult(parsed, prefer = 'array') {
    if (prefer === 'object') {
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed)) {
            const firstObject = parsed.find(item => item && typeof item === 'object' && !Array.isArray(item));
            return firstObject || null;
        }
        return null;
    }

    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
        const arrayKeys = ['options', 'items', 'choices', 'result', 'data'];
        for (const key of arrayKeys) {
            if (Array.isArray(parsed[key])) return parsed[key];
        }
    }
    return null;
}

export function parseModelJson(raw = "", options = {}) {
    const prefer = options.prefer === 'object' ? 'object' : 'array';
    const cleaned = cleanupMarkdownFences(raw);
    const candidates = [];
    const pushCandidate = (value) => {
        const text = String(value || '').trim();
        if (!text || candidates.includes(text)) return;
        candidates.push(text);
    };

    const primaryOpen = prefer === 'object' ? '{' : '[';
    const primaryClose = prefer === 'object' ? '}' : ']';
    pushCandidate(extractBalancedSegment(cleaned, primaryOpen, primaryClose));
    pushCandidate(cleaned);
    pushCandidate(extractBalancedSegment(cleaned, '[', ']'));
    pushCandidate(extractBalancedSegment(cleaned, '{', '}'));

    const errors = [];
    for (const candidate of candidates) {
        for (const shouldRepair of [false, true]) {
            const prepared = shouldRepair ? repairJsonCandidate(candidate) : candidate;
            try {
                const parsed = JSON.parse(prepared);
                const normalized = normalizeParsedJsonResult(parsed, prefer);
                if (normalized !== null) {
                    return {
                        ok: true,
                        parsed: normalized,
                        source: prepared,
                        repaired: shouldRepair,
                    };
                }
                errors.push(`Parsed JSON but shape mismatch (${prefer})`);
            } catch (error) {
                errors.push(error?.message || 'Unknown JSON parse error');
            }
        }
    }

    return {
        ok: false,
        parsed: null,
        source: '',
        repaired: false,
        errors,
    };
}

function pickTraitObjectCandidate(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = pickTraitObjectCandidate(item);
            if (found) return found;
        }
        return null;
    }
    if (typeof value !== 'object') return null;

    const directKeys = ['trait_type', 'trait', 'name', 'title', 'label', 'description', 'desc', 'text', 'summary'];
    if (directKeys.some(key => Object.prototype.hasOwnProperty.call(value, key))) {
        return value;
    }

    for (const nested of Object.values(value)) {
        const found = pickTraitObjectCandidate(nested);
        if (found) return found;
    }

    return null;
}

export function sanitizeTraitOutput(raw = "") {
    let text = String(raw || '').trim();
    if (!text) return '';

    text = text
        .replace(/`{3}json/gi, '')
        .replace(/`{3}/g, '')
        .replace(/^\s*trait\s*:\s*/i, '')
        .replace(/^\s*черта\s*:\s*/i, '')
        .trim();

    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
                const traitName = parsed.trait_type || parsed.trait || parsed.name || parsed.title || '';
                const traitDesc = parsed.description || parsed.desc || parsed.text || '';
                if (traitName && traitDesc) {
                    return `${String(traitName).trim()}: ${String(traitDesc).trim()}`;
                }
                if (traitName) return String(traitName).trim();
            }
        } catch (e) {
            void e;
        }
    }

    const keyedName = text.match(/trait_type[\s"']*:[\s"']*([^,}\n"']+)/i);
    const keyedDesc = text.match(/description[\s"']*:[\s"']*([^}\n]+)/i);
    if (keyedName && keyedDesc) {
        return `${keyedName[1].trim()}: ${keyedDesc[1].replace(/["']/g, '').trim()}`;
    }

    const singleLine = text.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
    const cleaned = singleLine
        .replace(/^\s*[-*]\s*/, '')
        .replace(/^\s*(trait|черта)\s*[-:]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned;
}

export function normalizeTraitResponse(raw = "") {
    const rough = sanitizeTraitOutput(raw);
    let text = cleanupMarkdownFences(rough);
    if (!text) return '';

    const parsedJson = parseModelJson(text, { prefer: 'object' });
    if (parsedJson.ok) {
        const traitObject = pickTraitObjectCandidate(parsedJson.parsed);
        if (traitObject) {
            const traitName = traitObject.trait_type || traitObject.trait || traitObject.name || traitObject.title || traitObject.label || '';
            const traitDesc = traitObject.description || traitObject.desc || traitObject.text || traitObject.summary || '';
            if (traitName && traitDesc) {
                return `${String(traitName).trim()}: ${String(traitDesc).trim()}`;
            }
            if (traitName) return String(traitName).trim();
        }
    }

    text = text
        .replace(/^\s*\d+[.)]\s*/, '')
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return text;
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
    
    const rawMessageLength = String(rawMessage || '').length;
    let finalMessage = normalizeGeneratedMessage(rawMessage);
    const normalizedMessageLength = String(finalMessage || '').length;
    console.debug(`[BB VN][debug] message normalization length raw=${rawMessageLength} normalized=${normalizedMessageLength}`);
    
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
    const seenPayloads = new Set();
    const unique = [];

    options.forEach(option => {
        const normalized = normalizeOptionData(option);
        const intentKey = canonicalizeIntent(normalized.intent || '');
        const messageKey = canonicalizeIntent(normalized.message || '').slice(0, 180);
        const key = `${intentKey}__${messageKey}`;
        if (!messageKey || seenPayloads.has(key)) return;
        seenPayloads.add(key);
        unique.push(normalized);
    });

    return unique;
}

export function extractJsonStringMatches(input = "", field = "") {
    const fieldRegex = field.includes('|') ? field : String(field || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
