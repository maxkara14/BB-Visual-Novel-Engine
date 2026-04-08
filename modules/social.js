/* global SillyTavern */
import { setExtensionPrompt, chat_metadata, saveChatDebounced, extension_prompt_roles, extension_prompt_types, callPopup } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { 
    currentCalculatedStats, 
    currentStoryMoments, 
    setCurrentCalculatedStats,
    setSocialParseDebug
} from './state.js';
import { MODULE_NAME, SOCIAL_PROMPT } from './constants.js';
import { 
    sanitizeMoodlet, 
    getMemoryBucket, 
    getMemoryTone, 
    coerceUserFacingStatus, 
    isCollectiveEntityName, 
    getShiftDescriptor,
    formatAffinityPoints,
    escapeHtml,
    sanitizeRelationshipStatus,
    normalizeTraitResponse,
    isLikelyModelRefusalText
} from './utils.js';
import { showStoryMomentToast, notifySuccess, notifyInfo, notifyError, pickToastMoment } from './toasts.js';
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

function ensurePersonaStateShape(scopeState = {}) {
    if (!scopeState.char_bases || typeof scopeState.char_bases !== 'object') scopeState.char_bases = {};
    if (!scopeState.char_bases_romance || typeof scopeState.char_bases_romance !== 'object') scopeState.char_bases_romance = {};
    if (!Array.isArray(scopeState.ignored_chars)) scopeState.ignored_chars = [];
    if (!Array.isArray(scopeState.platonic_chars)) scopeState.platonic_chars = [];
    if (!Array.isArray(scopeState.global_log)) scopeState.global_log = [];
    if (!scopeState.char_registry || typeof scopeState.char_registry !== 'object') scopeState.char_registry = {};
    if (!Array.isArray(scopeState.merge_suggestions)) scopeState.merge_suggestions = [];
    scopeState.log_cutoff_index = parseInt(scopeState.log_cutoff_index, 10) || 0;
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
    };
    scopeState.char_registry[entry.id] = entry;
    return entry;
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
            
            const recent = (stats.memories?.soft || []).map(m => m.text).join('; ');
            const deepMemories = stats.memories?.deep || [];
            const recentDeep = deepMemories.slice(-5); 
            const unforgettable = recentDeep.map(m => m.text).join('; ');
            const coreTraits = stats.core_traits || []; 
            const traitsText = coreTraits.length > 0 ? coreTraits.map(t => t.trait).join(' ') : '';

            combinedStr += `- ${char}: [Status: ${status}] [Trust: ${stats.affinity}] [Romance: ${stats.romance || 0}]`;
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
    setCurrentCalculatedStats(newStats);
    currentStoryMoments.length = 0;
    scopeState.global_log = [];
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
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

    chat.forEach((msg, idx) => {
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

                const f_delta = parseImpactDelta(update.friendship_impact || update.impact_level);
                let r_delta = parseImpactDelta(update.romance_impact || update.romantic_impact || update.love_impact);
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (chat_metadata['bb_vn_platonic_chars'].includes(charName)) r_delta = 0;

                const currentStatus = update.role_dynamic || update.status || ""; 
                const currentEmotion = update.emotion || update.moodlet || "";
                
                if (!newStats[charName]) {
                    let base = 0, baseRomance = 0, isBrandNew = false;
                    if (chat_metadata['bb_vn_char_bases']?.[charName] !== undefined) base = parseInt(chat_metadata['bb_vn_char_bases'][charName]);
                    else { chat_metadata['bb_vn_char_bases'][charName] = 0; isBrandNew = true; newlyDiscoveredChars.push(charName); }
                    if (chat_metadata['bb_vn_char_bases_romance']?.[charName] !== undefined) baseRomance = parseInt(chat_metadata['bb_vn_char_bases_romance'][charName]);

                    newStats[charName] = { affinity: base, romance: baseRomance, history: [], status: coerceUserFacingStatus(currentStatus, base, "", f_delta), memories: { soft: [], deep: [] }, core_traits: [] };
                    if (isBrandNew && shouldRecordJournal) {
                        const introMoment = maybeAddStoryMoment({ type: 'intro', char: charName, title: 'Новый контакт', text: `${charName} появился в трекере отношений.` });
                        if (isNewMessage && idx === chat.length - 1) showStoryMomentToast(introMoment);
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

                const safeStatus = coerceUserFacingStatus(currentStatus, newStats[charName].affinity, previousStatus, f_delta);
                if (safeStatus) newStats[charName].status = safeStatus;

                const moodlet = sanitizeMoodlet(currentEmotion);
                const isRomanceShift = Math.abs(r_delta) > Math.abs(f_delta);
                const dominantDelta = isRomanceShift ? r_delta : f_delta;
                
                newStats[charName].history.push({ delta: dominantDelta, reason: update.reason || "", moodlet });
                appendCharacterMemory(newStats[charName], dominantDelta, update.reason || "", moodlet);

                const previousTier = getTierInfo(previousAffinity).label;
                const newTier = getTierInfo(newStats[charName].affinity).label;
                let toastMoment = null;
                if (shouldRecordJournal && previousTier !== newTier) toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: 'tier-shift', char: charName, title: 'Сдвиг в отношениях', text: `${charName}: статус изменился с «${previousTier}» на «${newTier}».` }));

                if (shouldRecordJournal && Math.abs(dominantDelta) >= 2 && update.reason) {
                    const shift = getShiftDescriptor(dominantDelta, moodlet);
                    let momentType = dominantDelta > 0 ? 'soft-positive' : 'soft-negative';
                    if (isRomanceShift) momentType = dominantDelta > 0 ? 'romance-positive' : 'romance-negative';
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: momentType, char: charName, title: shift.full, text: `${charName}: ${update.reason}` }));
                }

                if (shouldRecordJournal && Math.abs(dominantDelta) >= 15 && update.reason) toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: dominantDelta > 0 ? 'deep-positive' : 'deep-negative', char: charName, title: 'Незабываемое событие', text: `${charName}: ${update.reason}` }));
                if (dominantDelta !== 0 && isNewMessage && idx === chat.length - 1 && toastMoment) showStoryMomentToast(toastMoment);

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
