import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const root = new URL('../modules/', import.meta.url);
async function harness() {
    const metadata = { integrity: 'parent' };
    const context = { chat: [], chatId: 'parent', name1: 'Player', substituteParams: text => text.replaceAll('{{user}}', 'Player') };
    const settings = { 'BB-Visual-Novel': {} };
    const sandbox = createContext({ Event, TextEncoder, console, setTimeout, clearTimeout,
        SillyTavern: { getContext: () => context }, window: {}, document: { querySelector: () => null }, jQuery: () => ({ val: () => null }) });
    const mocks = {
        '../../../../../script.js': { chat_metadata: metadata, saveChatDebounced() {}, setExtensionPrompt() {}, extension_prompt_roles: { SYSTEM: 0 }, extension_prompt_types: { IN_CHAT: 0 }, callPopup: async () => false },
        '../../../../extensions.js': { extension_settings: settings },
        './generator.js': { buildChoiceContextPrompt: () => '', getActiveChoiceContext: () => null, tryBindPendingChoiceContextToMessage: () => false },
        './toasts.js': { showStoryMomentToast() {}, notifySuccess() {}, notifyInfo() {}, notifyError() {}, pickToastMoment: (a, b) => b, getMomentToastPriority: () => 0 },
    };
    const cache = new Map();
    function load(name) {
        if (cache.has(name)) return cache.get(name);
        const values = mocks[name];
        const mod = values
            ? new SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context: sandbox })
            : new SourceTextModule(readFileSync(new URL(name, root), 'utf8'), { context: sandbox, identifier: name });
        cache.set(name, mod);
        return mod;
    }
    const social = load('./social.js');
    await social.link(load);
    await social.evaluate();
    return { api: social.namespace, metadata, context };
}

const snapshot = affinity => ({ schema_version: 1, module: 'BB-Visual-Novel', data: {
    characters: { Alex: { affinity, romance: 0, history: [], memories: { soft: [], deep: [], archive: [] }, core_traits: [] } },
    char_bases: { Alex: 0 }, char_bases_romance: {}, global_log: [], story_moments: [],
} });
const message = text => ({ name: 'Alex', mes: text, swipe_id: 0, extra: {} });
const recordsSource = readFileSync(new URL('../modules/snapshot-records.js', import.meta.url), 'utf8');
const { removeSnapshotRecord, undoSnapshotRecordRemoval } = await import(`data:text/javascript;base64,${Buffer.from(recordsSource).toString('base64')}`);

test('a new branch inherits the imported state active at its selected message', async () => {
    const parent = await harness();
    parent.context.chat.push(message('one'), message('two'));
    parent.api.recalculateAllStats(false);
    parent.api.importActivePersonaSnapshot(snapshot(25));
    parent.context.chat.push(message('three'), message('four'));
    parent.api.recalculateAllStats(false);
    parent.api.importActivePersonaSnapshot(snapshot(70));
    parent.context.chat.push(message('five'));
    parent.api.recalculateAllStats(false);

    async function branch(length) {
        const child = await harness();
        Object.assign(child.metadata, structuredClone(parent.metadata), { integrity: `branch-${length}`, main_chat: 'parent' });
        child.context.chatId = `branch-${length}`;
        child.context.chat = structuredClone(parent.context.chat.slice(0, length));
        child.api.recalculateAllStats(false);
        return child;
    }

    const before = await branch(1);
    assert.equal(before.api.bindActivePersonaState().scopeState.snapshot_baseline, null);
    const between = await branch(3);
    assert.equal(between.api.exportActivePersonaSnapshot().data.characters.Alex.affinity, 25);
    const after = await branch(5);
    assert.equal(after.api.exportActivePersonaSnapshot().data.characters.Alex.affinity, 70);
    assert.equal(parent.api.exportActivePersonaSnapshot().data.characters.Alex.affinity, 70);
});

test('removed snapshot characters stay removed after recalculation and can be restored', async () => {
    const h = await harness();
    h.context.chat.push(message('one'));
    h.api.importActivePersonaSnapshot(snapshot(25));
    const scope = h.api.bindActivePersonaState().scopeState;
    assert.equal(removeSnapshotRecord(scope, 'character', 'Alex'), true);
    h.api.recordActivePersonaBranchState(true);
    h.api.recalculateAllStats(false);
    assert.equal(h.api.exportActivePersonaSnapshot().data.characters.Alex, undefined);
    assert.equal(undoSnapshotRecordRemoval(scope), true);
    h.api.recordActivePersonaBranchState(true);
    h.api.recalculateAllStats(false);
    assert.equal(h.api.exportActivePersonaSnapshot().data.characters.Alex.affinity, 25);
});

test('removed snapshot log and moment entries stay removed after recalculation', async () => {
    const h = await harness();
    const imported = snapshot(25);
    imported.data.global_log = [{ time: '12:00', type: 'system', text: 'Old event' }];
    imported.data.story_moments = [{ title: 'Old moment', text: 'Earlier scene' }];
    h.api.importActivePersonaSnapshot(imported);
    const scope = h.api.bindActivePersonaState().scopeState;
    assert.equal(removeSnapshotRecord(scope, 'log', '0'), true);
    assert.equal(removeSnapshotRecord(scope, 'moment', '0'), true);
    h.api.recordActivePersonaBranchState(true);
    h.api.recalculateAllStats(false);
    const exported = h.api.exportActivePersonaSnapshot().data;
    assert.equal(exported.global_log.length, 0);
    assert.equal(exported.story_moments.length, 0);
});
