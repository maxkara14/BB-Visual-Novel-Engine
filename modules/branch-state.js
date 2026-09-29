const copy = (value, fallback) => {
    try { return JSON.parse(JSON.stringify(value ?? fallback)); } catch { return fallback; }
};

function capture(scope, baselineId) {
    return {
        baseline_id: baselineId,
        char_bases: copy(scope.char_bases, {}),
        char_bases_romance: copy(scope.char_bases_romance, {}),
        ignored_chars: copy(scope.ignored_chars, []),
        platonic_chars: copy(scope.platonic_chars, []),
        char_registry: copy(scope.char_registry, {}),
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
        scope[key] = copy(state[key], Array.isArray(state[key]) ? [] : {});
    }
    scope.log_cutoff_index = state.log_cutoff_index || 0;
    scope.global_log = [];
    lineage.current_baseline_id = state.baseline_id;
}

function addBaseline(lineage, scope) {
    if (!scope.snapshot_baseline) return null;
    lineage.baselines.push({
        baseline: copy(scope.snapshot_baseline, null),
        restore: copy(scope.snapshot_restore_state, null),
        cutoff_index: scope.snapshot_cutoff_index || 0,
    });
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
        lineage = { owner: integrity, baselines: [], revisions: [], current_baseline_id: null, legacy_cutoff: chatLength };
        if (scope.snapshot_baseline) {
            const restore = scope.snapshot_restore_state;
            if (restore) {
                lineage.revisions.push({ at: 0, state: capture({ ...scope, ...restore, snapshot_post_import_replay_keys: {} }, null) });
            }
            const baselineId = addBaseline(lineage, scope);
            lineage.current_baseline_id = baselineId;
            lineage.revisions.push({ at: scope.snapshot_cutoff_index || 0, state: capture(scope, baselineId) });
        } else {
            lineage.revisions.push({ at: 0, state: capture(scope, null) });
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
                lineage.revisions = [{ at: 0, state: capture(scope, null) }];
                pruneBaselines(lineage);
                scope.snapshot_branch_uncertain = true;
            }
        }
        return true;
    }
    if (!integrity || !lineage.owner || integrity === lineage.owner) return false;
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
        lineage.revisions = [{ at: 0, state: capture(scope, null) }];
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
    const state = capture(scope, lineage.current_baseline_id);
    const previous = lineage.revisions.at(-1);
    const swipe = anchorSwipe(chat, chatLength);
    if (previous && previous.anchor_swipe_id === swipe && JSON.stringify(previous.state) === JSON.stringify(state)) return false;
    const revision = { at: chatLength, anchor_swipe_id: swipe, state };
    if (previous?.at === chatLength && previous.anchor_swipe_id === swipe) lineage.revisions[lineage.revisions.length - 1] = revision;
    else lineage.revisions.push(revision);
    return true;
}
