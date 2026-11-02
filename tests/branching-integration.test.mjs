import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const root = new URL('../modules/', import.meta.url);
async function harness() {
    let saves = 0;
    const metadata = { integrity: 'parent' };
    const context = { chat: [], chatId: 'parent', name1: 'Player', substituteParams: text => text.replaceAll('{{user}}', 'Player') };
    const settings = { 'BB-Visual-Novel': {} };
    const sandbox = createContext({ Event, TextEncoder, console, setTimeout, clearTimeout,
        SillyTavern: { getContext: () => context }, window: {}, document: { querySelector: () => null }, jQuery: () => ({ val: () => null }) });
    const mocks = {
        '../../../../../script.js': { chat_metadata: metadata, saveChatDebounced() { saves++; }, setExtensionPrompt() {}, extension_prompt_roles: { SYSTEM: 0 }, extension_prompt_types: { IN_CHAT: 0 }, callPopup: async () => false },
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
    return { api: social.namespace, metadata, context, settings: settings['BB-Visual-Novel'], saves: () => saves };
}

const snapshot = affinity => ({ schema_version: 1, module: 'BB-Visual-Novel', data: {
    characters: { Alex: { affinity, romance: 0, history: [], memories: { soft: [], deep: [], archive: [] }, core_traits: [] } },
    char_bases: { Alex: 0 }, char_bases_romance: {}, global_log: [], story_moments: [],
} });
const message = text => ({ name: 'Alex', mes: text, swipe_id: 0, extra: {} });
const recordsSource = readFileSync(new URL('../modules/snapshot-records.js', import.meta.url), 'utf8');
const { removeSnapshotRecord, undoSnapshotRecordRemoval } = await import(`data:text/javascript;base64,${Buffer.from(recordsSource).toString('base64')}`);
const recoverySourceCode = readFileSync(new URL('../modules/history-recovery.js', import.meta.url), 'utf8');
const { planRecovery, applyRecovery } = await import(`data:text/javascript;base64,${Buffer.from(recoverySourceCode).toString('base64')}`);

test('custom ten-point extremes rebuild deep memories and provide five memories per trait polarity', async () => {
    const h = await harness();
    h.settings.friendshipImpactValues = { life_changing: 10, unforgivable: -10 };
    for (const category of ['life_changing', 'unforgivable']) {
        for (let i = 0; i < 5; i++) {
            const msg = message(`Alex: ${category} event ${i}`);
            msg.extra.bb_social_swipes = { 0: [{ name: 'Alex', friendship_impact: category, romance_impact: 'none', reason: `${category} distinct memory ${i}`, debug_event: true }] };
            h.context.chat.push(msg);
        }
    }
    h.api.recalculateAllStats(false);
    const read = () => h.api.exportActivePersonaSnapshot().data;
    const stats = read().characters.Alex;
    assert.equal(stats.memories.deep.filter(m => m.tone === 'positive').length, 5);
    assert.equal(stats.memories.deep.filter(m => m.tone === 'negative').length, 5);
    assert.equal(stats.memories.soft.length, 0);
    assert.equal(stats.affinity, 0);
    assert.ok(read().story_moments.some(m => m.type === 'deep-positive'));
    assert.ok(read().story_moments.some(m => m.type === 'deep-negative'));
    h.api.recalculateAllStats(false);
    assert.equal(read().characters.Alex.memories.deep.length, 10);
    // The same stored trait record produced by the HUD consumes five of its polarity.
    const last = h.context.chat.at(-1);
    last.extra.bb_vn_char_traits_swipes = { 0: [{ charName: 'Alex', trait: 'Верность: Помнит поддержку.', type: 'positive', scope: h.api.getCurrentPersonaScopeKey() }] };
    h.api.recalculateAllStats(false);
    assert.equal(read().characters.Alex.core_traits.length, 1);
    assert.equal(read().characters.Alex.memories.archive.length, 5);
    assert.equal(read().characters.Alex.memories.deep.filter(m => m.tone === 'positive').length, 0);
    assert.equal(read().characters.Alex.memories.deep.filter(m => m.tone === 'negative').length, 5);
});

test('recovered romance extremes and aliases use categories; larger ordinary friendship does not hide them', async () => {
    const h = await harness();
    h.settings.friendshipImpactValues = { major_positive: 20 };
    h.settings.romanceImpactValues = { life_changing: 1 };
    h.context.chat.push(message('Alex shares a life-changing moment with Player.'));
    const state = h.api.bindActivePersonaState();
    applyRecovery(h.context.chat, planRecovery(h.context.chat, 0, 0, state), [{ index: 0, updates: [{ name: 'Alex', friendship_impact: 'major_positive', romance_impact: 'life_changing', reason: 'A new bond.', debug_event: true }] }], state.scopeKey, state.aliasSet);
    h.api.recalculateAllStats(false);
    let stats = h.api.exportActivePersonaSnapshot().data.characters.Alex;
    assert.equal(stats.memories.deep.length, 1);
    assert.equal(stats.memories.deep[0].delta, 1);
    assert.equal(stats.affinity, 20); assert.equal(stats.romance, 1);
    const update = h.context.chat[0].extra.bb_social_swipes[0][0];
    update.romance_impact = 'huge_positive';
    h.api.recalculateAllStats(false);
    assert.equal(h.api.exportActivePersonaSnapshot().data.characters.Alex.memories.deep.length, 1);
    h.api.bindActivePersonaState().scopeState.platonic_chars.push('Alex');
    h.api.recalculateAllStats(false);
    stats = h.api.exportActivePersonaSnapshot().data.characters.Alex;
    assert.equal(stats.memories.deep.length, 0);
    assert.equal(stats.memories.soft.length, 1);
});

test('ordinary categories stay soft while legacy numeric events retain the old deep threshold', async () => {
    const h = await harness();
    h.settings.friendshipImpactValues = { major_positive: 20, life_changing: 0 };
    for (const [name, impact] of [['Alex', 'major_positive'], ['Sam', '20'], ['Zero', 'life_changing']]) {
        const msg = message(`${name} interacts with Player.`);
        msg.extra.bb_social_swipes = { 0: [{ name, friendship_impact: impact, romance_impact: 'none', reason: `${name} unique event`, debug_event: true }] };
        h.context.chat.push(msg);
    }
    h.api.recalculateAllStats(false);
    const chars = h.api.exportActivePersonaSnapshot().data.characters;
    assert.equal(chars.Alex.memories.deep.length, 0); assert.equal(chars.Alex.memories.soft.length, 1);
    assert.equal(chars.Sam.memories.deep.length, 1);
    assert.equal(chars.Zero.memories.deep.length, 0);
});

test('recovered events survive recalculation, do not double count, and expire on source edits', async () => {
    const h = await harness();
    h.context.chat.push(message('Alex helps Player.'));
    const state = h.api.bindActivePersonaState();
    const plan = planRecovery(h.context.chat, 0, 0, state);
    applyRecovery(h.context.chat, plan, [{ index: 0, updates: [{ name: 'Alex', friendship_impact: 'minor_positive', romance_impact: 'none', reason: 'Alex helps Player.', role_dynamic: 'friend' }] }], state.scopeKey, state.aliasSet);
    h.api.recalculateAllStats(false);
    const first = h.api.exportActivePersonaSnapshot().data.characters.Alex.affinity;
    assert.ok(first > 0);
    h.api.recalculateAllStats(false);
    assert.equal(h.api.exportActivePersonaSnapshot().data.characters.Alex.affinity, first);
    assert.equal(planRecovery(h.context.chat, 0, 0, h.api.bindActivePersonaState()).pending.length, 0);
    h.context.chat[0].mes = 'Alex is absent.';
    h.api.recalculateAllStats(false);
    assert.equal(h.api.exportActivePersonaSnapshot().data.characters.Alex, undefined);
    assert.equal(planRecovery(h.context.chat, 0, 0, h.api.bindActivePersonaState()).pending.length, 1);
});

test('persona initialization does not save an empty chat over an existing file', async () => {
    const h = await harness();
    h.api.bindActivePersonaState();
    assert.equal(h.saves(), 0);
    h.context.chat.push(message('one'));
    delete h.metadata.integrity;
    h.api.recalculateAllStats(false);
    assert.equal(h.saves(), 0);
    const loaded = await harness();
    loaded.context.chat.push(message('one'));
    loaded.api.bindActivePersonaState();
    assert.ok(loaded.saves() > 0);
});

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
