// Editor overrides belong to chat metadata, leaving parsed message events intact.
// This lets branches restore the override state at their selected message.
let revision = 0;
let ownerChat = null;
let entries = [];

const copy = value => JSON.parse(JSON.stringify(value));

export function resetRelationshipEventEditor(chat = null) {
    revision++;
    ownerChat = chat;
    entries = [];
}

export function relationshipEventKey(messageIndex, swipeId, updateIndex) {
    return `${messageIndex}|${swipeId}|${updateIndex}`;
}

export function relationshipEventSignature(update = {}) {
    return JSON.stringify([
        update.name || '', update.char_id || '', update.friendship_impact || update.impact_level || '',
        update.romance_impact || update.romantic_impact || update.love_impact || '',
        update.reason || '', update.emotion || update.moodlet || '', update.role_dynamic || update.status || '',
    ]);
}

export function relationshipEventEdit(scope = {}, key, signature) {
    const edit = scope.relationship_event_edits?.[key];
    return edit?.signature === signature ? edit : null;
}

export function trackRelationshipEvent(scope, chat, data) {
    entries.push({ ...data, scope, chat, revision });
}

export function listRelationshipEvents(chat = null, scope = null) {
    if (ownerChat && chat && ownerChat !== chat) return [];
    return entries.flatMap((entry, index) => (!scope || entry.scopeKey === scope) ? [{
        index, revision, key: entry.key, signature: entry.signature, name: entry.name,
        reason: entry.reason, mood: entry.mood, friendshipDelta: entry.friendshipDelta,
        romanceDelta: entry.romanceDelta, time: entry.time, disabled: entry.disabled,
        canUndo: entry.canUndo,
    }] : []);
}

export function changeRelationshipEvent(scope, index, expectedRevision, action, values = {}) {
    if (revision !== expectedRevision || !entries[index] || entries[index].scope !== scope) throw new Error('EDITOR_STALE');
    const entry = entries[index];
    if (entry.chat !== ownerChat) throw new Error('EDITOR_STALE');
    const message = ownerChat?.[entry.messageIndex];
    if ((message?.swipe_id ?? 0) !== entry.swipeId
        || relationshipEventSignature(entry.sourceUpdate) !== entry.signature
        || !Object.values(message?.extra?.bb_social_swipes || {}).some(updates => Array.isArray(updates) && updates.includes(entry.sourceUpdate))) {
        throw new Error('EDITOR_STALE');
    }
    const current = relationshipEventEdit(scope, entry.key, entry.signature) || { signature: entry.signature, undo: [] };
    const history = Array.isArray(current.undo) ? current.undo : [];
    let next;
    if (action === 'undo') {
        if (!history.length) return false;
        next = { ...history[history.length - 1], undo: history.slice(0, -1) };
    } else {
        if (action !== 'edit' && action !== 'disable') throw new Error('EDITOR_ACTION');
        if (action === 'edit') {
            for (const field of ['friendshipDelta', 'romanceDelta']) {
                if (!Number.isInteger(values[field]) || values[field] < -100 || values[field] > 100) throw new Error('EDITOR_VALUE');
            }
            if (scope.platonic_chars?.includes(entry.name) && values.romanceDelta !== 0) throw new Error('EDITOR_VALUE');
            if (typeof values.reason !== 'string' || values.reason.trim().length > 2000
                || typeof values.mood !== 'string' || values.mood.trim().length > 240) throw new Error('EDITOR_TEXT');
        }
        const previous = { ...current };
        delete previous.undo;
        next = { ...previous, undo: [...history.slice(-19), copy(previous)] };
        if (action === 'disable') next.disabled = true;
        else {
            next.friendshipDelta = values.friendshipDelta;
            next.romanceDelta = values.romanceDelta;
            next.reason = values.reason.trim();
            next.mood = values.mood.trim();
            next.disabled = false;
        }
    }
    if (!scope.relationship_event_edits || typeof scope.relationship_event_edits !== 'object') scope.relationship_event_edits = {};
    scope.relationship_event_edits[entry.key] = next;
    revision++;
    return true;
}
