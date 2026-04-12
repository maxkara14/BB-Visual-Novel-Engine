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

export function getCurrentPersonaScopeKey() {
    const personaText = getCurrentPersonaText();
    if (!personaText) return 'default';
    return `persona_${hashString(personaText)}`;
}

function getCurrentPersonaLabel() {
    const personaText = getCurrentPersonaText();
    if (!personaText) return 'Default persona';
    return personaText.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 80) || 'Persona';
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
    return Math.max(80, Math.min(240, numeric));
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
            entry.avatarCrop = normalizeAvatarCrop();
        }
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
            soft: Array.isArray(memories.soft) ? memories.soft.map(normalizeImportedMemoryEntry).filter(entry => entry.text).slice(-4) : [],
            deep: Array.isArray(memories.deep) ? memories.deep.map(normalizeImportedMemoryEntry).filter(entry => entry.text) : [],
            archive: Array.isArray(memories.archive) ? memories.archive.map(normalizeImportedMemoryEntry).filter(entry => entry.text) : [],
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

function ensureActivePersonaState() {
    if (!chat_metadata['bb_vn_persona_states'] || typeof chat_metadata['bb_vn_persona_states'] !== 'object') {
        chat_metadata['bb_vn_persona_states'] = {};
    }

    const scopeKey = getCurrentPersonaScopeKey();
    const scopes = chat_metadata['bb_vn_persona_states'];
    if (!scopes[scopeKey] || typeof scopes[scopeKey] !== 'object') {
        scopes[scopeKey] = {};
    }

    const scopeState = ensurePersonaStateShape(scopes[scopeKey]);
    if (!scopeState._legacy_migrated) {
        const isFirstScope = Object.keys(scopes).length === 1;
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

    return { scopeKey, scopeState };
}

export function bindActivePersonaState() {
    const { scopeKey, scopeState } = ensureActivePersonaState();
    chat_metadata['bb_vn_active_persona_scope'] = scopeKey;
    chat_metadata['bb_vn_char_bases'] = scopeState.char_bases;
    chat_metadata['bb_vn_char_bases_romance'] = scopeState.char_bases_romance;
    chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars;
    chat_metadata['bb_vn_platonic_chars'] = scopeState.platonic_chars;
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
    chat_metadata['bb_vn_char_registry'] = scopeState.char_registry;
    chat_metadata['bb_vn_merge_suggestions'] = scopeState.merge_suggestions;
    chat_metadata['bb_vn_log_cutoff_index'] = scopeState.log_cutoff_index || 0;
    return { scopeKey, scopeState };
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
        if (!safeName || isCollectiveEntityName(safeName)) return;
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

function scoreCharacterMatch(sourceName = '', candidateName = '') {
    const source = normalizeCharacterLookupName(sourceName);
    const candidate = normalizeCharacterLookupName(candidateName);
    if (!source || !candidate) return 0;
    if (source === candidate) return 1;
    if (source.includes(candidate) || candidate.includes(source)) {
        const minLen = Math.min(source.length, candidate.length);
        const maxLen = Math.max(source.length, candidate.length);
        return minLen / maxLen;
    }

    const sourceTokens = new Set(source.split(' ').filter(Boolean));
    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    if (sourceTokens.size === 0 || candidateTokens.size === 0) return 0;

    let overlap = 0;
    sourceTokens.forEach(token => {
        if (candidateTokens.has(token)) overlap++;
    });

    const union = new Set([...sourceTokens, ...candidateTokens]).size || 1;
    return overlap / union;
}

function rememberMergeSuggestion(scopeState, sourceName, targetEntry, score) {
    if (!scopeState || !targetEntry) return;
    if (!Array.isArray(scopeState.merge_suggestions)) scopeState.merge_suggestions = [];

    const normalizedSource = normalizeCharacterLookupName(sourceName);
    const normalizedTarget = normalizeCharacterLookupName(targetEntry.primary_name);
    const alreadyExists = scopeState.merge_suggestions.some(item =>
        normalizeCharacterLookupName(item.source || '') === normalizedSource &&
        normalizeCharacterLookupName(item.target || '') === normalizedTarget
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
}

function createCharacterRegistryEntry(scopeState, displayName) {
    const entry = {
        id: `char_${hashString(`${displayName}|${Date.now()}|${Math.random()}`)}`,
        primary_name: String(displayName || '').trim(),
        aliases: [String(displayName || '').trim()],
        created_at: Date.now(),
        description: '',
        avatar: '',
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

export function resolveCharacterIdentity(rawName = '', options = {}) {
    const {
        allowCreate = true,
        allowSuggestions = true,
    } = options || {};

    const { scopeState } = bindActivePersonaState();
    const displayName = String(rawName || '').trim();
    const normalized = normalizeCharacterLookupName(displayName);
    if (!displayName || !normalized) return null;

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
    const { scopeKey, scopeState } = bindActivePersonaState();
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
                        if (update?.scope && update.scope !== scopeKey) return;
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
                        if (trait?.scope && trait.scope !== scopeKey) return;
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

export function getCombinedSocial() {
    bindActivePersonaState();
    let combinedStr = SOCIAL_PROMPT;
    const characters = Object.keys(currentCalculatedStats);
    
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
        combinedStr += `4. Name Consistency: When evaluating existing characters, use EXACTLY these names: ${characters.join(', ')}.`;

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
    const hasIncoming = isValidUserFacingStatus(incoming);
    const hasPrevious = isValidUserFacingStatus(previous);
    const allowOverride = options?.allowOverride === true;

    if (!hasIncoming) return hasPrevious ? previous : '';
    if (!hasPrevious) return incoming;
    if (allowOverride) return incoming;

    const previousTierKey = getAffinityTierKey(previousAffinity);
    const nextTierKey = getAffinityTierKey(nextAffinity);
    if (previousTierKey !== nextTierKey) return incoming;

    return previous;
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

export function appendCharacterMemory(charStats, delta, reason, moodlet = '') {
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
    const readUpdatesFromBlock = (block) => {
        const updateMatches = [...block.matchAll(/<bb-social-update\b[^>]*>([\s\S]*?)<\/bb-social-update>/gi)];
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
                role_dynamic: readTag('role_dynamic'),
                reason: readTag('reason'),
                emotion: readTag('emotion'),
            };
        }).filter(u => u.name && (u.friendship_impact || u.romance_impact));

        return updates;
    };

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
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.bb_social_swipes) msg.extra.bb_social_swipes = {};

            msg.extra.bb_social_swipes[swipeId] = parsed.social_updates.map(update => ({
                ...update,
                scope: update.scope || scopeKey,
            }));
            currentMes = currentMes.replace(parsedPayload.source, '');
            if (trackDebug) setSocialParseDebug('parsed', `social_updates: ${parsed.social_updates.length}`);
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
        
        if (msg.swipes && msg.swipes[swipeId] !== undefined) {
            msg.swipes[swipeId] = msg.mes; 
        } else if (msg.swipes && msg.swipes.length > 0) {
            msg.swipes[0] = msg.mes; 
        } else {
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

    for (const charName of chars) {
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
    const { scopeKey, scopeState } = bindActivePersonaState();
    const newStats = {};
    const liveToastCandidates = [];
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
    baselineStoryMoments.forEach(moment => currentStoryMoments.push(moment));
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
        if (!safeName || isCollectiveEntityName(safeName)) return;
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

    let needsSave = false;

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
            msgTraits.forEach(t => {
                if (t.scope && t.scope !== scopeKey) return;
                if (!t.scope) {
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
                if (update.scope && update.scope !== scopeKey) return;
                if (!update.scope) {
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
                if (!charName || isCollectiveEntityName(charName)) return;
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

                const isManualStatusOverride = update.reason === 'Ручная смена статуса' || currentEmotion === 'дебаг';
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
                recordedImpacts.forEach(impact => {
                    appendCharacterMemory(newStats[charName], impact.delta, update.reason || "", moodlet);
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
