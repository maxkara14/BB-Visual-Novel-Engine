/* global SillyTavern */
import { setExtensionPrompt, chat_metadata, saveChatDebounced, extension_prompt_roles, extension_prompt_types, callPopup } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { 
    currentCalculatedStats, 
    currentStoryMoments, 
    setCurrentCalculatedStats,
    setSocialParseDebug
} from './state.js';
import { MODULE_NAME, SOCIAL_PROMPT, TOAST_MAX_VISIBLE } from './constants.js';
import { 
    sanitizeMoodlet, 
    getMemoryBucket, 
    getMemoryTone, 
    coerceUserFacingStatus, 
    isValidUserFacingStatus,
    isCollectiveEntityName, 
    getShiftDescriptor,
    formatAffinityPoints,
    escapeHtml,
    sanitizeRelationshipStatus,
    normalizeTraitResponse,
    isLikelyModelRefusalText
} from './utils.js';
import { showStoryMomentToast, notifySuccess, notifyInfo, notifyError, pickToastMoment, getMomentToastPriority } from './toasts.js';
import { buildChoiceContextPrompt, getActiveChoiceContext, tryBindPendingChoiceContextToMessage } from './generator.js';

function normalizeCharacterLookupName(name = '') {
    return String(name || '')
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hashString(input = '') {
    let hash = 2166136261;
    const source = String(input || '');
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return Math.abs(hash >>> 0).toString(36);
}

const shownLiveToastKeys = [];
const promptedMergeSuggestionKeys = new Set();
const pendingMergeSuggestionQueue = [];
let isProcessingMergeSuggestionQueue = false;
const RECENT_RELATION_UPDATE_REPEAT_WINDOW = 12;
const MIN_REASON_TOKEN_LENGTH = 3;
const MIN_FUZZY_REASON_OVERLAP = 3;
const MIN_REASON_PREFIX_MATCH = 4;
const MIN_REASON_SHARED_SUBSTRING_LENGTH = 28;
const FUZZY_REASON_JACCARD_THRESHOLD = 0.55;
const FUZZY_REASON_SUBSET_THRESHOLD = 0.75;
const REASON_TOKEN_STOPWORDS = new Set([
    'это', 'этот', 'эта', 'эти', 'как', 'так', 'или', 'для', 'при', 'без', 'под', 'над', 'через',
    'она', 'они', 'оно', 'его', 'ему', 'ему', 'её', 'ее', 'ней', 'него', 'них', 'них',
    'когда', 'тогда', 'потому', 'который', 'которая', 'которые', 'только', 'просто', 'снова',
    'после', 'среди', 'между', 'чтобы', 'если', 'даже', 'были', 'было', 'была', 'есть',
]);

function hasShownLiveToast(key = '') {
    return shownLiveToastKeys.includes(String(key || ''));
}

function rememberLiveToast(key = '') {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return;
    const existingIndex = shownLiveToastKeys.indexOf(normalizedKey);
    if (existingIndex !== -1) shownLiveToastKeys.splice(existingIndex, 1);
    shownLiveToastKeys.push(normalizedKey);
    if (shownLiveToastKeys.length > 240) shownLiveToastKeys.shift();
}


function buildMergeSuggestionKey(sourceName = '', targetId = '', targetName = '') {
    return hashString([normalizeCharacterLookupName(sourceName), String(targetId || '').trim(), normalizeCharacterLookupName(targetName)].join('|'));
}

async function processMergeSuggestionQueue() {
    if (isProcessingMergeSuggestionQueue) return;
    isProcessingMergeSuggestionQueue = true;
    try {
        while (pendingMergeSuggestionQueue.length > 0) {
            const suggestion = pendingMergeSuggestionQueue.shift();
            if (!suggestion?.source || !suggestion?.target) continue;

            let confirmed = false;
            try {
                confirmed = await SillyTavern.getContext().callPopup(
                    `<h3>Похожий персонаж найден</h3><p><strong>${escapeHtml(suggestion.source)}</strong> очень похож на <strong>${escapeHtml(suggestion.target)}</strong>.</p><p>Слить их сейчас в одного персонажа?</p><p><span style="font-size:12px; color:#94a3b8;">Перед слиянием лучше сделать бэкап снапшотом.</span></p>`,
                    'confirm'
                );
            } catch (error) {
                console.warn('[BB VN] Failed to show merge suggestion popup', error);
                confirmed = false;
            }

            if (!confirmed) continue;

            const result = mergeCharacterRecords(suggestion.source, suggestion.target);
            if (result?.ok) {
                saveChatDebounced();
                recalculateAllStats(false);
                if (typeof window['bbRenderMergeSuggestionsList'] === 'function') {
                    window['bbRenderMergeSuggestionsList']();
                }
                notifySuccess(result.same ? `Это уже один и тот же персонаж: ${result.targetName}` : `Слито записей: ${result.count}`);
            }
        }
    } finally {
        isProcessingMergeSuggestionQueue = false;
    }
}

function queueMergeSuggestionPrompt(suggestion = null) {
    if (!suggestion?.source || !suggestion?.target) return;
    const key = buildMergeSuggestionKey(suggestion.source, suggestion.target_id, suggestion.target);
    if (promptedMergeSuggestionKeys.has(key)) return;
    promptedMergeSuggestionKeys.add(key);
    pendingMergeSuggestionQueue.push(suggestion);
    window.setTimeout(() => {
        void processMergeSuggestionQueue();
    }, 0);
}

function buildLiveToastKey(scopeKey = '', messageMeta = '', moment = {}) {
    return hashString([
        String(scopeKey || 'default'),
        String(messageMeta || ''),
        String(moment?.type || ''),
        String(moment?.char || ''),
        String(moment?.title || ''),
        String(moment?.text || ''),
    ].join('|'));
}

function queueLiveToastCandidate(queue = [], scopeKey = '', messageMeta = '', moment = null) {
    if (!Array.isArray(queue) || !moment) return;
    queue.push({
        key: buildLiveToastKey(scopeKey, messageMeta, moment),
        moment,
        priority: getMomentToastPriority(moment.type),
        order: queue.length,
    });
}

function getCurrentPersonaText() {
    try {
        return String(SillyTavern.getContext().substituteParams('{{persona}}') || '').trim();
    } catch (error) {
        void error;
        return '';
    }
}

function getLegacyPersonaTextScopeKey() {
    const personaText = getCurrentPersonaText();
    if (!personaText) return 'default';
    return `persona_${hashString(personaText)}`;
}

function normalizePersonaIdentityName(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizePersonaAvatarRef(value = '') {
    return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/[?#].*$/, '')
        .toLowerCase();
}

function firstNonEmptyString(values = []) {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) return normalized;
    }
    return '';
}

function getCurrentPersonaName() {
    try {
        const context = SillyTavern.getContext();
        return firstNonEmptyString([
            context?.substituteParams?.('{{user}}'),
            context?.name1,
            context?.user_name,
            chat_metadata['persona_name'],
            chat_metadata['user_name'],
        ]);
    } catch (error) {
        void error;
        return '';
    }
}

function buildPersonaIdentityRef({ name = '', avatarRef = '' } = {}) {
    const normalizedName = normalizePersonaIdentityName(name);
    const normalizedAvatar = normalizePersonaAvatarRef(avatarRef);
    if (normalizedName && normalizedAvatar) return `name:${normalizedName}|avatar:${normalizedAvatar}`;
    if (normalizedAvatar) return `avatar:${normalizedAvatar}`;
    if (normalizedName) return `name:${normalizedName}`;
    return '';
}

function getPersonaIdentityFromMessage(msg = null) {
    if (!msg || typeof msg !== 'object') return { name: '', avatarRef: '', ref: '' };
    const name = firstNonEmptyString([
        msg.name,
        msg.display_name,
        msg.user_name,
        msg.original_name,
        msg.extra?.display_name,
        msg.extra?.user_name,
    ]);
    const avatarRef = firstNonEmptyString([
        msg.force_avatar,
        msg.original_avatar,
        msg.avatar,
        msg.user_avatar,
        msg.extra?.force_avatar,
        msg.extra?.original_avatar,
        msg.extra?.avatar,
        msg.extra?.user_avatar,
    ]);
    const ref = buildPersonaIdentityRef({ name, avatarRef });
    return { name, avatarRef, ref };
}

function getLatestUserPersonaIdentityFromChat(chat = []) {
    if (!Array.isArray(chat)) return null;
    for (let idx = chat.length - 1; idx >= 0; idx--) {
        const msg = chat[idx];
        if (!msg?.is_user) continue;
        const identity = getPersonaIdentityFromMessage(msg);
        if (identity.ref || identity.name || identity.avatarRef) return identity;
    }
    return null;
}

function getCurrentPersonaAvatarRef() {
    try {
        const context = SillyTavern.getContext();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const lastUserIdentity = getLatestUserPersonaIdentityFromChat(chat);
        const directAvatar = firstNonEmptyString([
            context?.user_avatar,
            context?.userAvatar,
            context?.avatar,
            chat_metadata['persona_avatar'],
            chat_metadata['user_avatar'],
        ]);
        if (directAvatar) return directAvatar;
        return lastUserIdentity?.avatarRef || '';
    } catch (error) {
        void error;
        return '';
    }
}

function getCurrentPersonaIdentity() {
    let context = null;
    try {
        context = SillyTavern.getContext();
    } catch (error) {
        void error;
    }

    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const lastUserIdentity = getLatestUserPersonaIdentityFromChat(chat);
    const currentName = getCurrentPersonaName();
    const currentAvatarRef = getCurrentPersonaAvatarRef();
    const name = currentName || lastUserIdentity?.name || '';
    const avatarRef = currentAvatarRef || (!currentName || normalizePersonaIdentityName(currentName) === normalizePersonaIdentityName(lastUserIdentity?.name || '')
        ? (lastUserIdentity?.avatarRef || '')
        : '');
    const ref = buildPersonaIdentityRef({ name, avatarRef });
    return { name, avatarRef, ref };
}

function getCurrentPersonaLabel() {
    const personaName = getCurrentPersonaName();
    if (personaName) return personaName.slice(0, 80);
    const personaText = getCurrentPersonaText();
    if (!personaText) return 'Default persona';
    return personaText.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 80) || 'Persona';
}

