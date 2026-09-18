// Edits live on the original source record, per persona and memory/trait slot.
// Derived stats receive copies only; event scores and journal text are untouched.
const bindings = new WeakMap();
let revision = 0;
let entries = [];

export function resetMemoryEditor() {
    revision++;
    entries = [];
}

export function trackEditableRecord(record, source, slot, field) {
    bindings.set(record, { source, slot, field });
    return record;
}

function editState(binding, scope) {
    return binding.source.bb_vn_text_edits?.[scope]?.[binding.slot] || {};
}

export function applyMemoryEdits(stats, scope, name) {
    const apply = (records, kind) => (records || []).flatMap(record => {
        const binding = bindings.get(record);
        if (!binding) return [record];
        const state = editState(binding, scope);
        const text = typeof state.text === 'string' ? state.text : record[binding.field];
        entries.push({ binding, scope, name, kind, text, hidden: state.hidden === true, canUndo: Array.isArray(state.undo) && state.undo.length > 0 });
        return state.hidden === true ? [] : [{ ...record, [binding.field]: text }];
    });
    for (const kind of ['soft', 'deep', 'archive']) {
        if (stats.memories?.[kind]) stats.memories[kind] = apply(stats.memories[kind], kind);
    }
    stats.core_traits = apply(stats.core_traits, 'trait');
}

export function memoryEditorEntries(name) {
    return entries.flatMap((entry, index) => entry.name === name
        ? [{ index, revision, kind: entry.kind, text: entry.text, hidden: entry.hidden, canUndo: entry.canUndo }]
        : []);
}

export function changeMemoryEntry(index, expectedRevision, action, text = '') {
    if (revision !== expectedRevision || !entries[index]) throw new Error('EDITOR_STALE');
    const entry = entries[index];
    const current = editState(entry.binding, entry.scope);
    const history = Array.isArray(current.undo) ? current.undo : [];
    let next;
    if (action === 'undo') {
        if (!history.length) return false;
        next = { ...history[history.length - 1], undo: history.slice(0, -1) };
    } else {
        if (!['edit', 'delete'].includes(action)) throw new Error('EDITOR_ACTION');
        const value = String(text).trim();
        if (action === 'edit' && (!value || value.length > (entry.kind === 'trait' ? 240 : 2000)
            || (entry.kind === 'trait' && !value.includes(':')))) throw new Error('EDITOR_TEXT');
        const previous = {};
        if (typeof current.text === 'string') previous.text = current.text;
        if (current.hidden === true) previous.hidden = true;
        next = { ...previous, undo: [...history.slice(-19), previous] };
        if (action === 'edit') { next.text = value; next.hidden = false; }
        else next.hidden = true;
    }
    const source = entry.binding.source;
    if (!source.bb_vn_text_edits) source.bb_vn_text_edits = {};
    if (!source.bb_vn_text_edits[entry.scope]) source.bb_vn_text_edits[entry.scope] = {};
    source.bb_vn_text_edits[entry.scope][entry.binding.slot] = next;
    revision++;
    return true;
}
