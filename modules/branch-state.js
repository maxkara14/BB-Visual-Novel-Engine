const copy = (value, fallback) => {
    try { return JSON.parse(JSON.stringify(value ?? fallback)); } catch { return fallback; }
};

const ASSET_FIELDS = ['avatar', 'avatarSource'];
const ASSET_REF = '__bb_vn_asset_ref';

function packRegistry(registry, lineage) {
    let changed = false;
    for (const entry of Object.values(registry || {})) {
        if (!entry || typeof entry !== 'object') continue;
        for (const field of ASSET_FIELDS) {
            const value = entry[field];
            if (typeof value !== 'string' || value.length < 1024) continue;
            let index = lineage.assets.indexOf(value);
            if (index < 0) index = lineage.assets.push(value) - 1;
            entry[field] = { [ASSET_REF]: index };
            changed = true;
        }
    }
    return changed;
}

function unpackRegistry(registry, lineage) {
    const restored = copy(registry, {});
    for (const entry of Object.values(restored)) {
        if (!entry || typeof entry !== 'object') continue;
        for (const field of ASSET_FIELDS) {
            const ref = entry[field]?.[ASSET_REF];
            if (Number.isInteger(ref)) entry[field] = lineage.assets?.[ref] || '';
        }
    }
    return restored;
}

function compactLineage(lineage) {
    if (!Array.isArray(lineage.assets)) lineage.assets = [];
    let changed = false;
    for (const revision of lineage.revisions) {
        changed = packRegistry(revision.state.char_registry, lineage) || changed;
    }
    for (const baseline of lineage.baselines) {
        changed = packRegistry(baseline?.restore?.char_registry, lineage) || changed;
    }
    return changed;
}

function pruneAssets(lineage) {
    if (!Array.isArray(lineage.assets)) return;
    const used = new Set();
    const collect = registry => {
        for (const entry of Object.values(registry || {})) {
            if (!entry || typeof entry !== 'object') continue;
            for (const field of ASSET_FIELDS) {
                const ref = entry[field]?.[ASSET_REF];
                if (Number.isInteger(ref)) used.add(ref);
            }
        }
    };
    lineage.revisions.forEach(revision => collect(revision.state.char_registry));
    lineage.baselines.forEach(baseline => collect(baseline?.restore?.char_registry));
    const indices = [...used].sort((a, b) => a - b);
    const mapped = new Map(indices.map((index, next) => [index, next]));
    const remap = registry => {
        for (const entry of Object.values(registry || {})) {
            if (!entry || typeof entry !== 'object') continue;
            for (const field of ASSET_FIELDS) {
                const ref = entry[field]?.[ASSET_REF];
                if (Number.isInteger(ref)) entry[field][ASSET_REF] = mapped.get(ref);
            }
        }
    };
    lineage.revisions.forEach(revision => remap(revision.state.char_registry));
    lineage.baselines.forEach(baseline => remap(baseline?.restore?.char_registry));
    lineage.assets = indices.map(index => lineage.assets[index]);
}

function capture(scope, baselineId, lineage) {
    const charRegistry = copy(scope.char_registry, {});
    packRegistry(charRegistry, lineage);
    return {
        baseline_id: baselineId,
        char_bases: copy(scope.char_bases, {}),
        char_bases_romance: copy(scope.char_bases_romance, {}),
        ignored_chars: copy(scope.ignored_chars, []),
        platonic_chars: copy(scope.platonic_chars, []),
        char_registry: charRegistry,
        merge_suggestions: copy(scope.merge_suggestions, []),
        log_cutoff_index: scope.log_cutoff_index || 0,
        replay_keys: copy(scope.snapshot_post_import_replay_keys, {}),
        relationship_event_edits: copy(scope.relationship_event_edits, {}),
    };
}

function apply(scope, revision, lineage, chatLength) {
    const state = revision.state;
    const imported = state.baseline_id === null ? null : lineage.baselines[state.baseline_id];
    scope.snapshot_baseline = copy(imported?.baseline, null);
    scope.snapshot_restore_state = copy(imported?.restore, null);
    if (scope.snapshot_restore_state?.char_registry) {
        scope.snapshot_restore_state.char_registry = unpackRegistry(scope.snapshot_restore_state.char_registry, lineage);
    }
    scope.snapshot_cutoff_index = imported?.cutoff_index || 0;
    scope.snapshot_post_import_pending_swipes = {};
    scope.snapshot_record_undo = null;
    scope.relationship_event_edits = Object.fromEntries(
        Object.entries(state.relationship_event_edits || {}).filter(([key]) => Number.parseInt(key, 10) < chatLength),
    );
    scope.snapshot_post_import_replay_keys = Object.fromEntries(
        Object.entries(state.replay_keys || {}).filter(([key]) => Number.parseInt(key, 10) < chatLength),
    );
    for (const key of ['char_bases', 'char_bases_romance', 'ignored_chars', 'platonic_chars', 'char_registry', 'merge_suggestions']) {
        scope[key] = key === 'char_registry' ? unpackRegistry(state[key], lineage) : copy(state[key], Array.isArray(state[key]) ? [] : {});
    }
    scope.log_cutoff_index = state.log_cutoff_index || 0;
    scope.global_log = [];
    lineage.current_baseline_id = state.baseline_id;
}