function cleanPersonaNameCandidate(value = '') {
    return String(value || '')
        .replace(/[*_`~]+/g, '')
        .replace(/\[[^\]]*]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[«»"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function collectPersonaDeclaredNames(personaText = '') {
    const text = String(personaText || '').replace(/\r/g, '');
    if (!text.trim()) return [];

    const candidates = [];
    const nameLineRegex = /(?:^|\n)\s*(?:[#>*\-\s]*)?(?:\*\*)?\s*(?:имя|name|ник|nickname)\s*(?:\*\*)?\s*[:：-]\s*([^\n]+)/giu;
    for (const match of text.matchAll(nameLineRegex)) {
        const rawValue = cleanPersonaNameCandidate(match[1] || '');
        if (!rawValue) continue;
        candidates.push(rawValue);
        rawValue
            .split(/[\/|,;]+/g)
            .map(cleanPersonaNameCandidate)
            .filter(Boolean)
            .forEach(name => candidates.push(name));
    }

    return candidates.filter(name => name.length >= 2 && name.length <= 100);
}

function getUserCharacterNameCandidates() {
    const candidates = [
        'user',
        'player',
        'protagonist',
        'narrator',
        'пользователь',
        'юзер',
        'игрок',
        'протагонист',
        'рассказчик',
        'герой',
        'героиня',
    ];

    try {
        const context = SillyTavern.getContext?.();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const identity = getCurrentPersonaIdentity();
        candidates.push(
            context?.substituteParams?.('{{user}}'),
            context?.name1,
            context?.user_name,
            chat_metadata['persona_name'],
            chat_metadata['user_name'],
            identity?.name,
        );

        const latestUserIdentity = getLatestUserPersonaIdentityFromChat(chat);
        candidates.push(latestUserIdentity?.name);
    } catch (error) {
        void error;
    }

    collectPersonaDeclaredNames(getCurrentPersonaText()).forEach(name => candidates.push(name));

    const seen = new Set();
    return candidates
        .map(cleanPersonaNameCandidate)
        .filter(Boolean)
        .filter(name => {
            const normalized = normalizeCharacterLookupName(name);
            if (!normalized || seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
}

function isUserPersonaCharacterName(rawName = '') {
    const normalized = normalizeCharacterLookupName(rawName);
    if (!normalized) return false;
    return getUserCharacterNameCandidates().some(candidate => normalizeCharacterLookupName(candidate) === normalized);
}

function filterUserPersonaSocialUpdates(updates = []) {
    if (!Array.isArray(updates) || updates.length === 0) {
        return { updates: Array.isArray(updates) ? updates : [], changed: false, dropped: [] };
    }

    const dropped = [];
    const filtered = updates.filter(update => {
        if (!isUserPersonaCharacterName(update?.name || '')) return true;
        dropped.push(update);
        return false;
    });

    return {
        updates: filtered,
        changed: filtered.length !== updates.length,
        dropped,
    };
}

function purgeUserPersonaTracking(scopeState = {}) {
    let changed = false;
    const removeNamedMapEntries = (map = null) => {
        if (!map || typeof map !== 'object') return;
        Object.keys(map).forEach(name => {
            if (!isUserPersonaCharacterName(name)) return;
            delete map[name];
            changed = true;
        });
    };
    const filterNameList = (list = []) => {
        if (!Array.isArray(list)) return [];
        const filtered = list.filter(name => !isUserPersonaCharacterName(name));
        if (filtered.length !== list.length) changed = true;
        return filtered;
    };

    removeNamedMapEntries(scopeState.char_bases);
    removeNamedMapEntries(scopeState.char_bases_romance);
    removeNamedMapEntries(scopeState.snapshot_baseline?.characters);
    removeNamedMapEntries(scopeState.snapshot_baseline?.char_bases);
    removeNamedMapEntries(scopeState.snapshot_baseline?.char_bases_romance);

    if (scopeState.char_registry && typeof scopeState.char_registry === 'object') {
        Object.entries(scopeState.char_registry).forEach(([id, entry]) => {
            const names = [entry?.primary_name, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
            if (!names.some(name => isUserPersonaCharacterName(name))) return;
            delete scopeState.char_registry[id];
            changed = true;
        });
    }

    scopeState.ignored_chars = filterNameList(scopeState.ignored_chars);
    scopeState.platonic_chars = filterNameList(scopeState.platonic_chars);
    if (Array.isArray(scopeState.merge_suggestions)) {
        const filteredSuggestions = scopeState.merge_suggestions.filter(item =>
            !isUserPersonaCharacterName(item?.source || '') && !isUserPersonaCharacterName(item?.target || '')
        );
        if (filteredSuggestions.length !== scopeState.merge_suggestions.length) changed = true;
        scopeState.merge_suggestions = filteredSuggestions;
    }

    chat_metadata['bb_vn_char_bases'] = scopeState.char_bases;
    chat_metadata['bb_vn_char_bases_romance'] = scopeState.char_bases_romance;
    chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars;
    chat_metadata['bb_vn_platonic_chars'] = scopeState.platonic_chars;
    chat_metadata['bb_vn_char_registry'] = scopeState.char_registry;
    chat_metadata['bb_vn_merge_suggestions'] = scopeState.merge_suggestions;

    return changed;
}

function ensurePersonaBindingsStore() {
    if (!chat_metadata['bb_vn_persona_bindings'] || typeof chat_metadata['bb_vn_persona_bindings'] !== 'object') {
        chat_metadata['bb_vn_persona_bindings'] = {};
    }
    return chat_metadata['bb_vn_persona_bindings'];
}

function getScopeDataScore(scopeState = {}) {
    if (!scopeState || typeof scopeState !== 'object') return 0;
    let score = 0;
    score += Object.keys(scopeState.char_bases || {}).length * 4;
    score += Object.keys(scopeState.char_bases_romance || {}).length * 4;
    score += Object.keys(scopeState.char_registry || {}).length * 3;
    score += Array.isArray(scopeState.global_log) ? scopeState.global_log.length * 2 : 0;
    score += Array.isArray(scopeState.ignored_chars) ? scopeState.ignored_chars.length : 0;
    score += Array.isArray(scopeState.platonic_chars) ? scopeState.platonic_chars.length : 0;
    score += Array.isArray(scopeState.merge_suggestions) ? scopeState.merge_suggestions.length : 0;
    score += scopeState.snapshot_baseline?.characters ? Object.keys(scopeState.snapshot_baseline.characters).length * 6 : 0;
    score += parseInt(scopeState.log_cutoff_index, 10) || 0;
    score += parseInt(scopeState.snapshot_cutoff_index, 10) || 0;
    return score;
}

function collectMessageScopeKeys(msg = null) {
    const scopeKeys = [];
    if (!msg || typeof msg !== 'object') return scopeKeys;
    const collectFromMap = (map) => {
        if (!map || typeof map !== 'object') return;
        Object.values(map).forEach(entries => {
            if (!Array.isArray(entries)) return;
            entries.forEach(entry => {
                const scope = String(entry?.scope || '').trim();
                if (scope) scopeKeys.push(scope);
            });
        });
    };
    collectFromMap(msg.extra?.bb_social_swipes);
    collectFromMap(msg.extra?.bb_vn_char_traits_swipes);
    return scopeKeys;
}

function buildScopeOwnershipIndex(chat = []) {
    if (!Array.isArray(chat) || chat.length === 0) return {};
    const ownership = {};
    let lastUserIdentity = null;

    chat.forEach(msg => {
        if (msg?.is_user) {
            const identity = getPersonaIdentityFromMessage(msg);
            if (identity.ref) lastUserIdentity = identity;
            return;
        }

        if (!lastUserIdentity?.ref) return;
        collectMessageScopeKeys(msg).forEach(scopeKey => {
            if (!ownership[scopeKey]) ownership[scopeKey] = {};
            ownership[scopeKey][lastUserIdentity.ref] = (ownership[scopeKey][lastUserIdentity.ref] || 0) + 1;
        });
    });

    return ownership;
}

function getDominantPersonaRefForScope(ownership = {}, scopeKey = '') {
    const variants = ownership?.[scopeKey];
    if (!variants || typeof variants !== 'object') return null;
    let bestRef = '';
    let bestCount = 0;
    let total = 0;
    Object.entries(variants).forEach(([ref, count]) => {
        const numericCount = parseInt(count, 10) || 0;
        total += numericCount;
        if (numericCount > bestCount) {
            bestRef = ref;
            bestCount = numericCount;
        }
    });
    if (!bestRef) return null;
    return { ref: bestRef, count: bestCount, total };
}

function buildStablePersonaScopeKey(identity = null, fallback = '') {
    const basis = identity?.ref || fallback || `scope_${Date.now()}`;
    return `persona_v2_${hashString(basis)}`;
}

function ensureUniqueScopeKey(scopes = {}, requestedKey = 'persona_v2_default') {
    if (!scopes[requestedKey] || typeof scopes[requestedKey] === 'object') return requestedKey;
    let index = 1;
    let candidate = `${requestedKey}_${index}`;
    while (scopes[candidate]) {
        index += 1;
        candidate = `${requestedKey}_${index}`;
    }
    return candidate;
}

function choosePersonaScopeCandidate(scopes, identity, legacyScopeKey, activeScopeKey, ownership) {
    const candidates = new Map();
    const addCandidate = (scopeKey, baseScore = 0) => {
        if (!scopeKey || !scopes?.[scopeKey] || typeof scopes[scopeKey] !== 'object') return;
        const dataScore = getScopeDataScore(scopes[scopeKey]);
        const owner = getDominantPersonaRefForScope(ownership, scopeKey);
        let score = Number(baseScore || 0) + Math.min(dataScore, 80);
        if (dataScore === 0 && !owner?.ref) score -= 260;
        if (identity?.ref && owner?.ref) {
            if (owner.ref === identity.ref) score += 140 + Math.min(owner.count * 5, 60);
            else score -= 180;
        }
        const existing = candidates.get(scopeKey);
        if (!existing || score > existing.score) {
            candidates.set(scopeKey, { scopeKey, score, dataScore, owner });
        }
    };

    addCandidate(legacyScopeKey, 220);
    addCandidate(activeScopeKey, 80);

    Object.keys(scopes || {}).forEach(scopeKey => {
        const owner = getDominantPersonaRefForScope(ownership, scopeKey);
        if (identity?.ref && owner?.ref === identity.ref) {
            addCandidate(scopeKey, 180 + Math.min(owner.count * 6, 70));
        }
    });

    const nonEmptyScopes = Object.entries(scopes || {})
        .filter(([, scopeState]) => getScopeDataScore(scopeState) > 0)
        .map(([scopeKey]) => scopeKey);
    if (nonEmptyScopes.length === 1) addCandidate(nonEmptyScopes[0], 25);

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    const best = ranked[0] || null;
    if (best && best.score >= 40) return best.scopeKey;

    return ensureUniqueScopeKey(scopes, buildStablePersonaScopeKey(identity, legacyScopeKey));
}

function ensureResolvedPersonaScope() {
    if (!chat_metadata['bb_vn_persona_states'] || typeof chat_metadata['bb_vn_persona_states'] !== 'object') {
        chat_metadata['bb_vn_persona_states'] = {};
    }

    const scopes = chat_metadata['bb_vn_persona_states'];
    const bindings = ensurePersonaBindingsStore();
    const identity = getCurrentPersonaIdentity();
    const identityRef = identity?.ref || `legacy:${getLegacyPersonaTextScopeKey()}`;
    const legacyScopeKey = getLegacyPersonaTextScopeKey();
    const activeScopeKey = String(chat_metadata['bb_vn_active_persona_scope'] || '').trim();
    let binding = bindings[identityRef] && typeof bindings[identityRef] === 'object' ? bindings[identityRef] : null;

    if (!binding || !binding.scope_key || !scopes[binding.scope_key]) {
        const chat = SillyTavern.getContext().chat || [];
        const ownership = buildScopeOwnershipIndex(chat);
        const chosenScopeKey = choosePersonaScopeCandidate(scopes, identity, legacyScopeKey, activeScopeKey, ownership);
        binding = {
            scope_key: chosenScopeKey,
            aliases: [],
            persona_name: identity?.name || '',
            persona_avatar: identity?.avatarRef || '',
            updated_at: Date.now(),
        };
        bindings[identityRef] = binding;
    }

    if (!Array.isArray(binding.aliases)) binding.aliases = [];
    if (legacyScopeKey && legacyScopeKey !== binding.scope_key && !binding.aliases.includes(legacyScopeKey)) {
        binding.aliases.push(legacyScopeKey);
    }
    if (identity?.ref) {
        const chat = SillyTavern.getContext().chat || [];
        const ownership = buildScopeOwnershipIndex(chat);
        Object.keys(scopes).forEach(candidateScopeKey => {
            if (!candidateScopeKey || candidateScopeKey === binding.scope_key) return;
            const owner = getDominantPersonaRefForScope(ownership, candidateScopeKey);
            if (owner?.ref === identity.ref && !binding.aliases.includes(candidateScopeKey)) {
                binding.aliases.push(candidateScopeKey);
            }
        });
    }
    binding.persona_name = identity?.name || binding.persona_name || '';
    binding.persona_avatar = identity?.avatarRef || binding.persona_avatar || '';
    binding.updated_at = Date.now();

    if (!scopes[binding.scope_key] || typeof scopes[binding.scope_key] !== 'object') {
        scopes[binding.scope_key] = {};
    }

    const scopeState = ensurePersonaStateShape(scopes[binding.scope_key]);
    scopeState.label = binding.persona_name || scopeState.label || getCurrentPersonaLabel();

    return {
        scopeKey: binding.scope_key,
        scopeState,
        identity,
        binding,
        aliasSet: new Set([binding.scope_key, ...(binding.aliases || [])]),
    };
}

export function getCurrentPersonaScopeKey() {
    return ensureResolvedPersonaScope().scopeKey;
}

function cloneJsonData(value, fallback) {
    try {
        if (value === undefined) return fallback;
        return JSON.parse(JSON.stringify(value));
    } catch (error) {
        void error;
        return fallback;
    }
}

function clampPercentValue(value = 0, fallback = 50) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(100, numeric));
}

function clampZoomValue(value = 100, fallback = 100) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(100, Math.min(320, numeric));
}

function normalizeCharacterDescription(value = '') {
    return String(value || '')
        .replace(/\r/g, '')
        .trim();
}

function normalizeAvatarCrop(value = {}) {
    const crop = value && typeof value === 'object' ? value : {};
    return {
        x: clampPercentValue(crop.x, 50),
        y: clampPercentValue(crop.y, 50),
        zoom: clampZoomValue(crop.zoom, 100),
    };
}

function getCharacterProfileFromEntry(entry = null) {
    return {
        description: normalizeCharacterDescription(entry?.description || ''),
        avatar: String(entry?.avatar || '').trim(),
        avatarSource: String(entry?.avatarSource || '').trim(),
        avatarCrop: normalizeAvatarCrop(entry?.avatarCrop),
    };
}

function applyCharacterProfileToEntry(entry, updates = {}) {
    if (!entry || typeof entry !== 'object' || !updates || typeof updates !== 'object') {
        return getCharacterProfileFromEntry(entry);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'description')) {
        entry.description = normalizeCharacterDescription(updates.description);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'avatar')) {
        entry.avatar = String(updates.avatar || '').trim();
        if (!entry.avatar) {
            entry.avatarSource = '';
            entry.avatarCrop = normalizeAvatarCrop();
        }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'avatarSource')) {
        entry.avatarSource = String(updates.avatarSource || '').trim();
    } else if (!entry.avatarSource || typeof entry.avatarSource !== 'string') {
        entry.avatarSource = '';
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'avatarCrop')) {
        entry.avatarCrop = normalizeAvatarCrop(updates.avatarCrop);
    } else if (!entry.avatarCrop || typeof entry.avatarCrop !== 'object') {
        entry.avatarCrop = normalizeAvatarCrop();
    }

    return getCharacterProfileFromEntry(entry);
}

function clampRelationshipValue(value = 0) {
    const numeric = parseInt(value, 10);
    if (Number.isNaN(numeric)) return 0;
    return Math.max(-100, Math.min(100, numeric));
}

function normalizeImportedHistoryEntry(entry = {}) {
    const delta = Math.max(-20, Math.min(20, parseInt(entry?.delta, 10) || 0));
    const affinityDelta = parseInt(entry?.affinityDelta, 10);
    const romanceDelta = parseInt(entry?.romanceDelta, 10);
    return {
        delta,
        affinityDelta: Number.isNaN(affinityDelta) ? delta : Math.max(-20, Math.min(20, affinityDelta)),
        romanceDelta: Number.isNaN(romanceDelta) ? 0 : Math.max(-20, Math.min(20, romanceDelta)),
        reason: String(entry?.reason || ''),
        moodlet: sanitizeMoodlet(entry?.moodlet || ''),
    };
}

function normalizeImportedMemoryEntry(entry = {}) {
    const delta = Math.max(-20, Math.min(20, parseInt(entry?.delta, 10) || 0));
    return {
        text: String(entry?.text || ''),
        delta,
        tone: entry?.tone === 'positive' || entry?.tone === 'negative' || entry?.tone === 'neutral'
            ? entry.tone
            : getMemoryTone(delta),
        moodlet: sanitizeMoodlet(entry?.moodlet || ''),
    };
}

function normalizeDedupText(value = '') {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeImpactDedupToken(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/-/g, '_');
}

function buildMemoryEntryDedupKey(entry = {}) {
    const normalized = normalizeImportedMemoryEntry(entry);
    const text = normalizeDedupText(normalized.text);
    if (!text) return '';
    return [
        text,
        normalized.delta,
        normalized.tone,
    ].join('|');
}

function dedupeMemoryEntries(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const seen = new Set();
    const deduped = [];
    for (let index = entries.length - 1; index >= 0; index--) {
        const normalized = normalizeImportedMemoryEntry(entries[index]);
        const key = buildMemoryEntryDedupKey(normalized);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.unshift(normalized);
    }

    return deduped;
}

function buildSocialUpdateDedupKey(update = {}) {
    const name = normalizeCharacterLookupName(update?.name || '');
    if (!name) return '';
    if (isDebugInjectedUpdate(update)) {
        const debugId = String(update?.debug_id || '').trim();
        if (debugId) return `debug|${debugId}`;
    }

    return [
        name,
        normalizeImpactDedupToken(update?.friendship_impact || update?.impact_level || ''),
        normalizeImpactDedupToken(update?.romance_impact || update?.romantic_impact || update?.love_impact || ''),
        normalizeDedupText(update?.role_dynamic || update?.status || ''),
        normalizeDedupText(update?.reason || ''),
    ].join('|');
}

function buildRecentRelationshipRepeatKey(charName = '', friendshipDelta = 0, romanceDelta = 0, reason = '') {
    const normalizedName = normalizeCharacterLookupName(charName);
    const normalizedReason = normalizeDedupText(reason);
    if (!normalizedName || !normalizedReason) return '';
    if (friendshipDelta === 0 && romanceDelta === 0) return '';
    return [
        normalizedName,
        friendshipDelta,
        romanceDelta,
        normalizedReason,
    ].join('|');
}

function tokenizeReasonForSimilarity(reason = '') {
    return normalizeCharacterLookupName(reason)
        .split(' ')
        .map(token => token.trim())
        .filter(token => token && token.length >= MIN_REASON_TOKEN_LENGTH && !REASON_TOKEN_STOPWORDS.has(token));
}

function getReasonSharedPrefixLength(leftTokens = [], rightTokens = []) {
    const limit = Math.min(leftTokens.length, rightTokens.length);
    let prefixLength = 0;
    while (prefixLength < limit && leftTokens[prefixLength] === rightTokens[prefixLength]) {
        prefixLength++;
    }
    return prefixLength;
}

function getLongestCommonTokenSubstringLength(leftTokens = [], rightTokens = []) {
    if (!leftTokens.length || !rightTokens.length) return 0;
    const dp = Array.from({ length: leftTokens.length + 1 }, () => Array(rightTokens.length + 1).fill(0));
    let best = 0;

    for (let leftIndex = 1; leftIndex <= leftTokens.length; leftIndex++) {
        for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex++) {
            if (leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1]) {
                dp[leftIndex][rightIndex] = dp[leftIndex - 1][rightIndex - 1] + 1;
                if (dp[leftIndex][rightIndex] > best) best = dp[leftIndex][rightIndex];
            }
        }
    }

    return best;
}

function areReasonsSemanticallySimilar(leftReason = '', rightReason = '') {
    const leftNormalized = normalizeDedupText(leftReason);
    const rightNormalized = normalizeDedupText(rightReason);
    if (!leftNormalized || !rightNormalized) return false;
    if (leftNormalized === rightNormalized) return true;

    const shorter = leftNormalized.length <= rightNormalized.length ? leftNormalized : rightNormalized;
    const longer = shorter === leftNormalized ? rightNormalized : leftNormalized;
    if (shorter.length >= MIN_REASON_SHARED_SUBSTRING_LENGTH && longer.includes(shorter)) return true;

    const leftTokens = tokenizeReasonForSimilarity(leftNormalized);
    const rightTokens = tokenizeReasonForSimilarity(rightNormalized);
    if (!leftTokens.length || !rightTokens.length) return false;

    const sharedPrefixLength = getReasonSharedPrefixLength(leftTokens, rightTokens);
    if (sharedPrefixLength >= MIN_REASON_PREFIX_MATCH) return true;

    const sharedSubstringTokens = getLongestCommonTokenSubstringLength(leftTokens, rightTokens);
    if (sharedSubstringTokens >= MIN_REASON_PREFIX_MATCH) return true;

    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    let overlap = 0;
    leftSet.forEach(token => {
        if (rightSet.has(token)) overlap++;
    });
    if (overlap < MIN_FUZZY_REASON_OVERLAP) return false;

    const unionSize = new Set([...leftSet, ...rightSet]).size || 1;
    const jaccard = overlap / unionSize;
    const subsetCoverage = overlap / Math.min(leftSet.size, rightSet.size);
    return jaccard >= FUZZY_REASON_JACCARD_THRESHOLD || subsetCoverage >= FUZZY_REASON_SUBSET_THRESHOLD;
}

function findRecentSemanticallyRepeatedUpdate(records = [], candidate = {}, currentIndex = -1) {
    if (!Array.isArray(records) || !candidate?.charName || currentIndex < 0) return null;
    const candidateReason = normalizeDedupText(candidate.reason || '');
    if (!candidateReason) return null;

    for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex--) {
        const record = records[recordIndex];
        if (!record?.charName) continue;
        if (normalizeCharacterLookupName(record.charName) !== normalizeCharacterLookupName(candidate.charName)) continue;
        if ((currentIndex - (record.idx ?? -999)) > RECENT_RELATION_UPDATE_REPEAT_WINDOW) break;
        if ((record.friendshipDelta || 0) !== (candidate.friendshipDelta || 0)) continue;
        if ((record.romanceDelta || 0) !== (candidate.romanceDelta || 0)) continue;
        if (areReasonsSemanticallySimilar(record.reason || '', candidateReason)) return record;
    }

    return null;
}

function dedupeSocialUpdateEntries(updates = []) {
    if (!Array.isArray(updates) || updates.length === 0) {
        return { updates: Array.isArray(updates) ? [] : [], changed: false };
    }

    const seen = new Set();
    const deduped = [];
    let changed = false;

    updates.forEach(update => {
        if (!update || typeof update !== 'object') {
            changed = true;
            return;
        }

        const key = buildSocialUpdateDedupKey(update);
        if (key && seen.has(key)) {
            changed = true;
            return;
        }

        if (key) seen.add(key);
        deduped.push(update);
    });

    return {
        updates: deduped,
        changed,
    };
}

function normalizeImportedTraitEntry(entry = {}) {
    const normalizedTrait = normalizeTraitResponse(entry?.trait || '');
    if (!normalizedTrait) return null;
    const normalizedType = entry?.type === 'positive' || entry?.type === 'negative' ? entry.type : '';
    return {
        trait: normalizedTrait,
        type: normalizedType,
    };
}

function normalizeImportedCharacterStats(stats = {}) {
    const memories = stats?.memories && typeof stats.memories === 'object' ? stats.memories : {};
    return {
        affinity: clampRelationshipValue(stats?.affinity),
        romance: clampRelationshipValue(stats?.romance),
        history: Array.isArray(stats?.history) ? stats.history.map(normalizeImportedHistoryEntry).slice(-24) : [],
        status: sanitizeRelationshipStatus(stats?.status || ''),
        memories: {
            soft: Array.isArray(memories.soft) ? dedupeMemoryEntries(memories.soft).slice(-4) : [],
            deep: Array.isArray(memories.deep) ? dedupeMemoryEntries(memories.deep) : [],
            archive: Array.isArray(memories.archive) ? dedupeMemoryEntries(memories.archive) : [],
        },
        core_traits: Array.isArray(stats?.core_traits)
            ? stats.core_traits.map(normalizeImportedTraitEntry).filter(Boolean)
            : [],
    };
}

function mergeImportedCharacterStats(targetStats = {}, sourceStats = {}) {
    const target = normalizeImportedCharacterStats(targetStats);
    const source = normalizeImportedCharacterStats(sourceStats);
    return normalizeImportedCharacterStats({
        affinity: clampRelationshipValue((target.affinity || 0) + (source.affinity || 0)),
        romance: clampRelationshipValue((target.romance || 0) + (source.romance || 0)),
        status: target.status || source.status || '',
        history: [...(target.history || []), ...(source.history || [])].slice(-24),
        memories: {
            soft: [...(target.memories?.soft || []), ...(source.memories?.soft || [])].slice(-4),
            deep: [...(target.memories?.deep || []), ...(source.memories?.deep || [])],
            archive: [...(target.memories?.archive || []), ...(source.memories?.archive || [])],
        },
        core_traits: [...(target.core_traits || []), ...(source.core_traits || [])],
    });
}

function ensurePersonaStateShape(scopeState = {}) {
    if (!scopeState.char_bases || typeof scopeState.char_bases !== 'object') scopeState.char_bases = {};
    if (!scopeState.char_bases_romance || typeof scopeState.char_bases_romance !== 'object') scopeState.char_bases_romance = {};
    if (!Array.isArray(scopeState.ignored_chars)) scopeState.ignored_chars = [];
    if (!Array.isArray(scopeState.platonic_chars)) scopeState.platonic_chars = [];
    if (!Array.isArray(scopeState.global_log)) scopeState.global_log = [];
    if (!scopeState.char_registry || typeof scopeState.char_registry !== 'object') scopeState.char_registry = {};
    if (!Array.isArray(scopeState.merge_suggestions)) scopeState.merge_suggestions = [];
    scopeState.log_cutoff_index = parseInt(scopeState.log_cutoff_index, 10) || 0;
    scopeState.snapshot_cutoff_index = parseInt(scopeState.snapshot_cutoff_index, 10) || 0;
    if (!scopeState.snapshot_baseline || typeof scopeState.snapshot_baseline !== 'object') scopeState.snapshot_baseline = null;
    if (!scopeState.snapshot_restore_state || typeof scopeState.snapshot_restore_state !== 'object') scopeState.snapshot_restore_state = null;
    if (!scopeState.label) scopeState.label = getCurrentPersonaLabel();
    return scopeState;
}


function getKnownCharacterNames(scopeState = {}) {
    const names = new Set();
    const pushName = (value) => {
        const safeName = String(value || '').trim();
        if (!safeName || isCollectiveEntityName(safeName) || isUserPersonaCharacterName(safeName)) return;
        names.add(safeName);
    };

    Object.keys(scopeState?.char_bases || {}).forEach(pushName);
    Object.keys(scopeState?.char_bases_romance || {}).forEach(pushName);
    Object.keys(currentCalculatedStats || {}).forEach(pushName);
    Object.keys(scopeState?.snapshot_baseline?.characters || {}).forEach(pushName);

    return [...names];
}

function ensureRegistryCoverage(scopeState = {}) {
    let changed = false;
    getKnownCharacterNames(scopeState).forEach(name => {
        const hasEntry = getRegistryEntries(scopeState).some(entry => entryOwnsName(entry, name));
        if (hasEntry) return;
        createCharacterRegistryEntry(scopeState, name);
        changed = true;
    });
    return changed;
}

function seedMergeSuggestionsFromRegistry(scopeState = {}) {
    const entries = getRegistryEntries(scopeState);
    if (entries.length < 2) return false;

    let changed = false;
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
            const left = entries[leftIndex];
            const right = entries[rightIndex];
            if (!left?.primary_name || !right?.primary_name) continue;
            const score = scoreCharacterMatch(left.primary_name, right.primary_name);
            if (score < 0.55) continue;

            const leftCreated = parseInt(left.created_at, 10) || 0;
            const rightCreated = parseInt(right.created_at, 10) || 0;
            let source = right;
            let target = left;

            if (rightCreated && leftCreated && rightCreated < leftCreated) {
                source = left;
                target = right;
            } else if (!rightCreated && !leftCreated && String(right.primary_name).localeCompare(String(left.primary_name), 'ru') < 0) {
                source = left;
                target = right;
            }

            const beforeCount = Array.isArray(scopeState.merge_suggestions) ? scopeState.merge_suggestions.length : 0;
            rememberMergeSuggestion(scopeState, source.primary_name, target, score);
            if ((Array.isArray(scopeState.merge_suggestions) ? scopeState.merge_suggestions.length : 0) > beforeCount) {
                changed = true;
            }
        }
    }

    return changed;
}

function ensureActivePersonaState() {
    const resolved = ensureResolvedPersonaScope();
    const scopes = chat_metadata['bb_vn_persona_states'];
    const scopeKey = resolved.scopeKey;
    const scopeState = resolved.scopeState;

    if (!scopeState._legacy_migrated) {
        const isFirstScope = Object.keys(scopes || {}).length === 1;
        if (isFirstScope) {
            if (chat_metadata['bb_vn_char_bases'] && Object.keys(scopeState.char_bases).length === 0) scopeState.char_bases = chat_metadata['bb_vn_char_bases'];
            if (chat_metadata['bb_vn_char_bases_romance'] && Object.keys(scopeState.char_bases_romance).length === 0) scopeState.char_bases_romance = chat_metadata['bb_vn_char_bases_romance'];
            if (Array.isArray(chat_metadata['bb_vn_ignored_chars']) && scopeState.ignored_chars.length === 0) scopeState.ignored_chars = chat_metadata['bb_vn_ignored_chars'];
            if (Array.isArray(chat_metadata['bb_vn_platonic_chars']) && scopeState.platonic_chars.length === 0) scopeState.platonic_chars = chat_metadata['bb_vn_platonic_chars'];
            if (Array.isArray(chat_metadata['bb_vn_global_log']) && scopeState.global_log.length === 0) scopeState.global_log = chat_metadata['bb_vn_global_log'];
            if (chat_metadata['bb_vn_char_registry'] && Object.keys(scopeState.char_registry).length === 0) scopeState.char_registry = chat_metadata['bb_vn_char_registry'];
            if (Array.isArray(chat_metadata['bb_vn_merge_suggestions']) && scopeState.merge_suggestions.length === 0) scopeState.merge_suggestions = chat_metadata['bb_vn_merge_suggestions'];
            const legacyCutoff = parseInt(chat_metadata['bb_vn_log_cutoff_index'], 10);
            if (legacyCutoff > 0 && scopeState.log_cutoff_index === 0) scopeState.log_cutoff_index = legacyCutoff;
        }
        scopeState._legacy_migrated = true;
    }

    return { ...resolved, scopeKey, scopeState };
}

export function bindActivePersonaState() {
    const { scopeKey, scopeState, aliasSet, identity, binding } = ensureActivePersonaState();
    const registryWasExpanded = ensureRegistryCoverage(scopeState);
    const suggestionsWereSeeded = seedMergeSuggestionsFromRegistry(scopeState);
    if (registryWasExpanded || suggestionsWereSeeded) {
        saveChatDebounced();
    }
    chat_metadata['bb_vn_active_persona_scope'] = scopeKey;
    chat_metadata['bb_vn_char_bases'] = scopeState.char_bases;
    chat_metadata['bb_vn_char_bases_romance'] = scopeState.char_bases_romance;
    chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars;
    chat_metadata['bb_vn_platonic_chars'] = scopeState.platonic_chars;
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
    chat_metadata['bb_vn_char_registry'] = scopeState.char_registry;
    chat_metadata['bb_vn_merge_suggestions'] = scopeState.merge_suggestions;
    chat_metadata['bb_vn_log_cutoff_index'] = scopeState.log_cutoff_index || 0;
    return { scopeKey, scopeState, aliasSet, identity, binding };
}

export function exportActivePersonaSnapshot() {
    const { scopeKey, scopeState } = bindActivePersonaState();
    const chat = SillyTavern.getContext().chat || [];
    const characters = {};

    Object.entries(currentCalculatedStats || {}).forEach(([charName, stats]) => {
        if (!charName || !stats || typeof stats !== 'object') return;
        characters[charName] = normalizeImportedCharacterStats(stats);
    });

    return {
        schema_version: 1,
        module: MODULE_NAME,
        exported_at: new Date().toISOString(),
        scope_key: scopeKey,
        persona_label: scopeState.label || getCurrentPersonaLabel(),
        source_chat_length: Array.isArray(chat) ? chat.length : 0,
        data: {
            char_bases: cloneJsonData(scopeState.char_bases, {}),
            char_bases_romance: cloneJsonData(scopeState.char_bases_romance, {}),
            ignored_chars: cloneJsonData(scopeState.ignored_chars, []),
            platonic_chars: cloneJsonData(scopeState.platonic_chars, []),
            char_registry: cloneJsonData(scopeState.char_registry, {}),
            merge_suggestions: cloneJsonData(scopeState.merge_suggestions, []),
            global_log: cloneJsonData(chat_metadata['bb_vn_global_log'], []),
            story_moments: cloneJsonData(currentStoryMoments, []),
            characters,
        },
    };
}

export function importActivePersonaSnapshot(rawSnapshot = '') {
    const parsedSnapshot = typeof rawSnapshot === 'string' ? JSON.parse(String(rawSnapshot || '')) : rawSnapshot;
    const snapshotData = parsedSnapshot?.data && typeof parsedSnapshot.data === 'object' ? parsedSnapshot.data : parsedSnapshot;
    if (!snapshotData || typeof snapshotData !== 'object') throw new Error('INVALID_SNAPSHOT');
    if (!snapshotData.characters || typeof snapshotData.characters !== 'object') throw new Error('INVALID_SNAPSHOT_CHARACTERS');

    const { scopeState } = bindActivePersonaState();
    const chat = SillyTavern.getContext().chat || [];
    const normalizedCharacters = {};
    Object.entries(snapshotData.characters).forEach(([charName, stats]) => {
        const safeName = String(charName || '').trim();
        if (!safeName || isCollectiveEntityName(safeName) || isUserPersonaCharacterName(safeName)) return;
        normalizedCharacters[safeName] = normalizeImportedCharacterStats(stats);
    });

    scopeState.snapshot_restore_state = {
        char_bases: cloneJsonData(scopeState.char_bases, {}),
        char_bases_romance: cloneJsonData(scopeState.char_bases_romance, {}),
        ignored_chars: cloneJsonData(scopeState.ignored_chars, []),
        platonic_chars: cloneJsonData(scopeState.platonic_chars, []),
        char_registry: cloneJsonData(scopeState.char_registry, {}),
        merge_suggestions: cloneJsonData(scopeState.merge_suggestions, []),
        global_log: cloneJsonData(scopeState.global_log, []),
        log_cutoff_index: parseInt(scopeState.log_cutoff_index, 10) || 0,
    };

    scopeState.char_bases = cloneJsonData(snapshotData.char_bases, {});
    scopeState.char_bases_romance = cloneJsonData(snapshotData.char_bases_romance, {});
    scopeState.ignored_chars = cloneJsonData(snapshotData.ignored_chars, []);
    scopeState.platonic_chars = cloneJsonData(snapshotData.platonic_chars, []);
    scopeState.char_registry = cloneJsonData(snapshotData.char_registry, {});
    scopeState.merge_suggestions = cloneJsonData(snapshotData.merge_suggestions, []);
    scopeState.snapshot_baseline = {
        characters: normalizedCharacters,
        global_log: cloneJsonData(snapshotData.global_log, []),
        story_moments: cloneJsonData(snapshotData.story_moments, []),
        char_bases: cloneJsonData(snapshotData.char_bases, {}),
        char_bases_romance: cloneJsonData(snapshotData.char_bases_romance, {}),
    };
    scopeState.snapshot_cutoff_index = Array.isArray(chat) ? chat.length : 0;
    scopeState.log_cutoff_index = Array.isArray(chat) ? chat.length : 0;
    if (parsedSnapshot?.persona_label) scopeState.label = String(parsedSnapshot.persona_label);

    bindActivePersonaState();
    return {
        characters: Object.keys(normalizedCharacters).length,
        cutoffIndex: scopeState.snapshot_cutoff_index,
    };
}

export function clearActivePersonaSnapshot() {
    const { scopeState } = bindActivePersonaState();
    const hadSnapshot = !!scopeState.snapshot_baseline;
    const restoreState = scopeState.snapshot_restore_state && typeof scopeState.snapshot_restore_state === 'object'
        ? scopeState.snapshot_restore_state
        : null;

    if (restoreState) {
        scopeState.char_bases = cloneJsonData(restoreState.char_bases, {});
        scopeState.char_bases_romance = cloneJsonData(restoreState.char_bases_romance, {});
        scopeState.ignored_chars = cloneJsonData(restoreState.ignored_chars, []);
        scopeState.platonic_chars = cloneJsonData(restoreState.platonic_chars, []);
        scopeState.char_registry = cloneJsonData(restoreState.char_registry, {});
        scopeState.merge_suggestions = cloneJsonData(restoreState.merge_suggestions, []);
        scopeState.global_log = cloneJsonData(restoreState.global_log, []);
        scopeState.log_cutoff_index = parseInt(restoreState.log_cutoff_index, 10) || 0;
    }

    scopeState.snapshot_baseline = null;
    scopeState.snapshot_cutoff_index = 0;
    scopeState.snapshot_restore_state = null;
    if (!restoreState) {
        scopeState.log_cutoff_index = 0;
    }
    bindActivePersonaState();
    return hadSnapshot;
}

function saveActivePersonaCutoff() {
    const { scopeState } = ensureActivePersonaState();
    scopeState.log_cutoff_index = parseInt(chat_metadata['bb_vn_log_cutoff_index'], 10) || 0;
}

function getRegistryEntries(scopeState) {
    return Object.values(scopeState?.char_registry || {}).filter(entry => entry && typeof entry === 'object' && entry.id);
}

function entryOwnsName(entry, rawName = '') {
    const normalized = normalizeCharacterLookupName(rawName);
    if (!normalized || !entry) return false;
    const names = [entry.primary_name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    return names.some(name => normalizeCharacterLookupName(name) === normalized);
}

function addAliasToEntry(entry, alias, scopeState) {
    const aliasText = String(alias || '').trim();
    if (!aliasText || !entry) return;
    if (!Array.isArray(entry.aliases)) entry.aliases = [];
    if (!entry.aliases.some(existing => normalizeCharacterLookupName(existing) === normalizeCharacterLookupName(aliasText))) {
        entry.aliases.push(aliasText);
    }
    scopeState.char_registry[entry.id] = entry;
}

function findRegistryEntryByOwnedName(scopeState = {}, rawName = '') {
    const normalized = normalizeCharacterLookupName(rawName);
    if (!normalized) return null;
    return getRegistryEntries(scopeState).find(entry => entryOwnsName(entry, rawName)) || null;
}

function moveNamedMapValue(map = null, fromName = '', toName = '') {
    if (!map || typeof map !== 'object') return false;
    const fromKey = String(fromName || '').trim();
    const toKey = String(toName || '').trim();
    if (!fromKey || !toKey || fromKey === toKey) return false;
    if (!Object.prototype.hasOwnProperty.call(map, fromKey)) return false;

    if (!Object.prototype.hasOwnProperty.call(map, toKey) || map[toKey] === 0 || map[toKey] === undefined) {
        map[toKey] = map[fromKey];
    }
    delete map[fromKey];
    return true;
}

function replaceNameInList(list = [], fromName = '', toName = '') {
    if (!Array.isArray(list)) return [];
    const normalizedFrom = normalizeCharacterLookupName(fromName);
    const normalizedTo = normalizeCharacterLookupName(toName);
    if (!normalizedFrom || !normalizedTo) return list;

    const result = [];
    const seen = new Set();
    list.forEach(item => {
        const nextName = normalizeCharacterLookupName(item) === normalizedFrom ? toName : item;
        const key = normalizeCharacterLookupName(nextName);
        if (!key || seen.has(key)) return;
        seen.add(key);
        result.push(nextName);
    });
    return result;
}

function renameSnapshotCharacterData(snapshotBaseline = null, fromName = '', toName = '') {
    if (!snapshotBaseline || typeof snapshotBaseline !== 'object') return false;
    let changed = false;

    if (snapshotBaseline.characters && typeof snapshotBaseline.characters === 'object') {
        changed = moveNamedMapValue(snapshotBaseline.characters, fromName, toName) || changed;
    }
    if (snapshotBaseline.char_bases && typeof snapshotBaseline.char_bases === 'object') {
        changed = moveNamedMapValue(snapshotBaseline.char_bases, fromName, toName) || changed;
    }
    if (snapshotBaseline.char_bases_romance && typeof snapshotBaseline.char_bases_romance === 'object') {
        changed = moveNamedMapValue(snapshotBaseline.char_bases_romance, fromName, toName) || changed;
    }
    if (Array.isArray(snapshotBaseline.story_moments)) {
        snapshotBaseline.story_moments.forEach(moment => {
            if (!moment || typeof moment !== 'object') return;
            if (normalizeCharacterLookupName(moment.char || '') === normalizeCharacterLookupName(fromName)) {
                moment.char = toName;
                if (typeof moment.text === 'string') {
                    moment.text = moment.text.replace(new RegExp(`^${escapeRegExp(fromName)}:`, 'u'), `${toName}:`);
                }
                changed = true;
            }
        });
    }

    return changed;
}

function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transliterateLatinToCyrillicApprox(value = '') {
    const digraphs = [
        ['shch', 'щ'], ['sch', 'щ'], ['yo', 'ё'], ['jo', 'ё'],
        ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'],
        ['yu', 'ю'], ['ju', 'ю'], ['ya', 'я'], ['ja', 'я'], ['ye', 'е'], ['je', 'е'],
    ];
    const letters = {
        a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
        i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
        q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
        y: 'й', z: 'з',
    };

    return String(value || '').replace(/[a-z]+/gi, segment => {
        let text = segment.toLowerCase();
        digraphs.forEach(([from, to]) => {
            text = text.split(from).join(to);
        });
        return text.replace(/[a-z]/g, letter => letters[letter] || letter);
    });
}

function getCharacterMatchKeys(name = '') {
    const normalized = normalizeCharacterLookupName(name);
    const transliterated = normalizeCharacterLookupName(transliterateLatinToCyrillicApprox(normalized));
    return [...new Set([normalized, transliterated].filter(Boolean))];
}

function scoreNormalizedCharacterMatch(source = '', candidate = '') {
    if (!source || !candidate) return 0;
    if (source === candidate) return 1;
    if (source.includes(candidate) || candidate.includes(source)) {
        const minLen = Math.min(source.length, candidate.length);
        const maxLen = Math.max(source.length, candidate.length);
        const ratio = minLen / maxLen;
        return minLen >= 4 ? Math.max(ratio, 0.72) : ratio;
    }

    const sourceTokens = new Set(source.split(' ').filter(Boolean));
    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    if (sourceTokens.size === 0 || candidateTokens.size === 0) return 0;

    let overlap = 0;
    sourceTokens.forEach(token => {
        if (candidateTokens.has(token)) overlap++;
    });

    const union = new Set([...sourceTokens, ...candidateTokens]).size || 1;
    const jaccard = overlap / union;
    const subsetCoverage = overlap / Math.min(sourceTokens.size, candidateTokens.size);
    const hasMeaningfulSharedToken = [...sourceTokens].some(token => candidateTokens.has(token) && token.length >= 4);
    if (subsetCoverage === 1 && hasMeaningfulSharedToken) return Math.max(jaccard, 0.72);
    return jaccard;
}

function scoreCharacterMatch(sourceName = '', candidateName = '') {
    let bestScore = 0;
    getCharacterMatchKeys(sourceName).forEach(source => {
        getCharacterMatchKeys(candidateName).forEach(candidate => {
            bestScore = Math.max(bestScore, scoreNormalizedCharacterMatch(source, candidate));
        });
    });
    return bestScore;
}

function rememberMergeSuggestion(scopeState, sourceName, targetEntry, score) {
    if (!scopeState || !targetEntry) return;
    if (!Array.isArray(scopeState.merge_suggestions)) scopeState.merge_suggestions = [];

    const normalizedSource = normalizeCharacterLookupName(sourceName);
    const normalizedTarget = normalizeCharacterLookupName(targetEntry.primary_name);
    if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) return;

    const alreadyExists = scopeState.merge_suggestions.some(item =>
        (normalizeCharacterLookupName(item.source || '') === normalizedSource &&
            normalizeCharacterLookupName(item.target || '') === normalizedTarget)
        || (normalizeCharacterLookupName(item.source || '') === normalizedTarget &&
            normalizeCharacterLookupName(item.target || '') === normalizedSource)
    );
    if (alreadyExists) return;

    const suggestion = {
        source: String(sourceName || '').trim(),
        target: targetEntry.primary_name,
        target_id: targetEntry.id,
        score: Number(score || 0),
        at: Date.now(),
    };
    scopeState.merge_suggestions.push(suggestion);
    if (scopeState.merge_suggestions.length > 20) scopeState.merge_suggestions.shift();
    notifyInfo(`Возможный дубль: «${suggestion.source}» похоже на «${suggestion.target}». Проверь объединение.`);
    saveChatDebounced();
    if (typeof window['bbRenderMergeSuggestionsList'] === 'function') {
        window['bbRenderMergeSuggestionsList']();
    }
    if (Number(score || 0) >= 0.85) {
        queueMergeSuggestionPrompt(suggestion);
    }
}

function createCharacterRegistryEntry(scopeState, displayName) {
    const entry = {
        id: `char_${hashString(`${displayName}|${Date.now()}|${Math.random()}`)}`,
        primary_name: String(displayName || '').trim(),
        aliases: [String(displayName || '').trim()],
        created_at: Date.now(),
        description: '',
        avatar: '',
        avatarSource: '',
        avatarCrop: normalizeAvatarCrop(),
    };
    scopeState.char_registry[entry.id] = entry;
    return entry;
}

export function getCharacterProfile(charName = '') {
    const identity = resolveCharacterIdentity(charName, { allowCreate: false, allowSuggestions: false });
    return getCharacterProfileFromEntry(identity?.entry || null);
}

export function updateCharacterProfile(charName = '', updates = {}) {
    const identity = resolveCharacterIdentity(charName, { allowCreate: true, allowSuggestions: false });
    if (!identity?.entry) return getCharacterProfileFromEntry(null);

    const { scopeState } = bindActivePersonaState();
    const profile = applyCharacterProfileToEntry(identity.entry, updates);
    scopeState.char_registry[identity.entry.id] = identity.entry;
    return profile;
}

export function renameCharacterRecord(fromName = '', toName = '') {
    const requestedName = String(toName || '').trim();
    if (!requestedName || isCollectiveEntityName(requestedName) || isUserPersonaCharacterName(requestedName)) {
        return { ok: false, reason: 'invalid_name' };
    }

    const { scopeKey, scopeState, aliasSet } = bindActivePersonaState();
    const source = resolveCharacterIdentity(fromName, { allowCreate: false, allowSuggestions: false });
    if (!source?.entry) {
        return { ok: false, reason: 'source_not_found' };
    }

    const sourceEntry = scopeState.char_registry[source.id];
    if (!sourceEntry) {
        return { ok: false, reason: 'source_not_found' };
    }

    const existingTargetEntry = findRegistryEntryByOwnedName(scopeState, requestedName);
    if (existingTargetEntry && existingTargetEntry.id !== source.id) {
        return {
            ok: false,
            reason: 'target_exists',
            conflict: true,
            targetName: existingTargetEntry.primary_name,
        };
    }

    const previousPrimary = String(sourceEntry.primary_name || fromName || '').trim();
    const previousNames = [previousPrimary, ...(Array.isArray(sourceEntry.aliases) ? sourceEntry.aliases : [])]
        .map(name => String(name || '').trim())
        .filter(Boolean);
    const previousNormalized = normalizeCharacterLookupName(previousPrimary);
    const requestedNormalized = normalizeCharacterLookupName(requestedName);
    if (!requestedNormalized) {
        return { ok: false, reason: 'invalid_name' };
    }

    addAliasToEntry(sourceEntry, previousPrimary, scopeState);
    addAliasToEntry(sourceEntry, requestedName, scopeState);
    sourceEntry.primary_name = requestedName;
    scopeState.char_registry[sourceEntry.id] = sourceEntry;

    let count = previousNormalized !== requestedNormalized ? 1 : 0;
    const shouldRenameStoredName = (value = '') => {
        const normalized = normalizeCharacterLookupName(value);
        return normalized && previousNames.some(name => normalizeCharacterLookupName(name) === normalized);
    };

    const chat = SillyTavern.getContext().chat;
    if (Array.isArray(chat)) {
        chat.forEach(msg => {
            if (msg.extra?.bb_social_swipes) {
                for (const sId in msg.extra.bb_social_swipes) {
                    if (!Array.isArray(msg.extra.bb_social_swipes[sId])) continue;
                    msg.extra.bb_social_swipes[sId].forEach(update => {
                        if (update?.scope && !aliasSet.has(update.scope)) return;
                        if (update?.char_id === source.id || shouldRenameStoredName(update?.name || '')) {
                            if (update.name !== requestedName) {
                                update.name = requestedName;
                                count++;
                            }
                            update.char_id = source.id;
                            update.scope = scopeKey;
                        }
                    });
                }
            }
            if (msg.extra?.bb_vn_char_traits_swipes) {
                for (const sId in msg.extra.bb_vn_char_traits_swipes) {
                    if (!Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) continue;
                    msg.extra.bb_vn_char_traits_swipes[sId].forEach(trait => {
                        if (trait?.scope && !aliasSet.has(trait.scope)) return;
                        if (trait?.char_id === source.id || shouldRenameStoredName(trait?.charName || '')) {
                            if (trait.charName !== requestedName) {
                                trait.charName = requestedName;
                                count++;
                            }
                            trait.char_id = source.id;
                            trait.scope = scopeKey;
                        }
                    });
                }
            }
        });
    }

    previousNames.forEach(oldName => {
        moveNamedMapValue(chat_metadata['bb_vn_char_bases'], oldName, requestedName);
        moveNamedMapValue(chat_metadata['bb_vn_char_bases_romance'], oldName, requestedName);
    });

    if (Array.isArray(chat_metadata['bb_vn_ignored_chars'])) {
        scopeState.ignored_chars = previousNames.reduce(
            (list, oldName) => replaceNameInList(list, oldName, requestedName),
            chat_metadata['bb_vn_ignored_chars'],
        );
        chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars;
    }
    if (Array.isArray(chat_metadata['bb_vn_platonic_chars'])) {
        scopeState.platonic_chars = previousNames.reduce(
            (list, oldName) => replaceNameInList(list, oldName, requestedName),
            chat_metadata['bb_vn_platonic_chars'],
        );
        chat_metadata['bb_vn_platonic_chars'] = scopeState.platonic_chars;
    }

    previousNames.forEach(oldName => {
        renameSnapshotCharacterData(scopeState.snapshot_baseline, oldName, requestedName);
    });
    scopeState.merge_suggestions = (scopeState.merge_suggestions || []).filter(item =>
        item.target_id !== source.id
        && normalizeCharacterLookupName(item.source || '') !== previousNormalized
        && normalizeCharacterLookupName(item.target || '') !== previousNormalized
    );
    chat_metadata['bb_vn_merge_suggestions'] = scopeState.merge_suggestions;

    return {
        ok: true,
        count,
        previousName: previousPrimary,
        primaryName: requestedName,
        id: source.id,
        same: previousNormalized === requestedNormalized,
    };
}

export function resolveCharacterIdentity(rawName = '', options = {}) {
    const {
        allowCreate = true,
        allowSuggestions = true,
    } = options || {};

    const { scopeState } = bindActivePersonaState();
    const displayName = String(rawName || '').trim();
    const normalized = normalizeCharacterLookupName(displayName);
    if (!displayName || !normalized) return null;
    if (isUserPersonaCharacterName(displayName)) return null;

    const entries = getRegistryEntries(scopeState);
    for (const entry of entries) {
        if (entryOwnsName(entry, displayName)) {
            addAliasToEntry(entry, displayName, scopeState);
            return { id: entry.id, primaryName: entry.primary_name, entry, created: false };
        }
    }

    let bestEntry = null;
    let bestScore = 0;
    entries.forEach(entry => {
        const names = [entry.primary_name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
        names.forEach(candidateName => {
            const score = scoreCharacterMatch(displayName, candidateName);
            if (score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        });
    });

    if (bestEntry && bestScore >= 0.82) {
        addAliasToEntry(bestEntry, displayName, scopeState);
        return { id: bestEntry.id, primaryName: bestEntry.primary_name, entry: bestEntry, created: false };
    }

    if (bestEntry && bestScore >= 0.55 && allowSuggestions) {
        rememberMergeSuggestion(scopeState, displayName, bestEntry, bestScore);
    }

    if (!allowCreate) return null;

    const createdEntry = createCharacterRegistryEntry(scopeState, displayName);
    return { id: createdEntry.id, primaryName: createdEntry.primary_name, entry: createdEntry, created: true };
}

export function mergeCharacterRecords(fromName = '', toName = '') {
    const { scopeKey, scopeState, aliasSet } = bindActivePersonaState();
    const source = resolveCharacterIdentity(fromName, { allowCreate: false, allowSuggestions: false });
    const target = resolveCharacterIdentity(toName, { allowCreate: true, allowSuggestions: false });
    if (!source || !target) return { ok: false, count: 0 };
    if (source.id === target.id) return { ok: true, count: 0, same: true, targetName: target.primaryName };

    const sourceEntry = scopeState.char_registry[source.id];
    const targetEntry = scopeState.char_registry[target.id];
    if (!sourceEntry || !targetEntry) return { ok: false, count: 0 };

    const sourceNames = [sourceEntry.primary_name, ...(Array.isArray(sourceEntry.aliases) ? sourceEntry.aliases : [])];
    sourceNames.forEach(name => addAliasToEntry(targetEntry, name, scopeState));
    const sourceProfile = getCharacterProfileFromEntry(sourceEntry);
    const targetProfile = getCharacterProfileFromEntry(targetEntry);
    if (!targetProfile.description && sourceProfile.description) {
        targetEntry.description = sourceProfile.description;
    }
    if (!targetProfile.avatar && sourceProfile.avatar) {
        targetEntry.avatar = sourceProfile.avatar;
        targetEntry.avatarSource = sourceProfile.avatarSource || sourceProfile.avatar;
        targetEntry.avatarCrop = normalizeAvatarCrop(sourceProfile.avatarCrop);
    }

    let count = 0;
    const chat = SillyTavern.getContext().chat;
    if (Array.isArray(chat)) {
        chat.forEach(msg => {
            if (msg.extra?.bb_social_swipes) {
                for (const sId in msg.extra.bb_social_swipes) {
                    if (!Array.isArray(msg.extra.bb_social_swipes[sId])) continue;
                    msg.extra.bb_social_swipes[sId].forEach(update => {
                        if (update?.scope && !aliasSet.has(update.scope)) return;
                        if (update?.char_id === source.id || entryOwnsName(sourceEntry, update?.name || '')) {
                            update.name = targetEntry.primary_name;
                            update.char_id = target.id;
                            update.scope = scopeKey;
                            count++;
                        }
                    });
                }
            }
            if (msg.extra?.bb_vn_char_traits_swipes) {
                for (const sId in msg.extra.bb_vn_char_traits_swipes) {
                    if (!Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) continue;
                    msg.extra.bb_vn_char_traits_swipes[sId].forEach(trait => {
                        if (trait?.scope && !aliasSet.has(trait.scope)) return;
                        if (trait?.char_id === source.id || entryOwnsName(sourceEntry, trait?.charName || '')) {
                            trait.charName = targetEntry.primary_name;
                            trait.char_id = target.id;
                            trait.scope = scopeKey;
                            count++;
                        }
                    });
                }
            }
        });
    }

    const fromPrimary = sourceEntry.primary_name;
    const toPrimary = targetEntry.primary_name;
    const targetBase = chat_metadata['bb_vn_char_bases']?.[toPrimary] ?? 0;
    const sourceBase = chat_metadata['bb_vn_char_bases']?.[fromPrimary] ?? 0;
    if ((targetBase === 0 || targetBase === undefined) && sourceBase !== 0) {
        chat_metadata['bb_vn_char_bases'][toPrimary] = sourceBase;
    }
    delete chat_metadata['bb_vn_char_bases'][fromPrimary];

    const targetRomance = chat_metadata['bb_vn_char_bases_romance']?.[toPrimary] ?? 0;
    const sourceRomance = chat_metadata['bb_vn_char_bases_romance']?.[fromPrimary] ?? 0;
    if ((targetRomance === 0 || targetRomance === undefined) && sourceRomance !== 0) {
        chat_metadata['bb_vn_char_bases_romance'][toPrimary] = sourceRomance;
    }
    if (chat_metadata['bb_vn_char_bases_romance']) delete chat_metadata['bb_vn_char_bases_romance'][fromPrimary];

    if (Array.isArray(chat_metadata['bb_vn_ignored_chars'])) {
        scopeState.ignored_chars = [...new Set(chat_metadata['bb_vn_ignored_chars'].map(name => entryOwnsName(sourceEntry, name) ? toPrimary : name))];
        chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars;
    }
    if (Array.isArray(chat_metadata['bb_vn_platonic_chars'])) {
        scopeState.platonic_chars = [...new Set(chat_metadata['bb_vn_platonic_chars'].map(name => entryOwnsName(sourceEntry, name) ? toPrimary : name))];
        chat_metadata['bb_vn_platonic_chars'] = scopeState.platonic_chars;
    }

    if (scopeState.snapshot_baseline?.characters && typeof scopeState.snapshot_baseline.characters === 'object') {
        const snapshotChars = scopeState.snapshot_baseline.characters;
        if (snapshotChars[fromPrimary]) {
            snapshotChars[toPrimary] = snapshotChars[toPrimary]
                ? mergeImportedCharacterStats(snapshotChars[toPrimary], snapshotChars[fromPrimary])
                : normalizeImportedCharacterStats(snapshotChars[fromPrimary]);
            delete snapshotChars[fromPrimary];
        }
        if (scopeState.snapshot_baseline.char_bases && typeof scopeState.snapshot_baseline.char_bases === 'object') {
            const snapshotTargetBase = scopeState.snapshot_baseline.char_bases[toPrimary] ?? 0;
            const snapshotSourceBase = scopeState.snapshot_baseline.char_bases[fromPrimary] ?? 0;
            if ((snapshotTargetBase === 0 || snapshotTargetBase === undefined) && snapshotSourceBase !== 0) {
                scopeState.snapshot_baseline.char_bases[toPrimary] = snapshotSourceBase;
            }
            delete scopeState.snapshot_baseline.char_bases[fromPrimary];
        }
        if (scopeState.snapshot_baseline.char_bases_romance && typeof scopeState.snapshot_baseline.char_bases_romance === 'object') {
            const snapshotTargetRomance = scopeState.snapshot_baseline.char_bases_romance[toPrimary] ?? 0;
            const snapshotSourceRomance = scopeState.snapshot_baseline.char_bases_romance[fromPrimary] ?? 0;
            if ((snapshotTargetRomance === 0 || snapshotTargetRomance === undefined) && snapshotSourceRomance !== 0) {
                scopeState.snapshot_baseline.char_bases_romance[toPrimary] = snapshotSourceRomance;
            }
            delete scopeState.snapshot_baseline.char_bases_romance[fromPrimary];
        }
    }

    scopeState.merge_suggestions = scopeState.merge_suggestions.filter(item =>
        item.target_id !== source.id &&
        normalizeCharacterLookupName(item.source || '') !== normalizeCharacterLookupName(fromPrimary)
    );
    chat_metadata['bb_vn_merge_suggestions'] = scopeState.merge_suggestions;

    delete scopeState.char_registry[source.id];
    return { ok: true, count, targetName: toPrimary };
}


function stripHiddenSocialDataFromText(text = '') {
    return String(text || '')
        .replace(/<div[^>]*(?:class=["'][^"']*bb-vn-data[^"']*["']|style=["'][^"']*display\s*:\s*none[^"']*["'])[^>]*>[\s\S]*?<\/div>/gi, ' ')
        .replace(/<bb-social-updates\b[^>]*>[\s\S]*?<\/bb-social-updates>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getCanonicalCharacterNameWithoutMutation(rawName = '', scopeState = {}) {
    const displayName = String(rawName || '').trim();
    const normalized = normalizeCharacterLookupName(displayName);
    if (!displayName || !normalized) return '';

    const entries = getRegistryEntries(scopeState);
    for (const entry of entries) {
        if (entryOwnsName(entry, displayName)) {
            return entry.primary_name;
        }
    }

    let bestEntry = null;
    let bestScore = 0;
    entries.forEach(entry => {
        const names = [entry.primary_name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
        names.forEach(candidateName => {
            const score = scoreCharacterMatch(displayName, candidateName);
            if (score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        });
    });

    if (bestEntry && bestScore >= 0.82) {
        return bestEntry.primary_name;
    }

    return displayName;
}

function getKnownCharacterCandidateNames(charName = '', scopeState = {}) {
    const canonical = getCanonicalCharacterNameWithoutMutation(charName, scopeState) || String(charName || '').trim();
    const normalizedCanonical = normalizeCharacterLookupName(canonical);
    const entry = getRegistryEntries(scopeState).find(item => normalizeCharacterLookupName(item?.primary_name || '') === normalizedCanonical);
    const names = entry
        ? [entry.primary_name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
        : [canonical];
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function textContainsCharacterReference(sourceText = '', charName = '', scopeState = {}) {
    const normalizedText = ` ${normalizeCharacterLookupName(stripHiddenSocialDataFromText(sourceText))} `;
    if (!normalizedText.trim()) return false;

    return getKnownCharacterCandidateNames(charName, scopeState).some(candidateName => {
        const candidate = normalizeCharacterLookupName(candidateName);
        if (!candidate) return false;
        if (candidate.length < 3) return false;
        return normalizedText.includes(` ${candidate} `);
    });
}

function getTrackedCharacterRoster(scopeState = {}) {
    const roster = new Set();
    const pushName = (value) => {
        const safeName = String(value || '').trim();
        if (!safeName || isCollectiveEntityName(safeName) || isUserPersonaCharacterName(safeName)) return;
        roster.add(safeName);
    };

    Object.keys(currentCalculatedStats || {}).forEach(pushName);
    Object.keys(chat_metadata['bb_vn_char_bases'] || {}).forEach(pushName);
    Object.keys(chat_metadata['bb_vn_char_bases_romance'] || {}).forEach(pushName);
    getKnownCharacterNames(scopeState).forEach(pushName);

    return [...roster];
}

function collectRecentSceneCharacterScores(chat = [], uptoIndex = -1, scopeState = {}, aliasSet = new Set()) {
    const scores = new Map();
    const roster = getTrackedCharacterRoster(scopeState);
    const bumpScore = (rawName = '', amount = 1) => {
        const canonical = getCanonicalCharacterNameWithoutMutation(rawName, scopeState) || String(rawName || '').trim();
        if (!canonical || isCollectiveEntityName(canonical) || isUserPersonaCharacterName(canonical)) return;
        scores.set(canonical, (scores.get(canonical) || 0) + amount);
    };

    if (!Array.isArray(chat) || chat.length === 0 || uptoIndex < 0) {
        return scores;
    }

    const startIndex = Math.max(0, uptoIndex - 8);
    for (let idx = startIndex; idx <= uptoIndex; idx++) {
        const msg = chat[idx];
        if (!msg) continue;
        const isCurrent = idx === uptoIndex;
        const text = stripHiddenSocialDataFromText(msg.mes || '');
        if (text) {
            roster.forEach(charName => {
                if (textContainsCharacterReference(text, charName, scopeState)) {
                    bumpScore(charName, isCurrent ? 4 : 2);
                }
            });
        }

        const swipeId = msg.swipe_id || 0;
        const allowLegacyFallback = !Array.isArray(msg?.swipes) || msg.swipes.length <= 1;
        const msgUpdates = getStoredSwipeEntries(msg.extra?.bb_social_swipes, swipeId, allowLegacyFallback);
        if (Array.isArray(msgUpdates)) {
            msgUpdates.forEach(update => {
                if (update?.scope && !aliasSet.has(update.scope)) return;
                bumpScore(update?.name || '', isCurrent ? 3 : 1);
            });
        }

        const msgTraits = msg.extra?.bb_vn_char_traits_swipes?.[swipeId];
        if (Array.isArray(msgTraits)) {
            msgTraits.forEach(trait => {
                if (trait?.scope && !aliasSet.has(trait.scope)) return;
                bumpScore(trait?.charName || '', isCurrent ? 2 : 1);
            });
        }
    }

    return scores;
}

function getPromptRelevantCharacters(scopeState = {}, aliasSet = new Set()) {
    const trackedCharacters = Object.keys(currentCalculatedStats || {}).filter(name => name && !isCollectiveEntityName(name) && !isUserPersonaCharacterName(name));
    if (trackedCharacters.length <= 6) return trackedCharacters;

    const chat = SillyTavern.getContext().chat || [];
    const scores = collectRecentSceneCharacterScores(chat, chat.length - 1, scopeState, aliasSet);
    const ranked = trackedCharacters
        .map(name => ({
            name,
            score: scores.get(getCanonicalCharacterNameWithoutMutation(name, scopeState) || name) || 0,
        }))
        .sort((left, right) => (right.score - left.score) || left.name.localeCompare(right.name, 'ru'));

    const relevant = ranked.filter(item => item.score > 0).slice(0, 8).map(item => item.name);
    if (relevant.length > 0) return relevant;
    return trackedCharacters.slice(0, 8);
}

function isKnownTrackedCharacterName(rawName = '', scopeState = {}) {
    const canonical = getCanonicalCharacterNameWithoutMutation(rawName, scopeState);
    if (!canonical) return false;
    const normalizedCanonical = normalizeCharacterLookupName(canonical);
    if (!normalizedCanonical) return false;

    const hasCurrentStats = Object.keys(currentCalculatedStats || {}).some(name => normalizeCharacterLookupName(name) === normalizedCanonical);
    const hasBase = Object.keys(chat_metadata['bb_vn_char_bases'] || {}).some(name => normalizeCharacterLookupName(name) === normalizedCanonical);
    const hasRomanceBase = Object.keys(chat_metadata['bb_vn_char_bases_romance'] || {}).some(name => normalizeCharacterLookupName(name) === normalizedCanonical);
    const hasRegistry = getKnownCharacterNames(scopeState).some(name => normalizeCharacterLookupName(name) === normalizedCanonical);

    return hasCurrentStats || hasBase || hasRomanceBase || hasRegistry;
}

function filterStaleSceneUpdates(activeUpdates = [], msg = null, idx = -1, chat = [], scopeState = {}, aliasSet = new Set()) {
    if (!Array.isArray(activeUpdates) || activeUpdates.length < 2 || idx < 0) {
        return { updates: activeUpdates, changed: false, dropped: [] };
    }

    const currentText = stripHiddenSocialDataFromText(msg?.mes || '');
    const sceneScores = collectRecentSceneCharacterScores(chat, idx, scopeState, aliasSet);
    const meta = activeUpdates.map(update => {
        const rawName = String(update?.name || '').trim();
        const canonical = getCanonicalCharacterNameWithoutMutation(rawName, scopeState) || rawName;
        const manualStatus = isManualStatusOverrideUpdate(update);
        const debugInjected = isDebugInjectedUpdate(update);
        const known = isKnownTrackedCharacterName(rawName, scopeState);
        const directMention = rawName ? textContainsCharacterReference(currentText, rawName, scopeState) : false;
        const evidence = sceneScores.get(canonical) || 0;
        return { update, rawName, canonical, manualStatus, debugInjected, known, directMention, evidence };
    });

    const hasPotentialNewCharacter = meta.some(item => item.rawName && !item.known);
    const hasAnchoredKnownCharacter = meta.some(item => item.known && (item.directMention || item.evidence > 0));
    if (!hasPotentialNewCharacter && !hasAnchoredKnownCharacter) {
        return { updates: activeUpdates, changed: false, dropped: [] };
    }

    const dropped = [];
    const filtered = meta.filter(item => {
        if (item.manualStatus || item.debugInjected) return true;
        if (!item.known) return true;
        if (item.directMention || item.evidence > 0) return true;
        dropped.push(item);
        return false;
    });

    if (filtered.length === 0 || filtered.length === activeUpdates.length) {
        return { updates: activeUpdates, changed: false, dropped: [] };
    }

    return {
        updates: filtered.map(item => item.update),
        changed: true,
        dropped,
    };
}

export function getCombinedSocial() {
    const { scopeState, aliasSet } = bindActivePersonaState();
    let combinedStr = SOCIAL_PROMPT;
    const characters = getPromptRelevantCharacters(scopeState, aliasSet);
    
    if (characters.length > 0) {
        combinedStr += `\n\n[CURRENT RELATIONSHIP STATUS]:\n`;
        const impactInstructions = [];

        characters.forEach(char => {
            const stats = currentCalculatedStats[char];
            const tier = getTierInfo(stats.affinity).label;
            const status = stats.status || getUnforgettableRoleStatus(stats.memories?.deep) || tier;
            const profile = getCharacterProfile(char);
            
            const recent = (stats.memories?.soft || []).map(m => m.text).join('; ');
            const deepMemories = stats.memories?.deep || [];
            const recentDeep = deepMemories.slice(-5); 
            const unforgettable = recentDeep.map(m => m.text).join('; ');
            const coreTraits = stats.core_traits || []; 
            const traitsText = coreTraits.length > 0 ? coreTraits.map(t => t.trait).join(' ') : '';

            combinedStr += `- ${char}: [Status: ${status}] [Trust: ${stats.affinity}] [Romance: ${stats.romance || 0}]`;
            if (profile.description) combinedStr += ` [Profile: ${profile.description}]`;
            if (recent) combinedStr += ` [Recent: ${recent}]`;
            if (unforgettable) combinedStr += ` [Unforgettable: ${unforgettable}]`; 
            if (traitsText) combinedStr += ` [CORE TRAITS: ${traitsText}]`; 
            
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
            if (profile.description) {
                guideLines.push(`- Supplemental Profile: ${profile.description}`);
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
        combinedStr += `3. Profile Notes: If a character has a Profile note, treat it as active supporting canon for this scene.\n`;
        combinedStr += `4. Name Consistency: For already tracked characters, prefer these canonical names when they are actually relevant to the current scene: ${characters.join(', ')}.\n`;
        combinedStr += `5. New Character Rule: If a genuinely new person appears in this specific turn and they are not one of the tracked names above, you MAY add a new character instead of forcing them into an old identity.`;

        if (impactInstructions.length > 0) {
            combinedStr += `\n\n[UNFORGETTABLE IMPACT LOGIC]:\n${impactInstructions.join('\n')}\n`;
            combinedStr += `\nCRITICAL: Unforgettable memory directives override temporary scene moods.`;
        }
    }

    combinedStr += buildChoiceContextPrompt();
    return combinedStr;
}

export function injectCombinedSocialPrompt() {
    try {
        bindActivePersonaState();
        const useMacroMode = extension_settings[MODULE_NAME]?.useMacro === true;
        const promptText = useMacroMode ? '' : getCombinedSocial();
        setExtensionPrompt('bb_social_injector', promptText, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    } catch (e) { console.error("[BB VN] Ошибка инъекции:", e); }
}

export function getTierInfo(affinity) {
    if (affinity <= -50) return { label: 'Враг', class: 'tier-enemy', color: '#ef4444' };
    if (affinity < -10) return { label: 'Неприязнь', class: 'tier-enemy', color: '#f87171' };
    if (affinity <= 10) return { label: 'Незнакомец', class: 'tier-neutral', color: '#a1a1aa' };
    if (affinity <= 50) return { label: 'Приятель', class: 'tier-friend', color: '#4ade80' };
    if (affinity <= 80) return { label: 'Друг', class: 'tier-friend', color: '#22c55e' };
    return { label: 'Близкий', class: 'tier-close', color: '#c084fc' };
}

export function getUnforgettableImpact(memories = []) {
    if (!Array.isArray(memories) || memories.length === 0) {
        return { label: 'Нет активного следа', prompt: '' };
    }

    const total = memories.reduce((sum, memory) => sum + (parseInt(memory.delta) || 0), 0);
    const hasPositive = memories.some(memory => (parseInt(memory.delta) || 0) > 0);
    const hasNegative = memories.some(memory => (parseInt(memory.delta) || 0) < 0);

    let label = '';
    let prompt = '';

    if (hasPositive && hasNegative) {
        label = 'Противоречивая связь';
        prompt = 'Past unforgettable events create inner conflict: the character is torn between closeness and pain, so reactions should feel emotionally unstable and layered.';
    } 
    else if (total >= 18) {
        label = 'Глубокая привязанность';
        prompt = 'Unforgettable positive events create a powerful pull toward {{user}}. Even in tense scenes, warmth, trust, or longing should leak through.';
    } 
    else if (total > 0) {
        label = 'Тёплый осадок';
        prompt = 'Unforgettable positive events still shape the character. Small gestures from {{user}} should be interpreted more softly and personally.';
    } 
    else if (total <= -18) {
        label = 'Непростительная обида';
        prompt = 'Unforgettable negative events still dominate the character’s perception. Suspicion, pain, or guardedness should override calm surface behavior.';
    } 
    else {
        label = 'Тяжёлое воспоминание';
        prompt = 'Unforgettable negative events remain unresolved. Even neutral interactions should carry some hesitation, distance, or emotional recoil.';
    }

    return { label, prompt };
}

export function getUnforgettableRoleStatus(memories = []) {
    void memories;
    return '';
}

function getAffinityTierKey(affinity = 0) {
    if (affinity <= -50) return 'enemy';
    if (affinity < -10) return 'hostile';
    if (affinity <= 10) return 'neutral';
    if (affinity <= 50) return 'friendly';
    if (affinity <= 80) return 'friend';
    return 'close';
}

function resolveStableRelationshipStatus(candidateStatus = '', previousStatus = '', previousAffinity = 0, nextAffinity = 0, options = {}) {
    const incoming = sanitizeRelationshipStatus(candidateStatus);
    const previous = sanitizeRelationshipStatus(previousStatus);
    const allowOverride = options?.allowOverride === true;
    if (allowOverride) return incoming || previous || '';

    const hasIncoming = isValidUserFacingStatus(incoming);
    const hasPrevious = isValidUserFacingStatus(previous);

    if (!hasIncoming) return hasPrevious ? previous : '';
    if (!hasPrevious) return incoming;

    const previousTierKey = getAffinityTierKey(previousAffinity);
    const nextTierKey = getAffinityTierKey(nextAffinity);
    if (previousTierKey !== nextTierKey) return incoming;

    return previous;
}

function isDebugInjectedUpdate(update = {}) {
    return update?.debug_event === true || update?.debug_injected === true;
}

function isManualStatusOverrideUpdate(update = {}, currentEmotion = '') {
    const reason = String(update?.reason || '').trim().toLowerCase();
    const emotion = String(currentEmotion || update?.emotion || update?.moodlet || '').trim().toLowerCase();
    return update?.manual_status === true
        || update?.status_override === true
        || reason === 'ручная смена статуса'
        || emotion === 'дебаг';
}

function hasAmbivalentRomanceConflictMarkers(reason = '', emotion = '', status = '') {
    const text = `${String(reason || '')} ${String(emotion || '')} ${String(status || '')}`.toLowerCase();
    if (!text.trim()) return false;

    const explicitConflictRegex = /(опасн\w*\s+влеч|болезнен\w*\s+(?:тяга|влеч)|тянет\s+вопреки|страх\s*(?:,|и)\s*желан|страх\s*(?:,|и)\s*влеч|ненавист\w*\s*(?:,|и)\s*желан|противореч\w*\s+влеч|запрет\w*\s+влеч|одержим\w*\s+влеч|токсич\w*\s+влеч|dark attraction|dangerous fascination|fear and desire|drawn despite harm)/i;
    if (explicitConflictRegex.test(text)) return true;

    const conflictMarkerRegex = /(опас|страх|пуга|угроз|стыд|вина|болезн|больно|ран|жесток|груб|насил|принуж|манипул|одерж|токс|ревност|агресс|ненавист|конфликт|противореч|амбив|запрет|темн|шок)/i;
    const attractionMarkerRegex = /(влеч|тянет|манит|желан|страст|притяг|симпат|интерес|романт|люб|химия|возбуж|искуш|близост)/i;
    return conflictMarkerRegex.test(text) && attractionMarkerRegex.test(text);
}

function normalizeMixedAffinityRomanceDeltas(friendshipDelta = 0, romanceDelta = 0, reason = '', emotion = '', status = '') {
    if (!(friendshipDelta < 0 && romanceDelta > 0)) {
        return { friendshipDelta, romanceDelta, preservedConflict: false };
    }

    const preservedConflict = hasAmbivalentRomanceConflictMarkers(reason, emotion, status);
    if (preservedConflict) {
        return { friendshipDelta, romanceDelta, preservedConflict: true };
    }

    return {
        friendshipDelta: 0,
        romanceDelta,
        preservedConflict: false,
    };
}

function getDominantImpactEntry(friendshipDelta = 0, romanceDelta = 0) {
    const impacts = [];
    if (friendshipDelta !== 0) impacts.push({ delta: friendshipDelta, kind: 'friendship' });
    if (romanceDelta !== 0) impacts.push({ delta: romanceDelta, kind: 'romance' });
    if (impacts.length === 0) return null;
    if (impacts.length === 1) return impacts[0];
    return Math.abs(romanceDelta) > Math.abs(friendshipDelta)
        ? impacts.find(entry => entry.kind === 'romance') || impacts[0]
        : impacts.find(entry => entry.kind === 'friendship') || impacts[0];
}

function getRecordedImpactEntries(friendshipDelta = 0, romanceDelta = 0) {
    const impacts = [];
    if (friendshipDelta !== 0) impacts.push({ delta: friendshipDelta, kind: 'friendship' });
    if (romanceDelta !== 0) impacts.push({ delta: romanceDelta, kind: 'romance' });
    if (impacts.length <= 1) return impacts;

    const signs = new Set(impacts.map(entry => Math.sign(entry.delta)).filter(sign => sign !== 0));
    if (signs.size <= 1) {
        const dominant = getDominantImpactEntry(friendshipDelta, romanceDelta);
        return dominant ? [dominant] : [];
    }

    const selectedBySign = new Map();
    impacts.forEach(entry => {
        const sign = Math.sign(entry.delta);
        const current = selectedBySign.get(sign);
        if (!current || Math.abs(entry.delta) > Math.abs(current.delta)) {
            selectedBySign.set(sign, entry);
        }
    });

    return impacts.filter(entry => selectedBySign.get(Math.sign(entry.delta)) === entry);
}

export function appendCharacterMemory(charStats, delta, reason, moodlet = '', options = {}) {
    if (!charStats || !reason || delta === 0) return;
    const bucket = getMemoryBucket(delta);
    if (!bucket) return;
    if (!charStats.memories || !Array.isArray(charStats.memories[bucket])) return;
    const memory = {
        text: reason,
        delta,
        tone: getMemoryTone(delta),
        moodlet: sanitizeMoodlet(moodlet),
    };
    const memoryKey = buildMemoryEntryDedupKey(memory);
    const hasDuplicate = !options?.allowDuplicate && charStats.memories[bucket].some(entry => buildMemoryEntryDedupKey(entry) === memoryKey);
    if (memoryKey && hasDuplicate) return;

    charStats.memories[bucket].push(memory);
    
    if (bucket === 'soft' && charStats.memories.soft.length > 4) {
        charStats.memories.soft.shift();
    }
}

export function maybeAddStoryMoment(moment) {
    if (!moment || !moment.title || !moment.text) return;
    currentStoryMoments.push(moment);
    if (currentStoryMoments.length > 30) currentStoryMoments.shift();
    return moment;
}

export function addGlobalLog(type, text, timeString) {
    if (!chat_metadata['bb_vn_global_log']) chat_metadata['bb_vn_global_log'] = [];
    const time = timeString || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    chat_metadata['bb_vn_global_log'].push({ time, type, text });
    if (chat_metadata['bb_vn_global_log'].length > 100) chat_metadata['bb_vn_global_log'].shift();
}

function getJournalCutoffIndex(chat = []) {
    const rawValue = parseInt(chat_metadata['bb_vn_log_cutoff_index'], 10);
    if (Number.isNaN(rawValue) || rawValue <= 0) return 0;
    return Math.min(rawValue, Array.isArray(chat) ? chat.length : rawValue);
}

function getStoredSwipeEntries(swipesMap, swipeId, allowLegacyFallback = false) {
    if (!swipesMap || typeof swipesMap !== 'object') return null;
    const exact = swipesMap[swipeId];
    if (Array.isArray(exact)) return exact;
    if (!allowLegacyFallback) return null;

    for (const key in swipesMap) {
        if (Array.isArray(swipesMap[key]) && swipesMap[key].length > 0) {
            return swipesMap[key];
        }
    }

    return null;
}

function decodeHtmlEntities(text = '') {
    return String(text || '')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&');
}

export function tryParseSocialUpdates(rawText) {
    const text = String(rawText || '');
    const decodedText = decodeHtmlEntities(text);
    const normalizeImpactField = (value) => {
        const normalized = String(value || '').trim();
        return normalized || 'none';
    };
    const readUpdatesFromBlock = (block, tagName = 'bb-social-update') => {
        const escapedTagName = String(tagName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!escapedTagName) return [];
        const updateMatches = [...block.matchAll(new RegExp(`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTagName}>`, 'gi'))];
        const updates = updateMatches.map(match => {
            const item = match[1] || '';
            const readTag = (tag) => {
                const found = item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
                return found ? String(found[1]).replace(/<[^>]+>/g, '').trim() : '';
            };
            return {
                name: readTag('name'),
                friendship_impact: normalizeImpactField(readTag('friendship_impact')),
                romance_impact: normalizeImpactField(readTag('romance_impact')),
                role_dynamic: readTag('user_label') || readTag('role_dynamic') || readTag('relationship_label'),
                reason: readTag('reason'),
                emotion: readTag('emotion'),
            };
        }).filter(u => u.name && (u.friendship_impact || u.romance_impact));

        return updates;
    };
    const readCharacterUpdatesFromBlock = (block) => readUpdatesFromBlock(block, 'character');

    const parseFromSource = (sourceText, preferOriginalSource = '') => {
        const directBlockMatches = [...sourceText.matchAll(/<bb-social-updates\b[^>]*>[\s\S]*?<\/bb-social-updates>/gi)];
        for (const match of directBlockMatches) {
            const block = match[0];
            const updates = readUpdatesFromBlock(block);
            if (updates.length > 0) {
                return {
                    parsed: { social_updates: updates },
                    source: preferOriginalSource || block,
                };
            }
        }

        const hiddenHtmlMatch = sourceText.match(/<div[^>]*(?:class=["'][^"']*bb-vn-data[^"']*["']|style=["'][^"']*display\s*:\s*none[^"']*["'])[^>]*>[\s\S]*?<\/div>/i);
        if (hiddenHtmlMatch) {
            const hiddenHtml = hiddenHtmlMatch[0];
            const updatesBlockMatch = hiddenHtml.match(/<bb-social-updates\b[^>]*>[\s\S]*?<\/bb-social-updates>/i);
            if (updatesBlockMatch) {
                const block = updatesBlockMatch[0];
                const updates = readUpdatesFromBlock(block);

                if (updates.length > 0) {
                    return {
                        parsed: { social_updates: updates },
                        source: preferOriginalSource || updatesBlockMatch[0],
                    };
                }
            }

            const characterUpdates = readCharacterUpdatesFromBlock(hiddenHtml);
            if (characterUpdates.length > 0) {
                return {
                    parsed: { social_updates: characterUpdates },
                    source: preferOriginalSource || hiddenHtml,
                };
            }
        }

        const bareUpdates = readUpdatesFromBlock(sourceText);
        if (bareUpdates.length > 0) {
            const sourceMatch = sourceText.match(/(?:<bb-social-update\b[^>]*>[\s\S]*?<\/bb-social-update>\s*)+/i);
            return {
                parsed: { social_updates: bareUpdates },
                source: preferOriginalSource || (sourceMatch ? sourceMatch[0] : ''),
            };
        }

        return null;
    }

    return parseFromSource(text) || parseFromSource(decodedText);
}

export function scanAndCleanMessage(msg, messageId, trackDebug = false) {
    const { scopeKey } = bindActivePersonaState();
    if (!msg || msg.is_user) return false;
    let modified = false;
    const swipeId = msg.swipe_id || 0;
    const allowLegacyFallback = !Array.isArray(msg.swipes) || msg.swipes.length <= 1;
    const existingUpdates = getStoredSwipeEntries(msg.extra?.bb_social_swipes, swipeId, allowLegacyFallback);
    
    const originalMes = msg.mes;
    let currentMes = String(msg.mes || '').replace(/[\u200B-\u200D\uFEFF]/g, '');

    if (trackDebug) {
        setSocialParseDebug('checking', 'Проверка текущего ответа');
    }

    const parsedPayload = tryParseSocialUpdates(currentMes);

    if (parsedPayload) {
        try {
            const parsed = parsedPayload.parsed;
            const userFilteredUpdates = filterUserPersonaSocialUpdates(parsed.social_updates);
            const dedupedParsedUpdates = dedupeSocialUpdateEntries(userFilteredUpdates.updates);
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.bb_social_swipes) msg.extra.bb_social_swipes = {};

            msg.extra.bb_social_swipes[swipeId] = dedupedParsedUpdates.updates.map(update => ({
                ...update,
                scope: update.scope || scopeKey,
            }));
            if (dedupedParsedUpdates.changed || userFilteredUpdates.changed) modified = true;
            currentMes = currentMes.replace(parsedPayload.source, '');
            if (trackDebug) {
                const droppedSuffix = userFilteredUpdates.dropped.length > 0
                    ? `, self dropped: ${userFilteredUpdates.dropped.length}`
                    : '';
                setSocialParseDebug('parsed', `social_updates: ${dedupedParsedUpdates.updates.length}${droppedSuffix}`);
            }
        } catch(e) {}
    } else if (Array.isArray(existingUpdates) && existingUpdates.length > 0) {
        if (trackDebug) setSocialParseDebug('stored', `social_updates (saved): ${existingUpdates.length}`);
    } else if (trackDebug) {
        if (/(bb-social-update|bb-social-updates|bb-vn-data|&lt;bb-social-update|&lt;bb-social-updates)/i.test(currentMes)) {
            setSocialParseDebug('error', 'HTML-подобный блок найден, но не удалось распарсить');
        } else if (String(currentMes || '').trim()) {
            setSocialParseDebug('missing', 'В текущем ответе нет social_updates');
        } else {
            setSocialParseDebug('missing', 'Текущий ответ пуст или social_updates отсутствуют');
        }
    }
    
    currentMes = currentMes
        .replace(/<div[^>]*>\s*<\/div>/gi, '')
        .replace(/\n{3,}/g, '\n\n');
    
    if (originalMes !== currentMes) {
        msg.mes = currentMes.trim(); 
        modified = true;

        const hasSwipeArray = Array.isArray(msg.swipes);
        const hasExactSwipeSlot = hasSwipeArray && msg.swipes[swipeId] !== undefined;
        const canCreateInitialSwipe = swipeId === 0 && (!hasSwipeArray || msg.swipes.length === 0);

        // During a fresh swipe SillyTavern can update msg.mes before it adds the new
        // slot into msg.swipes. Falling back to swipes[0] here overwrites another
        // variant and makes different swipes collapse into identical text.
        if (hasExactSwipeSlot) {
            msg.swipes[swipeId] = msg.mes; 
        } else if (canCreateInitialSwipe) {
            msg.swipes = [msg.mes]; 
        }
    }
    
    if (modified && messageId !== undefined) {
        const msgElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (msgElement) msgElement.innerHTML = SillyTavern.getContext().markdownToHtml(msg.mes);
    }
    
    return modified;
}

let renderHudCallback = () => {};
export function setRenderHudCallback(cb) { renderHudCallback = cb; }

export async function handleNewCharacterInterviews(chars) {
    bindActivePersonaState();
    let madeChanges = false;
    const userName = SillyTavern.getContext().substituteParams('{{user}}');

    for (const charName of chars.filter(name => !isUserPersonaCharacterName(name))) {
        const result = await callPopup(`<h3>Новая связь: ${escapeHtml(charName)}</h3><p>Этот персонаж впервые появился в трекере.<br>Задайте базовое отношение к <strong>${escapeHtml(userName)}</strong> (от -100 до 100).<br><br><span style="font-size:12px; color:#94a3b8;">0 — незнакомец, 50 — друг, -50 — враг.</span></p>`, 'input', '0');
        
        if (result !== undefined && result !== null && result !== false) {
            const parsed = parseInt(String(result).trim(), 10);
            if (!isNaN(parsed)) {
                chat_metadata['bb_vn_char_bases'][charName] = parsed;
                madeChanges = true;
            }
        }
    }
    
    if (madeChanges) {
        saveChatDebounced();
        recalculateAllStats();
    }
}

export function recalculateAllStats(isNewMessage = false) {
    const { scopeKey, scopeState, aliasSet } = bindActivePersonaState();
    const newStats = {};
    const liveToastCandidates = [];
    const recentRelationshipUpdateIndexes = new Map();
    const recentRelationshipUpdates = [];
    let needsSave = purgeUserPersonaTracking(scopeState);
    setCurrentCalculatedStats(newStats);
    currentStoryMoments.length = 0;
    const snapshotBaseline = scopeState.snapshot_baseline && typeof scopeState.snapshot_baseline === 'object'
        ? scopeState.snapshot_baseline
        : null;
    scopeState.global_log = cloneJsonData(snapshotBaseline?.global_log, []);
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
    const baselineStoryMoments = Array.isArray(snapshotBaseline?.story_moments)
        ? cloneJsonData(snapshotBaseline.story_moments, []).slice(-30)
        : [];
    baselineStoryMoments
        .filter(moment => !isUserPersonaCharacterName(moment?.char || ''))
        .forEach(moment => currentStoryMoments.push(moment));
    const baselineCharacters = snapshotBaseline?.characters && typeof snapshotBaseline.characters === 'object'
        ? snapshotBaseline.characters
        : {};
    const baselineBaseMap = snapshotBaseline?.char_bases && typeof snapshotBaseline.char_bases === 'object'
        ? snapshotBaseline.char_bases
        : {};
    const baselineRomanceBaseMap = snapshotBaseline?.char_bases_romance && typeof snapshotBaseline.char_bases_romance === 'object'
        ? snapshotBaseline.char_bases_romance
        : {};
    Object.entries(baselineCharacters).forEach(([charName, stats]) => {
        const safeName = String(charName || '').trim();
        if (!safeName || isCollectiveEntityName(safeName) || isUserPersonaCharacterName(safeName)) return;
        if (Array.isArray(chat_metadata['bb_vn_ignored_chars']) && chat_metadata['bb_vn_ignored_chars'].includes(safeName)) return;

        const normalizedStats = normalizeImportedCharacterStats(stats);
        const currentBase = parseInt(chat_metadata['bb_vn_char_bases']?.[safeName], 10);
        const importedBase = parseInt(baselineBaseMap?.[safeName], 10);
        const currentRomanceBase = parseInt(chat_metadata['bb_vn_char_bases_romance']?.[safeName], 10);
        const importedRomanceBase = parseInt(baselineRomanceBaseMap?.[safeName], 10);
        const affinityOffset = (Number.isNaN(currentBase) ? 0 : currentBase) - (Number.isNaN(importedBase) ? 0 : importedBase);
        const romanceOffset = (Number.isNaN(currentRomanceBase) ? 0 : currentRomanceBase) - (Number.isNaN(importedRomanceBase) ? 0 : importedRomanceBase);

        normalizedStats.affinity = clampRelationshipValue((normalizedStats.affinity || 0) + affinityOffset);
        normalizedStats.romance = clampRelationshipValue((normalizedStats.romance || 0) + romanceOffset);
        newStats[safeName] = normalizedStats;
    });
    const chat = SillyTavern.getContext().chat;
    let latestChoiceContext = null;
    const newlyDiscoveredChars = [];
    
    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
    if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];
    setSocialParseDebug('idle', 'Ожидание ответа модели');
    const lastAssistantIndex = Array.isArray(chat)
        ? [...chat].map((msg, idx) => ({ msg, idx })).reverse().find(item => item.msg && !item.msg.is_user)?.idx ?? -1
        : -1;

    if (chat && chat.length > 0 && chat_metadata['bb_vn_char_traits'] && Object.keys(chat_metadata['bb_vn_char_traits']).length > 0) {
        const lastMsg = chat[chat.length - 1];
        const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        
        for (const cName in chat_metadata['bb_vn_char_traits']) {
            chat_metadata['bb_vn_char_traits'][cName].forEach(t => {
                lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName: cName, trait: t.trait, type: t.type, scope: scopeKey });
            });
        }
        delete chat_metadata['bb_vn_char_traits'];
        needsSave = true;
    }

    if (!chat || !chat.length) {
        renderHudCallback();
        injectCombinedSocialPrompt();
        return;
    }

    const journalCutoffIndex = getJournalCutoffIndex(chat);
    const statsCutoffIndex = Math.min(parseInt(scopeState.snapshot_cutoff_index, 10) || 0, chat.length);

    chat.forEach((msg, idx) => {
        if (idx < statsCutoffIndex) return;
        const shouldRecordJournal = idx >= journalCutoffIndex;
        if (msg?.is_user && chat_metadata['bb_vn_pending_choice_context']) {
            if (tryBindPendingChoiceContextToMessage(msg)) needsSave = true;
        }
        if (msg?.is_user && msg.extra?.bb_vn_choice_context) {
            latestChoiceContext = msg.extra.bb_vn_choice_context;
        }

        if (scanAndCleanMessage(msg, idx, idx === lastAssistantIndex)) needsSave = true;

        const swipeId = msg.swipe_id || 0;
        const allowLegacyFallback = !Array.isArray(msg?.swipes) || msg.swipes.length <= 1;

        const msgTraits = msg.extra?.bb_vn_char_traits_swipes?.[swipeId];
        if (msgTraits && Array.isArray(msgTraits)) {
            const filteredTraits = msgTraits.filter(trait => !isUserPersonaCharacterName(trait?.charName || ''));
            if (filteredTraits.length !== msgTraits.length) {
                msgTraits.splice(0, msgTraits.length, ...filteredTraits);
                needsSave = true;
            }

            msgTraits.forEach(t => {
                if (t.scope && !aliasSet.has(t.scope)) return;
                if (!t.scope || t.scope !== scopeKey) {
                    t.scope = scopeKey;
                    needsSave = true;
                }

                const resolvedTraitIdentity = resolveCharacterIdentity(t.charName || '', { allowCreate: true });
                const cName = resolvedTraitIdentity?.primaryName || t.charName;
                if (resolvedTraitIdentity?.id && t.char_id !== resolvedTraitIdentity.id) {
                    t.char_id = resolvedTraitIdentity.id;
                    needsSave = true;
                }
                if (cName && t.charName !== cName) {
                    t.charName = cName;
                    needsSave = true;
                }
                if (!cName || chat_metadata['bb_vn_ignored_chars'].includes(cName)) return;

                if (t.trait) {
                    const before = String(t.trait);
                    t.trait = normalizeTraitResponse(t.trait);
                    if (t.trait !== before) {
                        needsSave = true;
                    }
                }

                if (!t.trait || t.trait.length > 240 || isLikelyModelRefusalText(t.trait) || !t.trait.includes(':')) {
                    if (t.trait) {
                        t.trait = '';
                        needsSave = true;
                    }
                    needsSave = true;
                    return;
                }
                
                if (!newStats[cName]) {
                    let base = chat_metadata['bb_vn_char_bases']?.[cName] ?? 0;
                    newStats[cName] = { affinity: base, history: [], status: coerceUserFacingStatus("", base, "", 0), memories: { soft: [], deep: [] }, core_traits: [] };
                }
                if (!newStats[cName].core_traits) newStats[cName].core_traits = [];
                newStats[cName].core_traits.push(t);
            });
        }

        let activeUpdates = getStoredSwipeEntries(msg.extra?.bb_social_swipes, swipeId, allowLegacyFallback);

        if (activeUpdates && Array.isArray(activeUpdates)) {
            const userFilteredActiveUpdates = filterUserPersonaSocialUpdates(activeUpdates);
            if (userFilteredActiveUpdates.changed) {
                activeUpdates.splice(0, activeUpdates.length, ...userFilteredActiveUpdates.updates);
                needsSave = true;
                if (idx === lastAssistantIndex && userFilteredActiveUpdates.dropped.length > 0) {
                    setSocialParseDebug('filtered', 'Отброшено обновление на пользователя: VNE не создаёт карточку юзера');
                }
            }

            const dedupedActiveUpdates = dedupeSocialUpdateEntries(activeUpdates);
            if (dedupedActiveUpdates.changed) {
                activeUpdates.splice(0, activeUpdates.length, ...dedupedActiveUpdates.updates);
                needsSave = true;
            }

            const filteredSceneUpdates = filterStaleSceneUpdates(activeUpdates, msg, idx, chat, scopeState, aliasSet);
            if (filteredSceneUpdates.changed) {
                activeUpdates.splice(0, activeUpdates.length, ...filteredSceneUpdates.updates);
                needsSave = true;
                if (idx === lastAssistantIndex && filteredSceneUpdates.dropped.length > 0) {
                    const droppedNames = filteredSceneUpdates.dropped.map(item => item.rawName || item.canonical).filter(Boolean);
                    setSocialParseDebug('filtered', `Отброшены сомнительные обновления: ${droppedNames.join(', ')}`);
                }
            }

            const IMPACT_MAP = {
                unforgivable: -20,
                major_negative: -8,
                minor_negative: -2,
                none: 0,
                minor_positive: 2,
                major_positive: 8,
                life_changing: 20,
            };
            const normalizeImpactToken = (value) => String(value || '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '_')
                .replace(/-/g, '_');
            const parseImpactDelta = (rawImpact) => {
                const token = normalizeImpactToken(rawImpact);
                if (!token) return 0;
                if (Object.prototype.hasOwnProperty.call(IMPACT_MAP, token)) return IMPACT_MAP[token];

                const aliases = {
                    neutral: 'none',
                    no_change: 'none',
                    small_positive: 'minor_positive',
                    small_negative: 'minor_negative',
                    huge_positive: 'life_changing',
                    huge_negative: 'unforgivable',
                    слабый_плюс: 'minor_positive',
                    небольшой_плюс: 'minor_positive',
                    легкий_плюс: 'minor_positive',
                    сильный_плюс: 'major_positive',
                    большой_плюс: 'major_positive',
                    очень_сильный_плюс: 'life_changing',
                    слабый_минус: 'minor_negative',
                    небольшой_минус: 'minor_negative',
                    легкий_минус: 'minor_negative',
                    сильный_минус: 'major_negative',
                    большой_минус: 'major_negative',
                    очень_сильный_минус: 'unforgivable',
                    нет: 'none',
                    ноль: 'none',
                    отсутствует: 'none',
                };
                const normalizedAlias = aliases[token];
                if (normalizedAlias && Object.prototype.hasOwnProperty.call(IMPACT_MAP, normalizedAlias)) {
                    return IMPACT_MAP[normalizedAlias];
                }

                const numeric = parseInt(token, 10);
                if (!Number.isNaN(numeric)) return Math.max(-20, Math.min(20, numeric));
                return 0;
            };

            activeUpdates.forEach(update => {
                if (update.scope && !aliasSet.has(update.scope)) return;
                if (!update.scope || update.scope !== scopeKey) {
                    update.scope = scopeKey;
                    needsSave = true;
                }

                const resolvedIdentity = resolveCharacterIdentity(update.name || '', { allowCreate: true });
                const charName = resolvedIdentity?.primaryName || update.name;
                if (resolvedIdentity?.id && update.char_id !== resolvedIdentity.id) {
                    update.char_id = resolvedIdentity.id;
                    needsSave = true;
                }
                if (charName && update.name !== charName) {
                    update.name = charName;
                    needsSave = true;
                }
                if (!charName || isCollectiveEntityName(charName) || isUserPersonaCharacterName(charName)) return;
                if (chat_metadata['bb_vn_ignored_chars'].includes(charName)) return;

                let f_delta = parseImpactDelta(update.friendship_impact || update.impact_level);
                let r_delta = parseImpactDelta(update.romance_impact || update.romantic_impact || update.love_impact);
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (chat_metadata['bb_vn_platonic_chars'].includes(charName)) r_delta = 0;

                const currentStatus = update.role_dynamic || update.status || ""; 
                const currentEmotion = update.emotion || update.moodlet || "";
                const normalizedMixedDelta = normalizeMixedAffinityRomanceDeltas(
                    f_delta,
                    r_delta,
                    update.reason || "",
                    currentEmotion,
                    currentStatus,
                );
                f_delta = normalizedMixedDelta.friendshipDelta;
                r_delta = normalizedMixedDelta.romanceDelta;

                const isManualStatusOverride = isManualStatusOverrideUpdate(update, currentEmotion);
                const isDebugInjected = isDebugInjectedUpdate(update);
                const repeatedUpdateKey = (isManualStatusOverride || isDebugInjected) ? '' : buildRecentRelationshipRepeatKey(charName, f_delta, r_delta, update.reason || '');
                const previousRepeatIndex = repeatedUpdateKey ? recentRelationshipUpdateIndexes.get(repeatedUpdateKey) : undefined;
                if (repeatedUpdateKey && previousRepeatIndex !== undefined && (idx - previousRepeatIndex) <= RECENT_RELATION_UPDATE_REPEAT_WINDOW) {
                    return;
                }
                const semanticallyRepeatedUpdate = (isManualStatusOverride || isDebugInjected) ? null : findRecentSemanticallyRepeatedUpdate(recentRelationshipUpdates, {
                    charName,
                    friendshipDelta: f_delta,
                    romanceDelta: r_delta,
                    reason: update.reason || '',
                }, idx);
                if (semanticallyRepeatedUpdate) {
                    return;
                }
                
                if (!newStats[charName]) {
                    let base = 0, baseRomance = 0, isBrandNew = false;
                    if (chat_metadata['bb_vn_char_bases']?.[charName] !== undefined) base = parseInt(chat_metadata['bb_vn_char_bases'][charName]);
                    else { chat_metadata['bb_vn_char_bases'][charName] = 0; isBrandNew = true; newlyDiscoveredChars.push(charName); }
                    if (chat_metadata['bb_vn_char_bases_romance']?.[charName] !== undefined) baseRomance = parseInt(chat_metadata['bb_vn_char_bases_romance'][charName]);

                    newStats[charName] = { affinity: base, romance: baseRomance, history: [], status: coerceUserFacingStatus(currentStatus, base, "", f_delta), memories: { soft: [], deep: [] }, core_traits: [] };
                    if (isBrandNew && shouldRecordJournal) {
                        const introMoment = maybeAddStoryMoment({ type: 'intro', char: charName, title: 'Новый контакт', text: `${charName} появился в трекере отношений.` });
                        if (idx === chat.length - 1) {
                            queueLiveToastCandidate(liveToastCandidates, scopeKey, `${idx}|${msg.send_date || ''}|intro`, introMoment);
                        }
                    }
                }

                const previousAffinity = newStats[charName].affinity;
                const previousStatus = newStats[charName].status || "";
                newStats[charName].affinity += f_delta;
                newStats[charName].romance = (newStats[charName].romance || 0) + r_delta;
                
                if (newStats[charName].affinity > 100) newStats[charName].affinity = 100;
                if (newStats[charName].affinity < -100) newStats[charName].affinity = -100;
                if (newStats[charName].romance > 100) newStats[charName].romance = 100;
                if (newStats[charName].romance < -100) newStats[charName].romance = -100;

                const safeStatus = resolveStableRelationshipStatus(
                    currentStatus,
                    previousStatus,
                    previousAffinity,
                    newStats[charName].affinity,
                    { allowOverride: isManualStatusOverride },
                );
                if (safeStatus) newStats[charName].status = safeStatus;

                const moodlet = sanitizeMoodlet(currentEmotion);
                const dominantImpact = getDominantImpactEntry(f_delta, r_delta);
                const dominantDelta = dominantImpact?.delta || 0;
                const recordedImpacts = getRecordedImpactEntries(f_delta, r_delta);

                if (dominantImpact) {
                    newStats[charName].history.push({
                        delta: dominantDelta,
                        affinityDelta: f_delta,
                        romanceDelta: r_delta,
                        reason: update.reason || "",
                        moodlet,
                    });
                }
                if (repeatedUpdateKey) recentRelationshipUpdateIndexes.set(repeatedUpdateKey, idx);
                if (!isManualStatusOverride && !isDebugInjected) {
                    recentRelationshipUpdates.push({
                        idx,
                        charName,
                        friendshipDelta: f_delta,
                        romanceDelta: r_delta,
                        reason: update.reason || '',
                    });
                }
                recordedImpacts.forEach(impact => {
                    appendCharacterMemory(newStats[charName], impact.delta, update.reason || "", moodlet, { allowDuplicate: isDebugInjected });
                });

                const previousTier = getTierInfo(previousAffinity).label;
                const newTier = getTierInfo(newStats[charName].affinity).label;
                const messageMeta = `${idx}|${msg.send_date || ''}|${charName}|${update.reason || ''}|${f_delta}|${r_delta}`;
                let toastMoment = null;
                let queuedTierToast = false;
                if (shouldRecordJournal && previousTier !== newTier) toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: 'tier-shift', char: charName, title: 'Сдвиг в отношениях', text: `${charName}: статус изменился с «${previousTier}» на «${newTier}».` }));

                if (!queuedTierToast && shouldRecordJournal && previousTier !== newTier) {
                    const tierMoment = currentStoryMoments[currentStoryMoments.length - 1] || null;
                    if (idx === chat.length - 1 && tierMoment?.type === 'tier-shift' && tierMoment?.char === charName) {
                        queueLiveToastCandidate(liveToastCandidates, scopeKey, `${messageMeta}|tier`, tierMoment);
                        queuedTierToast = true;
                    }
                }

                if (shouldRecordJournal && update.reason) {
                    recordedImpacts.forEach(impact => {
                        if (Math.abs(impact.delta) >= 2) {
                            const shift = getShiftDescriptor(impact.delta, moodlet);
                            const momentType = impact.kind === 'romance'
                                ? (impact.delta > 0 ? 'romance-positive' : 'romance-negative')
                                : (impact.delta > 0 ? 'soft-positive' : 'soft-negative');
                            const moment = maybeAddStoryMoment({ type: momentType, char: charName, title: shift.full, text: `${charName}: ${update.reason}` });
                            if (impact === dominantImpact) toastMoment = pickToastMoment(toastMoment, moment);
                            if (idx === chat.length - 1) queueLiveToastCandidate(liveToastCandidates, scopeKey, `${messageMeta}|${impact.kind}|${impact.delta}|soft`, moment);
                        }

                        if (Math.abs(impact.delta) >= 15) {
                            const moment = maybeAddStoryMoment({ type: impact.delta > 0 ? 'deep-positive' : 'deep-negative', char: charName, title: 'Незабываемое событие', text: `${charName}: ${update.reason}` });
                            if (impact === dominantImpact) toastMoment = pickToastMoment(toastMoment, moment);
                            if (idx === chat.length - 1) queueLiveToastCandidate(liveToastCandidates, scopeKey, `${messageMeta}|${impact.kind}|${impact.delta}|deep`, moment);
                        }
                    });
                }
                void dominantDelta;
                void toastMoment;

                if (shouldRecordJournal && (f_delta !== 0 || r_delta !== 0)) {
                    const totalDelta = f_delta + r_delta;
                    const logType = totalDelta > 0 ? 'plus' : (totalDelta < 0 ? 'minus' : 'system');
                    let pointsHtml = '';
                    if (f_delta !== 0) pointsHtml += `<div class="bb-glog-points" style="margin-right: 4px; padding: 4px 10px; border-radius: 8px;">🤝 Доверие: ${f_delta > 0 ? '+' : ''}${f_delta}</div>`;
                    if (r_delta !== 0) pointsHtml += `<div class="bb-glog-points" style="color: #f472b6; border-color: rgba(244,114,182,0.35); background: rgba(190,24,93,0.28); margin-right: 4px; padding: 4px 10px; border-radius: 8px;">💖 Влечение: ${r_delta > 0 ? '+' : ''}${r_delta}</div>`;
                    let timeStr = "";
                    if (msg.send_date) { try { timeStr = new Date(msg.send_date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); } catch(e) {} }
                    const logText = `<div class="bb-glog-main" style="display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%;"><span class="bb-glog-char">${escapeHtml(charName)}</span>${moodlet ? `<span class="bb-glog-delta" style="align-self: flex-start;">${escapeHtml(moodlet)}</span>` : ''}</div>${update.reason ? `<div class="bb-glog-reason" style="margin-top: 4px;">${escapeHtml(update.reason)}</div>` : ''}<div style="display:flex; flex-wrap:wrap; margin-top:6px;">${pointsHtml}</div>`;
                    addGlobalLog(logType, logText, timeStr);
                }
            });
        }
    });

    for (const char in newStats) {
        const stats = newStats[char];
        if (!stats.core_traits) stats.core_traits = []; 
        let posTraitsCount = 0, negTraitsCount = 0, legacyTraitsCount = 0;
        stats.core_traits.forEach(t => { if (t.type === 'positive') posTraitsCount++; else if (t.type === 'negative') negTraitsCount++; else legacyTraitsCount++; });
        const posToArchive = (posTraitsCount * 5) + (legacyTraitsCount * 5);
        const negToArchive = (negTraitsCount * 5) + (legacyTraitsCount * 5);
        stats.memories.archive = [];
        const newDeep = [];
        let posArchived = 0, negArchived = 0;
        for (const m of stats.memories.deep) {
            if (m.tone === 'positive' && posArchived < posToArchive) { stats.memories.archive.push(m); posArchived++; }
            else if (m.tone === 'negative' && negArchived < negToArchive) { stats.memories.archive.push(m); negArchived++; }
            else newDeep.push(m);
        }
        stats.memories.deep = newDeep;
    }

    if (isNewMessage && liveToastCandidates.length > 0) {
        liveToastCandidates
            .filter(candidate => candidate?.moment && !hasShownLiveToast(candidate.key))
            .sort((left, right) => (right.priority - left.priority) || (left.order - right.order))
            .slice(0, TOAST_MAX_VISIBLE)
            .forEach(candidate => {
                showStoryMomentToast(candidate.moment);
                rememberLiveToast(candidate.key);
            });
    }

    if (latestChoiceContext) chat_metadata['bb_vn_last_used_choice_context'] = latestChoiceContext;
    else delete chat_metadata['bb_vn_last_used_choice_context'];

    const activeChoiceContext = getActiveChoiceContext();
    if (activeChoiceContext) chat_metadata['bb_vn_choice_context'] = activeChoiceContext;
    else delete chat_metadata['bb_vn_choice_context'];

    saveActivePersonaCutoff();
    if (needsSave) saveChatDebounced();
    injectCombinedSocialPrompt();
    renderHudCallback();
    if (typeof window['bbRenderMergeSuggestionsList'] === 'function') {
        window['bbRenderMergeSuggestionsList']();
    }

    if (newlyDiscoveredChars.length > 0) handleNewCharacterInterviews(newlyDiscoveredChars);
}

export function getTrendNarrative(history = []) {
    const recent = history.filter(h => h.delta !== 0).slice(-3);
    if (recent.length === 0) return 'Штиль';
    const sum = recent.reduce((acc, curr) => acc + curr.delta, 0);
    if (sum >= 8) return 'Уверенное сближение';
    if (sum > 0) return 'Позитивный сдвиг';
    if (sum <= -8) return 'Резкое отторжение';
    if (sum < 0) return 'Нарастание напряжения';
    return 'Неоднозначно';
}
