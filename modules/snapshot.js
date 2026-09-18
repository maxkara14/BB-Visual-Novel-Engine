import { MODULE_NAME } from './constants.js';

export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code = 'INVALID_SNAPSHOT') => { throw new Error(code); };
function object(value) { if (!record(value)) fail(); }
function string(value) { if (typeof value !== 'string') fail(); }
function number(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(); }
function array(value, validate) {
    if (!Array.isArray(value) || value.length > 10000) fail();
    value.forEach(validate);
}
function fields(value, strings = [], numbers = []) {
    object(value);
    for (const key of strings) if (own(value, key)) string(value[key]);
    for (const key of numbers) if (own(value, key)) number(value[key]);
}
function memory(value) { fields(value, ['text', 'tone', 'moodlet'], ['delta']); string(value.text); }
function character(value) {
    fields(value, ['status'], ['affinity', 'romance']);
    number(value.affinity);
    if (own(value, 'history')) array(value.history, entry => fields(entry, ['reason', 'moodlet'], ['delta', 'affinityDelta', 'romanceDelta']));
    if (own(value, 'core_traits')) array(value.core_traits, entry => { fields(entry, ['trait', 'type']); string(entry.trait); });
    if (own(value, 'memories')) {
        object(value.memories);
        for (const key of ['soft', 'deep', 'archive']) if (own(value.memories, key)) array(value.memories[key], memory);
    }
}

// Parse and validate before binding a persona or touching chat metadata.
// Legacy support is limited to the former bare data object with characters.
export function parseSnapshot(raw) {
    let json;
    try { json = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { fail(); }
    if (typeof json !== 'string') fail();
    if (json.length > MAX_SNAPSHOT_BYTES || new TextEncoder().encode(json).length > MAX_SNAPSHOT_BYTES) fail('SNAPSHOT_TOO_LARGE');
    let snapshot;
    try { snapshot = JSON.parse(json); } catch { fail(); }
    object(snapshot);
    const stack = [[snapshot, 0]];
    let nodes = 0;
    while (stack.length) {
        const [value, depth] = stack.pop();
        if (++nodes > 100000 || depth > 40) fail();
        if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key)) fail();
                stack.push([child, depth + 1]);
            }
        }
    }
    fields(snapshot, ['exported_at', 'scope_key', 'persona_label'], ['source_chat_length']);
    const wrapped = ['data', 'module', 'schema_version'].some(key => own(snapshot, key));
    if (wrapped) {
        if (snapshot.module !== MODULE_NAME) fail('SNAPSHOT_WRONG_MODULE');
        if (snapshot.schema_version !== 1) fail('SNAPSHOT_UNSUPPORTED_VERSION');
        object(snapshot.data);
        if (own(snapshot, 'source_chat_length') && (!Number.isInteger(snapshot.source_chat_length) || snapshot.source_chat_length < 0)) fail();
    }
    const data = wrapped ? snapshot.data : snapshot;
    object(data.characters);
    if (Object.keys(data.characters).length > 1000) fail();
    const names = new Set();
    for (const [name, stats] of Object.entries(data.characters)) {
        if (!name.trim() || name.length > 256 || names.has(name.trim())) fail();
        names.add(name.trim());
        character(stats);
    }
    for (const key of ['char_bases', 'char_bases_romance']) if (own(data, key)) {
        object(data[key]); Object.values(data[key]).forEach(number);
    }
    for (const key of ['ignored_chars', 'platonic_chars']) if (own(data, key)) array(data[key], string);
    if (own(data, 'char_registry')) {
        object(data.char_registry);
        if (Object.keys(data.char_registry).length > 1000) fail();
        for (const entry of Object.values(data.char_registry)) {
            fields(entry, ['id', 'primary_name', 'description', 'avatar', 'avatarSource'], ['created_at']);
            string(entry.primary_name);
            if (own(entry, 'aliases')) array(entry.aliases, string);
            if (own(entry, 'avatarCrop')) fields(entry.avatarCrop, [], ['x', 'y', 'zoom']);
        }
    }
    if (own(data, 'merge_suggestions')) array(data.merge_suggestions, entry => {
        fields(entry, ['source', 'target', 'target_id'], ['score', 'at']); string(entry.source); string(entry.target);
    });
    if (own(data, 'global_log')) array(data.global_log, entry => { fields(entry, ['time', 'type', 'text']); string(entry.text); });
    if (own(data, 'story_moments')) array(data.story_moments, entry => {
        fields(entry, ['type', 'char', 'title', 'text']); string(entry.title); string(entry.text);
    });
    return {
        snapshot, data,
        summary: {
            format: wrapped ? 'v1' : 'legacy', persona: wrapped ? snapshot.persona_label || '' : '',
            exportedAt: wrapped ? snapshot.exported_at || '' : '',
            characters: names.size, logs: data.global_log?.length || 0, moments: data.story_moments?.length || 0,
        },
    };
}

export async function confirmSnapshotFile(file, { getContext, getPersonaKey, confirm, apply }) {
    if (file.size > MAX_SNAPSHOT_BYTES) fail('SNAPSHOT_TOO_LARGE');
    const initial = getContext();
    const chat = initial.chat;
    const contextKey = context => JSON.stringify([context.chatId, context.characterId, context.groupId]);
    const key = contextKey(initial);
    const persona = getPersonaKey();
    const length = chat?.length;
    const assertCurrent = () => {
        const current = getContext();
        if (current.chat !== chat || contextKey(current) !== key || getPersonaKey() !== persona || current.chat?.length !== length) fail('SNAPSHOT_CONTEXT_CHANGED');
    };
    const parsed = parseSnapshot(await file.text());
    assertCurrent();
    if (await confirm(parsed.summary) !== true) return null;
    assertCurrent();
    return apply(parsed.snapshot);
}
