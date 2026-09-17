import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

// Execute the actual generator/parser/state with only the Tavern and UI boundaries mocked.
// Run: node --experimental-vm-modules --test tests/generation-context.test.mjs
const root = new URL('../', import.meta.url);
const options = ['Открыть дверь', 'Задать вопрос', 'Подождать'].map((intent, index) => ({
    intent, message: `*Действие ${index}*`, tone: ['нежно', 'дерзко', 'холодно'][index], forecast: '', targets: [],
}));
const payload = JSON.stringify(options);

async function harness({ custom = false, boot = false } = {}) {
    const calls = [];
    const rendered = [];
    const errors = [];
    let saves = 0;
    let stops = 0;
    let loading = false;
    let persona = 'persona-a';
    const ready = [];
    const handlers = new Map();
    const settings = { 'BB-Visual-Novel': {
        useCustomApi: custom, customApiUrl: 'https://example.invalid/v1', customApiModel: 'test',
        emotionalChoiceFraming: false,
    } };
    const context = {
        chat: [{ name: 'Character', mes: 'Initial scene', swipe_id: 0 }],
        chatId: 'chat-a', characterId: 1, groupId: null,
        substituteParams: text => text,
        stopGeneration: () => { stops++; },
        event_types: Object.fromEntries([
            'APP_READY', 'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED',
            'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'GENERATION_STOPPED', 'GENERATE_AFTER_DATA', 'PERSONA_CHANGED',
        ].map(name => [name, name])),
        eventSource: { on: (event, handler) => {
            handlers.set(event, [...(handlers.get(event) || []), handler]);
        } },
    };
    function request(kind, signal) {
        return new Promise((resolve, reject) => calls.push({ kind, signal, resolve, reject }));
    }
    const button = { hasClass: () => loading, show() {}, hide() {} };
    const sandbox = createContext({
        AbortController, TextDecoder, Uint8Array,
        console: { debug() {}, warn() {}, log() {}, error() {} },
        SillyTavern: { getContext: () => context },
        jQuery: arg => typeof arg === 'function' ? ready.push(arg) : button,
        HTMLTextAreaElement: class {},
        document: { querySelector: () => null },
        CustomEvent: class {},
        window: { dispatchEvent() {}, setInterval: () => 1, renderVNOptionsFromData: (data, open) => {
            rendered.push({ data, open }); loading = false;
        } },
        fetch: (_url, init) => request('custom', init.signal),
    });
    const mocks = new Map([
        ['../../../../../script.js', {
            chat_metadata: {}, saveChatDebounced: () => { saves++; },
            generateQuietPrompt: () => request('main'),
        }],
        ['../../../../extensions.js', { extension_settings: settings }],
        ['./social.js', {
            injectCombinedSocialPrompt() {}, getCurrentPersonaScopeKey: () => persona,
            recalculateAllStats() {}, setRenderHudCallback() {}, getCombinedSocial: () => '',
            queueSnapshotReplayForGeneratedSwipe() {},
        }],
        ['./hud.js', {
            ensureHudContainer() {}, updateHudVisibility() {}, renderSocialHud() {}, openSocialHud() {}, closeSocialHud() {},
        }],
        ['./settings.js', { setupExtensionSettings() {}, wipeGlobalLog() {}, wipeAllSocialData() {}, injectDebugData() {} }],
        ['./actions.js', { injectVNActionsUI() {} }],
        ['./toasts.js', { notifyInfo() {}, notifyError: text => errors.push(text) }],
        ['./vn-ui.js', {
            resetVnOptionsContainer() {},
            setVnGenerateButtonIdle: () => { loading = false; },
            setVnGenerateButtonLoading: () => { loading = true; },
        }],
    ]);
    const cache = new Map();
    async function load(specifier) {
        specifier = specifier.replace('./modules/', './');
        if (specifier === '../../../extensions.js') specifier = '../../../../extensions.js';
        if (cache.has(specifier)) return cache.get(specifier);
        let module;
        if (mocks.has(specifier)) {
            const values = mocks.get(specifier);
            module = new SyntheticModule(Object.keys(values), function () {
                for (const [key, value] of Object.entries(values)) this.setExport(key, value);
            }, { context: sandbox });
        } else {
            const source = await readFile(new URL(`modules/${specifier}`, root), 'utf8');
            module = new SourceTextModule(source, { context: sandbox, identifier: specifier });
        }
        cache.set(specifier, module);
        await module.link(load);
        return module;
    }
    const generator = await load('./generator.js');
    await generator.evaluate();
    if (boot) {
        const entry = await load('../index.js');
        await entry.evaluate();
        for (const callback of ready) await callback();
    }
    const state = cache.get('./state.js').namespace;
    return {
        api: generator.namespace, state, context, calls, rendered, errors, settings,
        get saves() { return saves; }, get stops() { return stops; }, get loading() { return loading; },
        setPersona(value) { persona = value; },
        async emit(event) {
            assert.ok(handlers.has(event), `${event} is registered`);
            for (const handler of handlers.get(event)) await handler(0);
        },
        async waitForCalls(count) {
            for (let i = 0; i < 30 && calls.length < count; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(calls.length, count);
        },
        respond(index, content = payload) {
            const call = calls[index];
            call.resolve(call.kind === 'custom'
                ? { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
                : content);
        },
    };
}

test('valid result is saved to its original swipe and displayed', async () => {
    const h = await harness();
    const run = h.api.bbVnGenerateOptionsFlow();
    h.respond(0);
    await run;
    assert.equal(h.saves, 1);
    assert.equal(h.context.chat[0].extra.bb_vn_options_swipes[0].length, 3);
    assert.equal(h.rendered.length, 1);
    assert.equal(h.rendered[0].open, true);
    assert.equal(h.loading, false);
    assert.deepEqual(h.errors, []);
});

for (const [name, change] of [
    ['chat reference', h => { h.context.chat = [{ mes: 'Another scene' }]; }],
    ['chat identity with reused array', h => { h.context.chatId = 'chat-b'; }],
    ['character', h => { h.context.characterId = 2; }],
    ['group', h => { h.context.groupId = 2; }],
    ['persona', h => h.setPersona('persona-b')],
    ['swipe', h => { h.context.chat[0].swipe_id = 1; }],
    ['edited text', h => { h.context.chat[0].mes = 'Edited scene'; }],
    ['deleted message', h => { h.context.chat.pop(); }],
    ['replaced message', h => { h.context.chat[0] = { ...h.context.chat[0] }; }],
    ['new user message', h => { h.context.chat.push({ mes: 'My reply', is_user: true }); }],
]) {
    test(`late response is discarded after changed ${name}, even without an event`, async () => {
        const h = await harness();
        const original = h.context.chat[0];
        const run = h.api.bbVnGenerateOptionsFlow();
        change(h);
        h.respond(0);
        await run;
        assert.equal(h.saves, 0);
        assert.equal(original.extra, undefined);
        assert.equal(h.rendered.length, 0);
        assert.deepEqual(h.errors, []);
        assert.equal(h.loading, false);
    });
}

test('invalidation persists across a switch away and back', async () => {
    const h = await harness();
    const run = h.api.bbVnGenerateOptionsFlow();
    h.context.chat[0].swipe_id = 1;
    h.api.invalidateVnOptionsGeneration();
    h.context.chat[0].swipe_id = 0;
    h.respond(0);
    await run;
    assert.equal(h.stops, 1);
    assert.equal(h.saves, 0);
    assert.equal(h.rendered.length, 0);
});

test('cancelling a custom request does not stop Tavern; late cleanup preserves the next controller', async () => {
    const h = await harness({ custom: true });
    const old = h.api.bbVnGenerateOptionsFlow();
    await h.api.bbVnGenerateOptionsFlow(); // Same button cancels.
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.stops, 0);
    const next = h.api.bbVnGenerateOptionsFlow();
    const controller = h.state.vnGenerationAbortController;
    h.calls[0].reject(new Error('Late network error'));
    await old;
    assert.equal(h.state.vnGenerationAbortController, controller);
    assert.equal(h.loading, true);
    assert.equal(h.calls.length, 2); // No main-API fallback from the cancelled request.
    assert.deepEqual(h.errors, []);
    h.respond(1);
    await next;
    assert.equal(h.saves, 1);
    assert.equal(h.state.vnGenerationAbortController, null);
});

test('late failure from an old main request does not reset or notify over a new request', async () => {
    const h = await harness();
    const old = h.api.bbVnGenerateOptionsFlow();
    h.api.invalidateVnOptionsGeneration();
    const next = h.api.bbVnGenerateOptionsFlow();
    h.calls[0].reject(new Error('Old failure'));
    await old;
    assert.equal(h.loading, true);
    assert.deepEqual(h.errors, []);
    h.respond(1);
    await next;
    assert.equal(h.saves, 1);
});

for (const [name, initial] of [['repair', 'not json'], ['completion', JSON.stringify(options.slice(0, 1))]]) {
    test(`context change during ${name} prevents further requests and persistence`, async () => {
        const h = await harness();
        const run = h.api.bbVnGenerateOptionsFlow();
        h.respond(0, initial);
        await h.waitForCalls(2);
        h.setPersona('persona-b');
        h.respond(1, JSON.stringify(options.slice(1, 2)));
        await run;
        assert.equal(h.calls.length, 2);
        assert.equal(h.saves, 0);
        assert.equal(h.rendered.length, 0);
        assert.deepEqual(h.errors, []);
    });
}

test('a changed scene never falls back to the main model after a custom API failure', async () => {
    const h = await harness({ custom: true });
    const run = h.api.bbVnGenerateOptionsFlow();
    h.context.chatId = 'chat-b';
    h.calls[0].reject(new Error('Network failure'));
    await run;
    assert.equal(h.calls.length, 1);
    assert.equal(h.saves, 0);
    assert.deepEqual(h.errors, []);
});

test('unchanged scene can still use the existing main-model fallback', async () => {
    const h = await harness({ custom: true });
    const run = h.api.bbVnGenerateOptionsFlow();
    h.calls[0].reject(new Error('Network failure'));
    await h.waitForCalls(2);
    assert.equal(h.calls[1].kind, 'main');
    h.respond(1);
    await run;
    assert.equal(h.saves, 1);
});

for (const event of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'PERSONA_CHANGED']) {
    test(`Tavern ${event} handler invalidates a pending operation`, async () => {
        const h = await harness({ custom: true, boot: true });
        const run = h.api.bbVnGenerateOptionsFlow();
        await h.emit(event);
        assert.equal(h.calls[0].signal.aborted, true);
        h.respond(0);
        await run;
        assert.equal(h.saves, 0);
        assert.equal(h.rendered.length, 0);
        assert.equal(h.loading, false);
    });
}

test('cancelled reroll restores saved options without overwriting them', async () => {
    const h = await harness({ custom: true });
    h.context.chat[0].extra = { bb_vn_options_swipes: { 0: options } };
    const run = h.api.bbVnGenerateOptionsFlow();
    h.api.invalidateVnOptionsGeneration();
    h.respond(0);
    await run;
    assert.equal(h.saves, 0);
    assert.equal(h.context.chat[0].extra.bb_vn_options_swipes[0], options);
    assert.equal(h.rendered.length, 1);
    assert.equal(h.rendered[0].open, false);
});

test('context change during tone diversification discards the replacement set', async () => {
    const h = await harness();
    h.settings['BB-Visual-Novel'].emotionalChoiceFraming = true;
    const run = h.api.bbVnGenerateOptionsFlow();
    h.respond(0, JSON.stringify(options.map(option => ({ ...option, tone: 'нежно' }))));
    await h.waitForCalls(2);
    h.context.chat[0].swipe_id = 1;
    h.respond(1);
    await run;
    assert.equal(h.calls.length, 2);
    assert.equal(h.saves, 0);
    assert.equal(h.rendered.length, 0);
});