function addBaseline(lineage, scope) {
    if (!scope.snapshot_baseline) return null;
    const baseline = {
        baseline: copy(scope.snapshot_baseline, null),
        restore: copy(scope.snapshot_restore_state, null),
        cutoff_index: scope.snapshot_cutoff_index || 0,
    };
    packRegistry(baseline.restore?.char_registry, lineage);
    lineage.baselines.push(baseline);
    return lineage.baselines.length - 1;
}

function pruneBaselines(lineage) {
    const used = [...new Set(lineage.revisions.map(revision => revision.state.baseline_id).filter(id => id !== null))];
    const mapped = new Map(used.map((id, index) => [id, index]));
    lineage.baselines = used.map(id => lineage.baselines[id]);
    for (const revision of lineage.revisions) {
        if (revision.state.baseline_id !== null) revision.state.baseline_id = mapped.get(revision.state.baseline_id);
    }
    lineage.current_baseline_id = lineage.current_baseline_id === null ? null : mapped.get(lineage.current_baseline_id) ?? null;
    pruneAssets(lineage);
}

// SillyTavern copies current metadata but truncates messages when making a branch.
// Keep metadata revisions by message count so a branch can select its own past.
const anchorSwipe = (chat, chatLength) => chat?.[chatLength - 1]?.swipe_id ?? null;

export function ensureBranchState(scope, { integrity, chatLength, chat, isBranch = false }) {
    let lineage = scope.snapshot_lineage;
    const valid = lineage && Array.isArray(lineage.revisions) && lineage.revisions.length > 0 && Array.isArray(lineage.baselines)
        && lineage.revisions.every(revision => Number.isInteger(revision?.at) && revision.at >= 0
            && revision.state && (revision.state.baseline_id === null
                || (Number.isInteger(revision.state.baseline_id) && lineage.baselines[revision.state.baseline_id])));
    if (!valid) {
        if (lineage) scope.snapshot_branch_uncertain = true;
        lineage = { owner: integrity, baselines: [], revisions: [], assets: [], current_baseline_id: null, legacy_cutoff: chatLength };
        if (scope.snapshot_baseline) {
            const restore = scope.snapshot_restore_state;
            if (restore) {
                lineage.revisions.push({ at: 0, state: capture({ ...scope, ...restore, snapshot_post_import_replay_keys: {} }, null, lineage) });
            }
            const baselineId = addBaseline(lineage, scope);
            lineage.current_baseline_id = baselineId;
            lineage.revisions.push({ at: scope.snapshot_cutoff_index || 0, state: capture(scope, baselineId, lineage) });
        } else {
            lineage.revisions.push({ at: 0, state: capture(scope, null, lineage) });
        }
        scope.snapshot_lineage = lineage;
        if (isBranch && chatLength > 0) scope.snapshot_branch_uncertain = true;
        if (isBranch && scope.snapshot_baseline && (scope.snapshot_cutoff_index || 0) > chatLength) {
            if (lineage.revisions.length > 1) {
                apply(scope, lineage.revisions[0], lineage, chatLength);
                lineage.revisions = [lineage.revisions[0]];
                pruneBaselines(lineage);
            } else {
                scope.snapshot_baseline = null;
                scope.snapshot_restore_state = null;
                scope.snapshot_cutoff_index = 0;
                lineage.current_baseline_id = null;
                lineage.revisions = [{ at: 0, state: capture(scope, null, lineage) }];
                pruneBaselines(lineage);
                scope.snapshot_branch_uncertain = true;
            }
        }
        return true;
    }
    const compacted = compactLineage(lineage);
    if (!integrity || !lineage.owner || integrity === lineage.owner) return compacted;
    const eligible = lineage.revisions.filter(revision => revision.at < chatLength
        || (revision.at === chatLength && (revision.anchor_swipe_id === undefined
            || revision.anchor_swipe_id === anchorSwipe(chat, chatLength))));
    const selected = eligible.at(-1);
    if (selected) {
        apply(scope, selected, lineage, chatLength);
        lineage.revisions = eligible;
        pruneBaselines(lineage);
        if (chatLength < (lineage.legacy_cutoff || 0)) scope.snapshot_branch_uncertain = true;
    } else {
        scope.snapshot_baseline = null;
        scope.snapshot_restore_state = null;
        scope.snapshot_cutoff_index = 0;
        lineage.current_baseline_id = null;
        lineage.revisions = [{ at: 0, state: capture(scope, null, lineage) }];
        pruneBaselines(lineage);
        scope.snapshot_branch_uncertain = true;
    }
    lineage.owner = integrity;
    return true;
}

export function recordBranchState(scope, { integrity, chatLength, chat, baselineChanged = false }) {
    ensureBranchState(scope, { integrity, chatLength, chat });
    const lineage = scope.snapshot_lineage;
    if (baselineChanged) lineage.current_baseline_id = addBaseline(lineage, scope);
    const state = capture(scope, lineage.current_baseline_id, lineage);
    const previous = lineage.revisions.at(-1);
    const swipe = anchorSwipe(chat, chatLength);
    if (previous && previous.anchor_swipe_id === swipe && JSON.stringify(previous.state) === JSON.stringify(state)) return false;
    const revision = { at: chatLength, anchor_swipe_id: swipe, state };
    if (previous?.at === chatLength && previous.anchor_swipe_id === swipe) {
        lineage.revisions[lineage.revisions.length - 1] = revision;
        pruneAssets(lineage);
    }
    else lineage.revisions.push(revision);
    return true;
}
