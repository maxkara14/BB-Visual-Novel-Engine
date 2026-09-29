import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(name) {
    const source = readFileSync(new URL(`../modules/${name}`, import.meta.url), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { ensureBranchState, recordBranchState } = await load('branch-state.js');
const { listSnapshotRecords, removeSnapshotRecord, undoSnapshotRecordRemoval } = await load('snapshot-records.js');

test('imported record labels expose readable content without journal markup', () => {
    const data = scope();
    data.snapshot_baseline = {
        characters: { Alex: { affinity: 25, romance: 5, status: 'Friend' } },
        global_log: [{ time: '12:00', text: '<div class="bb-glog-main"><span>Alex</span><span>Trust &amp; care</span></div><div>+5</div>' }],
        story_moments: [{ title: 'New feeling', text: 'Alex: calm &amp; warmth' }],
    };
    const records = listSnapshotRecords(data);
    assert.equal(records[0].detail, 'Friend · 🤝 25 · 💖 5');
    assert.equal(records[1].text, 'Alex Trust & care +5');
    assert.equal(records[1].detail, '12:00');
    assert.equal(records[2].text, 'Alex: calm & warmth');
    assert.ok(records.every(record => !record.text.includes('<')));
});

test('VNE journal entries separate character, mood, reason, and score changes', () => {
    const data = scope();
    data.snapshot_baseline = { global_log: [{ time: '23:10', text:
        '<div class="bb-glog-main"><span class="bb-glog-char">Мучиро Токито</span><span class="bb-glog-delta">растерянность, покой</span></div>'
        + '<div class="bb-glog-reason">Хару проявил заботу &amp; снял оковы.</div>'
        + '<div><div class="bb-glog-points">🤝 Доверие: +1</div><div class="bb-glog-points">💖 Влечение: +2</div></div>' }],
    };
    const [record] = listSnapshotRecords(data);
    assert.equal(record.title, 'Мучиро Токито');
    assert.equal(record.mood, 'растерянность, покой');
    assert.equal(record.reason, 'Хару проявил заботу & снял оковы.');
    assert.deepEqual(record.points, ['🤝 Доверие: +1', '💖 Влечение: +2']);
    assert.equal(record.detail, '23:10');
});

const scope = () => ({
    char_bases: { Alex: 3 }, char_bases_romance: {}, ignored_chars: [], platonic_chars: [],
    char_registry: {}, merge_suggestions: [], global_log: [], log_cutoff_index: 0,
    snapshot_baseline: null, snapshot_restore_state: null, snapshot_cutoff_index: 0,
    snapshot_post_import_replay_keys: {}, snapshot_post_import_pending_swipes: {},
});

test('branch selects the state at its message, preserving the parent', () => {
    const parent = scope();
    ensureBranchState(parent, { integrity: 'parent', chatLength: 0 });
    parent.snapshot_baseline = { characters: { Alex: { affinity: 25 } }, global_log: [], story_moments: [] };
    parent.snapshot_restore_state = { char_bases: { Alex: 3 }, char_bases_romance: {}, ignored_chars: [], platonic_chars: [], char_registry: {}, merge_suggestions: [], log_cutoff_index: 0 };
    parent.snapshot_cutoff_index = 4;
    recordBranchState(parent, { integrity: 'parent', chatLength: 4, baselineChanged: true });
    parent.snapshot_baseline = { characters: { Alex: { affinity: 70 } }, global_log: [], story_moments: [] };
    parent.snapshot_cutoff_index = 7;
    recordBranchState(parent, { integrity: 'parent', chatLength: 7, baselineChanged: true });

    const beforeImport = structuredClone(parent);
    ensureBranchState(beforeImport, { integrity: 'branch-before', chatLength: 2, isBranch: true });
    assert.equal(beforeImport.snapshot_baseline, null);
    assert.equal(beforeImport.char_bases.Alex, 3);
    assert.equal(beforeImport.snapshot_lineage.baselines.length, 0);

    const betweenImports = structuredClone(parent);
    ensureBranchState(betweenImports, { integrity: 'branch-between', chatLength: 5, isBranch: true });
    assert.equal(betweenImports.snapshot_baseline.characters.Alex.affinity, 25);
    assert.equal(betweenImports.snapshot_cutoff_index, 4);
    assert.equal(betweenImports.snapshot_lineage.baselines.length, 1);

    const afterSecondImport = structuredClone(parent);
    ensureBranchState(afterSecondImport, { integrity: 'branch-after', chatLength: 8, isBranch: true });
    assert.equal(afterSecondImport.snapshot_baseline.characters.Alex.affinity, 70);
    assert.equal(parent.snapshot_baseline.characters.Alex.affinity, 70);
});

test('snapshot entry removal and undo affect only the selected baseline record', () => {
    const data = scope();
    data.snapshot_baseline = {
        characters: { Alex: { affinity: 25 }, Bea: { affinity: 10 } },
        char_bases: { Alex: 3, Bea: 0 }, char_bases_romance: {},
        global_log: [{ text: 'First' }, { text: 'Second' }],
        story_moments: [{ title: 'Arrival' }, { title: 'Promise' }],
    };
    assert.equal(listSnapshotRecords(data).length, 6);
    assert.equal(removeSnapshotRecord(data, 'log', '0'), true);
    assert.deepEqual(data.snapshot_baseline.global_log.map(entry => entry.text), ['Second']);
    assert.equal(undoSnapshotRecordRemoval(data), true);
    assert.deepEqual(data.snapshot_baseline.global_log.map(entry => entry.text), ['First', 'Second']);
    assert.equal(removeSnapshotRecord(data, 'character', 'Alex'), true);
    assert.equal(data.snapshot_baseline.characters.Alex, undefined);
    assert.equal(data.snapshot_baseline.characters.Bea.affinity, 10);
    assert.equal(data.char_bases.Alex, undefined);
    assert.equal(undoSnapshotRecordRemoval(data), true);
    assert.equal(data.snapshot_baseline.characters.Alex.affinity, 25);
    assert.equal(data.char_bases.Alex, 3);
    assert.equal(removeSnapshotRecord(data, 'moment', '1'), true);
    assert.deepEqual(data.snapshot_baseline.story_moments.map(entry => entry.title), ['Arrival']);
});

test('a different selected swipe does not inherit a snapshot made from the original swipe', () => {
    const parent = scope();
    const chat = [{ swipe_id: 0 }, { swipe_id: 0 }, { swipe_id: 0 }];
    ensureBranchState(parent, { integrity: 'parent', chatLength: 0, chat });
    parent.snapshot_baseline = { characters: { Alex: { affinity: 25 } } };
    parent.snapshot_cutoff_index = 3;
    recordBranchState(parent, { integrity: 'parent', chatLength: 3, chat, baselineChanged: true });
    const child = structuredClone(parent);
    const changedSwipe = structuredClone(chat);
    changedSwipe[2].swipe_id = 1;
    ensureBranchState(child, { integrity: 'branch', chatLength: 3, chat: changedSwipe, isBranch: true });
    assert.equal(child.snapshot_baseline, null);
});
