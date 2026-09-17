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

async function harness({ custom = false, boot = false, fakeClock = false } = {}) {
    const calls = [];
    const rendered = [];
    const errors = [];
    const events = [];
    const timers = new Map();
    let timerId = 0;
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
        AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout, Error, TypeError,
        ...(fakeClock ? {
            setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
            clearTimeout: id => timers.delete(id),
        } : {}),
        console: { debug() {}, warn() {}, log() {}, error() {} },
        SillyTavern: { getContext: () => context },
        jQuery: arg => typeof arg === 'function' ? ready.push(arg) : button,
        HTMLTextAreaElement: class {},
        document: { querySelector: () => null },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        window: { dispatchEvent: event => events.push(event), setInterval: () => 1, renderVNOptionsFromData: (data, open) => {
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
        api: generator.namespace, state, context, calls, rendered, errors, settings, events,
        requests: cache.get('./requests.js').namespace,
        expire() { for (const callback of [...timers.values()]) callback(); },
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

test('main-model requests cannot overlap while cancellation is still settling', async () => {
    const h = await harness();
    const old = h.api.bbVnGenerateOptionsFlow();
    h.api.invalidateVnOptionsGeneration();
    await h.api.bbVnGenerateOptionsFlow();
    assert.equal(h.calls.length, 1);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /уже выполняет/);
    h.calls[0].reject(new Error('Old failure'));
    await old;
    const next = h.api.bbVnGenerateOptionsFlow();
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
    h.settings['BB-Visual-Novel'].allowMainFallback = true;
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

for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [400, 'request_rejected'], [404, 'request_rejected']]) {
    test(`HTTP ${status} is classified and never falls back even when fallback is enabled`, async () => {
        const h = await harness({ custom: true });
        h.settings['BB-Visual-Novel'].allowMainFallback = true;
        const run = h.api.generateFastPrompt('test');
        h.calls[0].resolve({ ok: false, status });
        await assert.rejects(run, { code });
        assert.equal(h.calls.length, 1);
    });
}

for (const [name, choice, code] of [
    ['empty', { message: { content: '' } }, 'empty'],
    ['reasoning only', { message: { reasoning_content: 'reasoning' } }, 'reasoning_only'],
    ['truncated', { finish_reason: 'length', message: { content: payload } }, 'truncated'],
    ['blocked', { finish_reason: 'content_filter', message: {} }, 'blocked'],
    ['refusal', { message: { refusal: 'no' } }, 'blocked'],
    ['unsupported content', { message: { content: {} } }, 'invalid_response'],
]) {
    test(`${name} response is classified and not applied or retried on another model`, async () => {
        const h = await harness({ custom: true });
        h.settings['BB-Visual-Novel'].allowMainFallback = true;
        const run = h.api.generateFastPrompt('test');
        h.calls[0].resolve({ ok: true, json: async () => ({ choices: [choice] }) });
        await assert.rejects(run, { code });
        assert.equal(h.calls.length, 1);
        assert.equal(h.events.filter(event => event.type === 'bb-vn-generation-source').length, 0);
    });
}

test('fallback is disabled by default and connection failures have a safe diagnostic', async () => {
    const h = await harness({ custom: true });
    const run = h.api.generateFastPrompt('test');
    h.calls[0].reject(new TypeError('Sensitive response details'));
    await assert.rejects(run, error => error.code === 'network' && !error.message.includes('Sensitive'));
    assert.equal(h.calls.length, 1);
});

test('incomplete Custom API configuration fails instead of silently using the main model', async () => {
    const h = await harness({ custom: true });
    h.settings['BB-Visual-Novel'].customApiModel = '';
    await assert.rejects(h.api.generateFastPrompt('test'), { code: 'configuration' });
    assert.equal(h.calls.length, 0);
});

test('custom timeout releases the UI even if the transport ignores cancellation', async () => {
    const h = await harness({ custom: true, fakeClock: true });
    const run = h.api.bbVnGenerateOptionsFlow();
    h.expire();
    await run;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.loading, false);
    assert.match(h.errors[0], /Время ожидания/);
    assert.equal(h.saves, 0);
    assert.equal(h.calls.length, 1);
});

test('main timeout stops its own request and releases UI without overlapping the unsettled transport', async () => {
    const h = await harness({ fakeClock: true });
    const run = h.api.bbVnGenerateOptionsFlow();
    h.expire();
    await run;
    assert.equal(h.stops, 1);
    assert.equal(h.loading, false);
    assert.match(h.errors[0], /Время ожидания/);
    h.respond(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.saves, 0);
    const next = h.api.bbVnGenerateOptionsFlow();
    h.respond(1);
    await next;
    assert.equal(h.saves, 1);
});

test('timeout includes waiting for the response body', async () => {
    const h = await harness({ custom: true, fakeClock: true });
    const run = h.api.generateFastPrompt('test');
    h.calls[0].resolve({ ok: true, json: () => new Promise(() => {}) });
    await new Promise(resolve => setImmediate(resolve));
    h.expire();
    await assert.rejects(run, { code: 'timeout' });
});

test('cancelling one utility request does not cancel another or stop Tavern', async () => {
    const h = await harness({ custom: true });
    const firstController = new AbortController();
    const first = h.api.generateFastPrompt('profile', { signal: firstController.signal });
    const second = h.api.generateFastPrompt('trait');
    firstController.abort();
    await assert.rejects(first, { code: 'cancelled' });
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls[1].signal.aborted, false);
    assert.equal(h.stops, 0);
    h.respond(1, 'Trait: description');
    assert.equal(await second, 'Trait: description');
});

test('cancellation before a utility request prevents both network and fallback calls', async () => {
    const h = await harness({ custom: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.api.generateFastPrompt('test', { signal: controller.signal }), { code: 'cancelled' });
    assert.equal(h.calls.length, 0);
});

test('successful requests report the actual source including fallback', async () => {
    const h = await harness({ custom: true });
    let run = h.api.generateFastPrompt('test');
    h.respond(0);
    await run;
    assert.match(h.events.find(event => event.type === 'bb-vn-generation-source').detail.source, /Custom API · test/);
    h.settings['BB-Visual-Novel'].allowMainFallback = true;
    run = h.api.generateFastPrompt('test');
    h.calls[1].resolve({ ok: false, status: 503 });
    await h.waitForCalls(3);
    h.respond(2);
    await run;
    assert.match(h.events.at(-1).detail.source, /резервная/);
});

test('request timeout setting is bounded and rejects invalid persisted values', async () => {
    const h = await harness();
    const normalize = h.requests.normalizeRequestTimeout;
    assert.equal(normalize(undefined), 120);
    assert.equal(normalize('nonsense'), 120);
    assert.equal(normalize(-10), 120);
    assert.equal(normalize(1), 15);
    assert.equal(normalize(900), 600);
    assert.equal(normalize('45'), 45);
});

test('trait cancellation reaches the transport and prevents text/repair retries', async () => {
    const h = await harness({ custom: true });
    const controller = new AbortController();
    const run = h.api.crystallizeTraitFromMemories({
        charName: 'Character', userName: 'User',
        memories: Array.from({ length: 5 }, (_, index) => ({ text: `Memory ${index}` })),
        signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(run, { code: 'cancelled' });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.stops, 0);
});

test('profile cancellation before source collection prevents generation', async () => {
    const h = await harness({ custom: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.api.generateCharacterDescription({ charName: 'Character', signal: controller.signal }), { code: 'cancelled' });
    assert.equal(h.calls.length, 0);
});
