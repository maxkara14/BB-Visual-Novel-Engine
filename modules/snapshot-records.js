const copy = value => JSON.parse(JSON.stringify(value));

export function snapshotPlainText(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (match, entity) => {
            if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
            const code = entity[1]?.toLowerCase() === 'x'
                ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
            return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
                ? String.fromCodePoint(code) : match;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

function classText(html, className) {
    const source = String(html ?? '');
    const tags = /<(span|div)\b[^>]*>/gi;
    for (const match of source.matchAll(tags)) {
        const classAttribute = match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i);
        if (!classAttribute?.[2].split(/\s+/).includes(className)) continue;
        const start = match.index + match[0].length;
        const end = source.toLowerCase().indexOf(`</${match[1].toLowerCase()}>`, start);
        if (end !== -1) return snapshotPlainText(source.slice(start, end));
    }
    return '';
}

function journalFields(entry) {
    const source = String(entry?.text ?? '');
    const character = classText(source, 'bb-glog-char');
    if (!character) return {};
    const points = [...source.matchAll(/<div\b[^>]*class\s*=\s*(["'])[^"']*\bbb-glog-points\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/gi)]
        .map(match => snapshotPlainText(match[2]))
        .filter(Boolean);
    return {
        character,
        mood: classText(source, 'bb-glog-delta'),
        reason: classText(source, 'bb-glog-reason'),
        points,
    };
}

export function listSnapshotRecords(scope = {}) {
    const baseline = scope.snapshot_baseline;
    if (!baseline) return [];
    return [
        ...Object.entries(baseline.characters || {}).map(([name, entry]) => ({
            kind: 'character', key: name, title: name, text: name,
            detail: [entry?.status, Number.isFinite(entry?.affinity) ? `🤝 ${entry.affinity}` : '',
                Number.isFinite(entry?.romance) ? `💖 ${entry.romance}` : ''].filter(Boolean).join(' · '),
        })),
        ...(baseline.global_log || []).map((entry, index) => {
            const fields = journalFields(entry);
            return {
                kind: 'log', key: String(index), number: index + 1,
                title: fields.character || `#${index + 1}`,
                text: snapshotPlainText(entry?.text), detail: snapshotPlainText(entry?.time),
                mood: fields.mood || '', reason: fields.reason || '', points: fields.points || [],
            };
        }),
        ...(baseline.story_moments || []).map((entry, index) => ({
            kind: 'moment', key: String(index), title: snapshotPlainText(entry?.title) || `#${index + 1}`,
            text: snapshotPlainText(entry?.text), detail: '',
        })),
    ];
}

export function removeSnapshotRecord(scope, kind, key) {
    const baseline = scope.snapshot_baseline;
    if (!baseline) return false;
    let undo;
    if (kind === 'character') {
        if (!Object.hasOwn(baseline.characters || {}, key)) return false;
        undo = {
            kind, key, entry: copy(baseline.characters[key]),
            base: baseline.char_bases?.[key], romanceBase: baseline.char_bases_romance?.[key],
            currentBase: scope.char_bases?.[key], currentRomanceBase: scope.char_bases_romance?.[key],
        };
        delete baseline.characters[key];
        if (baseline.char_bases) delete baseline.char_bases[key];
        if (baseline.char_bases_romance) delete baseline.char_bases_romance[key];
        if (scope.char_bases) delete scope.char_bases[key];
        if (scope.char_bases_romance) delete scope.char_bases_romance[key];
    } else {
        const field = kind === 'log' ? 'global_log' : kind === 'moment' ? 'story_moments' : null;
        const index = Number(key);
        if (!field || !Array.isArray(baseline[field]) || !Number.isInteger(index) || index < 0 || index >= baseline[field].length) return false;
        undo = { kind, key, entry: copy(baseline[field][index]) };
        baseline[field].splice(index, 1);
    }
    scope.snapshot_record_undo = undo;
    return true;
}

export function undoSnapshotRecordRemoval(scope) {
    const baseline = scope.snapshot_baseline;
    const undo = scope.snapshot_record_undo;
    if (!baseline || !undo) return false;
    if (undo.kind === 'character') {
        if (!baseline.characters) baseline.characters = {};
        baseline.characters[undo.key] = copy(undo.entry);
        for (const [field, value] of [
            ['char_bases', undo.base], ['char_bases_romance', undo.romanceBase],
        ]) {
            if (value !== undefined) { if (!baseline[field]) baseline[field] = {}; baseline[field][undo.key] = value; }
        }
        for (const [field, value] of [
            ['char_bases', undo.currentBase], ['char_bases_romance', undo.currentRomanceBase],
        ]) {
            if (value !== undefined) { if (!scope[field]) scope[field] = {}; scope[field][undo.key] = value; }
        }
    } else {
        const field = undo.kind === 'log' ? 'global_log' : undo.kind === 'moment' ? 'story_moments' : null;
        if (!field) return false;
        if (!Array.isArray(baseline[field])) baseline[field] = [];
        baseline[field].splice(Math.min(Number(undo.key), baseline[field].length), 0, copy(undo.entry));
    }
    scope.snapshot_record_undo = null;
    return true;
}
