import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
    const browserListeners = new Map();
    const logs = [];
    const timers = new Map();
    let timerId = 0;
    let saves = 0;
    let stops = 0;
    let loading = false;
    let persona = 'persona-a';
    const ready = [];
    const handlers = new Map();
    const profileState = { unavailable: false, profiles: [{ id: 'profile-a', name: 'Test Profile', model: 'profile-model' }] };
    function createNode(tag) {
        const listeners = new Map();
        return {
            tagName: tag, children: [], style: {}, isConnected: true,
            set innerHTML(_value) { throw new Error('HTML parsing is forbidden in model options'); },
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; },
            setAttribute(key, value) { this[key] = value; },
            addEventListener(event, callback) { listeners.set(event, callback); },
            emit(event) { return listeners.get(event)?.(); },
        };
    }
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
        console: Object.fromEntries(['debug', 'warn', 'log', 'error'].map(level => [level, (...args) => logs.push(args)])),
        SillyTavern: { getContext: () => context },
        jQuery: arg => typeof arg === 'function' ? ready.push(arg) : button,
        HTMLTextAreaElement: class {},
        document: { getElementById: () => null, querySelector: () => null, createElement: createNode },
        CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        window: { addEventListener: (name, callback) => browserListeners.set(name, callback), dispatchEvent: event => {events.push(event); browserListeners.get(event.type)?.(event);}, setInterval: () => 1, renderVNOptionsFromData: (data, open) => {
            rendered.push({ data, open }); loading = false;
        } },
        fetch: (_url, init) => { const pending = request('custom', init.signal); calls.at(-1).body = JSON.parse(init.body); return pending; },
    });
    const mocks = new Map([
        ['../../../shared.js', { ConnectionManagerRequestService: {
            getSupportedProfiles() {
                if (profileState.unavailable) throw new Error('Service disabled');
                return profileState.profiles;
            },
            validateProfile() { return { selected: profileState.backend || 'openai' }; },
            sendRequest(profileId, prompt, maxTokens, options, overridePayload) {
                const pending = request('profile', options.signal);
                Object.assign(calls.at(-1), { profileId, prompt, maxTokens, options, overridePayload });
                return pending;
            },
        } }],
        ['../../../../../script.js', {
            saveSettingsDebounced() {}, chat_metadata: {}, saveChatDebounced: () => { saves++; },
            generateQuietPrompt: args => { const pending = request('main'); calls.at(-1).args = args; return pending; },
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
    function getModule(specifier) {
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
            const source = readFileSync(new URL(`modules/${specifier}`, root), 'utf8');
            module = new SourceTextModule(source, {
                context: sandbox, identifier: specifier,
                importModuleDynamically: async name => {
                    const imported = await load(name);
                    if (imported.status !== 'evaluated') await imported.evaluate();
                    return imported;
                },
            });
        }
        cache.set(specifier, module);
        return module;
    }
    async function load(specifier) {
        const module = getModule(specifier);
        if (module.status === 'unlinked') await module.link(getModule);
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
        document: sandbox.document, window: sandbox.window, api: generator.namespace, state, context, calls, rendered, errors, settings, events, logs, profileState, createNode,
        connections: cache.get('./connections.js').namespace,
        async loadApi(name) {
            const module = await load(name);
            await module.evaluate();
            return module.namespace;
        },
        utils: cache.get('./utils.js').namespace,
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

test('model labels and values stay literal text, including markup and quotes', async () => {
    const h = await harness();
    const label = '<img src=x onerror=alert(1)> " & Model';
    const value = '"><script>test</script>';
    const option = h.utils.createTextOption(label, value);
    assert.equal(option.tagName, 'option');
    assert.equal(option.textContent, label);
    assert.equal(option.value, value);
    const ordinary = h.utils.createTextOption('normal-model', 'normal-model');
    assert.equal(ordinary.value, 'normal-model');
});

test('default malformed JSON diagnostics contain neither model text nor parser excerpts', async () => {
    const h = await harness();
    const run = h.api.bbVnGenerateOptionsFlow();
    h.respond(0, 'PRIVATE_SCENE_SENTINEL { damaged');
    await h.waitForCalls(2);
    h.respond(1);
    await run;
    assert.ok(h.logs.some(args => String(args[0]).includes('parse diagnostic')));
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE_SCENE_SENTINEL'), false);
    assert.equal(h.saves, 1);
});

test('opt-in diagnostics show response fragments but redact the configured key', async () => {
    const h = await harness();
    h.settings['BB-Visual-Novel'].debugGeneration = true;
    h.settings['BB-Visual-Novel'].customApiKey = 'test-secret-key';
    const run = h.api.bbVnGenerateOptionsFlow();
    h.respond(0, 'PRIVATE_SCENE_SENTINEL test-secret-key { damaged');
    await h.waitForCalls(2);
    h.respond(1);
    await run;
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE_SCENE_SENTINEL'), true);
    assert.equal(JSON.stringify(h.logs).includes('test-secret-key'), false);
});

test('debug redaction happens before a snippet boundary splits the key', async () => {
    const h = await harness();
    const text = 'x'.repeat(510) + 'secret-crosses-boundary' + 'x'.repeat(530);
    const diagnostic = h.utils.buildJsonDiagnostic(text, [], { includeText: true, secrets: ['secret-crosses-boundary'] });
    assert.equal(diagnostic.aroundError.includes('secret'), false);
    assert.equal(diagnostic.tail.includes('boundary'), false);
});

test('custom API health events contain an opaque identity, never the key or endpoint', async () => {
    const h = await harness({ custom: true });
    h.settings['BB-Visual-Novel'].customApiKey = 'test-secret-key';
    h.settings['BB-Visual-Novel'].customApiUrl = 'https://example.invalid/private-endpoint';
    const run = h.api.generateFastPrompt('test');
    h.respond(0);
    await run;
    const event = h.events.find(item => item.type === 'bb-vn-custom-api-health');
    assert.equal(typeof event.detail.connectionId, 'number');
    assert.equal(JSON.stringify(h.events).includes('test-secret-key'), false);
    assert.equal(JSON.stringify(h.events).includes('private-endpoint'), false);
    assert.equal(h.requests.getCustomApiIdentity('https://example.invalid/private-endpoint', 'test-secret-key'), event.detail.connectionId);
    assert.notEqual(h.requests.getCustomApiIdentity('https://example.invalid/private-endpoint', 'changed-key'), event.detail.connectionId);
});

function selectProfile(h) {
    Object.assign(h.settings['BB-Visual-Novel'], { vnGenerationSource: 'profile', vnConnectionProfileId: 'profile-a' });
}

test('profile options use the selected ID, preset and instruct without changing the active connection', async () => {
    const h = await harness();
    selectProfile(h);
    h.context.activeProfile = 'main-profile';
    const run = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(1);
    const call = h.calls[0];
    assert.equal(call.kind, 'profile');
    assert.equal(call.profileId, 'profile-a');
    assert.equal(call.options.stream, false);
    assert.equal(call.options.includePreset, true);
    assert.equal(call.options.includeInstruct, true);
    assert.equal(call.options.extractData, true);
    assert.equal(call.maxTokens, 5200);
    assert.equal(call.prompt[1].role, 'user');
    assert.match(call.prompt[1].content, /Initial scene/);
    call.resolve({ content: payload, reasoning: '' });
    await run;
    assert.equal(h.context.activeProfile, 'main-profile');
    assert.equal(h.stops, 0);
    assert.equal(h.saves, 1);
    assert.match(h.events.find(event => event.type === 'bb-vn-generation-source').detail.source, /Test Profile · profile-model/);
});

test('profile repair keeps the captured source even if settings are changed mid-request', async () => {
    const h = await harness();
    selectProfile(h);
    const run = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(1);
    h.settings['BB-Visual-Novel'].vnGenerationSource = 'main';
    h.settings['BB-Visual-Novel'].vnConnectionProfileId = 'profile-b';
    h.respond(0, 'broken json');
    await h.waitForCalls(2);
    assert.equal(h.calls[1].kind, 'profile');
    assert.equal(h.calls[1].profileId, 'profile-a');
    h.respond(1);
    await run;
    assert.equal(h.saves, 1);
});

test('profile completion also uses the selected profile', async () => {
    const h = await harness();
    selectProfile(h);
    const run = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(1);
    h.respond(0, JSON.stringify(options.slice(0, 1)));
    await h.waitForCalls(2);
    assert.equal(h.calls[1].profileId, 'profile-a');
    h.respond(1, JSON.stringify(options.slice(1)));
    await run;
    assert.equal(h.saves, 1);
});

for (const unavailable of [false, true]) {
    test(`${unavailable ? 'disabled service' : 'deleted profile'} fails without silently using the main model`, async () => {
        const h = await harness();
        selectProfile(h);
        if (unavailable) h.profileState.unavailable = true;
        else h.profileState.profiles = [];
        await h.api.bbVnGenerateOptionsFlow();
        assert.equal(h.calls.length, 0);
        assert.equal(h.errors.length, 1);
        assert.equal(h.loading, false);
    });
}

test('profile cancellation aborts its request without stopping Tavern', async () => {
    const h = await harness();
    selectProfile(h);
    const run = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(1);
    h.api.invalidateVnOptionsGeneration();
    await run;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.stops, 0);
    assert.equal(h.saves, 0);
});

test('profile timeout drops a late result and resets the options UI', async () => {
    const h = await harness({ fakeClock: true });
    selectProfile(h);
    const run = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(1);
    h.expire();
    await run;
    h.respond(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.loading, false);
    assert.equal(h.saves, 0);
    assert.match(h.errors[0], /Время ожидания/);
});

test('profile output containing only reasoning fails without repair', async () => {
    const h = await harness();
    selectProfile(h);
    const run = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(1);
    h.calls[0].resolve({ content: '', reasoning: 'Private reasoning' });
    await run;
    assert.match(h.errors[0], /только рассуждения/);
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(h.logs).includes('Private reasoning'), false);
});

test('legacy settings retain the custom source; explicit main overrides it for all generations', async () => {
    const h = await harness({ custom: true });
    assert.equal(h.connections.resolveVnGenerationSource(h.settings['BB-Visual-Novel']), 'custom');
    h.settings['BB-Visual-Novel'].vnGenerationSource = 'main';
    let run = h.api.bbVnGenerateOptionsFlow();
    assert.equal(h.calls[0].kind, 'main');
    h.respond(0);
    await run;
    run = h.api.generateFastPrompt('utility');
    assert.equal(h.calls[1].kind, 'main');
    h.respond(1);
    await run;
});

test('explicit custom source works without rewriting legacy settings', async () => {
    const h = await harness();
    h.settings['BB-Visual-Novel'].vnGenerationSource = 'custom';
    const run = h.api.bbVnGenerateOptionsFlow();
    assert.equal(h.calls[0].kind, 'custom');
    h.respond(0);
    await run;
    assert.equal(h.settings['BB-Visual-Novel'].useCustomApi, false);
});

test('profile UI safely renders names, preserves missing selection and saves changes', async () => {
    const h = await harness();
    const ui = await h.loadApi('./connection-ui.js');
    selectProfile(h);
    h.profileState.profiles[0].name = '<img onerror=alert(1)>';
    const root = h.createNode('div');
    let changes = 0;
    ui.mountVnConnectionControls(root, h.settings['BB-Visual-Novel'], () => { changes++; });
    await new Promise(resolve => setImmediate(resolve));
    const source = root.children[1];
    const block = root.children[2];
    const profiles = block.children[1];
    const refresh = block.children[2];
    const note = block.children[3];
    assert.equal(profiles.children[1].textContent, '<img onerror=alert(1)> · profile-model');
    assert.equal(profiles.value, 'profile-a');
    assert.equal(block.style.display, 'flex');
    h.profileState.profiles = [{ id: 'profile-b', name: 'Replacement' }];
    refresh.emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(profiles.value, 'profile-a');
    assert.match(note.textContent, /недоступен/);
    profiles.value = 'profile-b';
    profiles.emit('change');
    assert.equal(h.settings['BB-Visual-Novel'].vnConnectionProfileId, 'profile-b');
    source.value = 'main';
    source.emit('change');
    assert.equal(h.settings['BB-Visual-Novel'].vnGenerationSource, 'main');
    assert.equal(block.style.display, 'none');
    assert.equal(changes, 2);
});

test('disabled Connection Manager is explained in the profile selector', async () => {
    const h = await harness();
    const ui = await h.loadApi('./connection-ui.js');
    selectProfile(h);
    h.profileState.unavailable = true;
    const root = h.createNode('div');
    ui.mountVnConnectionControls(root, h.settings['BB-Visual-Novel'], () => {});
    await new Promise(resolve => setImmediate(resolve));
    const block = root.children[2];
    assert.equal(block.children[1].disabled, true);
    assert.match(block.children[3].textContent, /Connection Manager/);
    assert.equal(block.children[2].disabled, false);
});

test('scene change while the profile service is loading prevents the request', async () => {
    const h = await harness();
    selectProfile(h);
    const run = h.api.bbVnGenerateOptionsFlow();
    h.setPersona('persona-b');
    await run;
    assert.equal(h.calls.length, 0);
    assert.equal(h.saves, 0);
    assert.deepEqual(h.errors, []);
});

for (const mode of ['auto', 'schema', 'json', 'prompt']) {
    test(`custom output mode ${mode} reaches the provider`, async () => {
        const h = await harness({ custom: true });
        h.settings['BB-Visual-Novel'].vnJsonMode = mode;
        const run = h.api.bbVnGenerateOptionsFlow();
        const format = h.calls[0].body.response_format;
        assert.equal(format?.type, {auto:'json_schema',schema:'json_schema',json:'json_object'}[mode]);
        if (format?.json_schema) assert.equal(format.json_schema.schema.properties.options.minItems, 3);
        h.respond(0, JSON.stringify({options}));
        await run;
        assert.equal(h.saves, 1);
    });
}
test('Auto downgrades only confirmed format failures', async () => {
    const h = await harness({ custom: true });
    const run = h.api.bbVnGenerateOptionsFlow();
    for (let i = 0; i < 2; i++) {
        h.calls[i].resolve({ok:false,status:400,json:async()=>({error:{param:'response_format',code:'unsupported_value'}})});
        await h.waitForCalls(i + 2);
    }
    assert.equal(h.calls[1].body.response_format.type, 'json_object');
    assert.equal(h.calls[2].body.response_format, undefined);
    h.respond(2); await run;
    assert.equal(h.saves, 1);
    assert.equal(h.events.filter(e=>e.type==='bb-vn-generation-stage').at(-1).detail.requestNumber, 3);
});
for (const status of [400,401,429,500]) {
    test(`unconfirmed error ${status} does not downgrade`, async () => {
        const h = await harness({custom:true});
        const run = h.api.bbVnGenerateOptionsFlow();
        h.calls[0].resolve({ok:false,status,json:async()=>({error:{message:'Other failure'}})});
        await run; assert.equal(h.calls.length,1); assert.equal(h.saves,0);
    });
}
for (const content of ['{}','[]','```json\n{}\n```','{"options":[]}','null']) {
    test(`empty payload ${content} does not trigger repair`, async()=>{
        const h=await harness();const run=h.api.bbVnGenerateOptionsFlow();h.respond(0,content);
        await run;assert.equal(h.calls.length,1);assert.equal(h.saves,0);
    });
}
test('zero extra budget prevents repair and format retries',async()=>{
    for(const custom of [false,true]) {
        const h=await harness({custom});h.settings['BB-Visual-Novel'].vnMaxAdditionalRequests=0;
        const run=h.api.bbVnGenerateOptionsFlow();
        if(custom)h.calls[0].resolve({ok:false,status:422,json:async()=>({error:{message:'json_schema is not supported'}})});
        else h.respond(0,'broken json');
        await run;assert.equal(h.calls.length,1);assert.equal(h.saves,0);
    }
});
test('validator accepts wrappers and markdown, rejects bad types and duplicates',async()=>{
    const h=await harness();const api=await h.loadApi('./structured-output.js');
    for(const content of [payload,JSON.stringify({options}),'```json\n'+payload+'\n```'])assert.equal(api.parseVnOptions(content).options.length,3);
    const mixed=[null,{}, {intent:12,message:'text'}, {...options[0],targets:[3]},options[0],options[0],{...options[1],message:options[0].message}, options[2]];
    assert.equal(api.parseVnOptions(JSON.stringify(mixed)).options.length,2);
    assert.equal(api.parseVnOptions('[null,{}]').ok,false);
});
test('main Auto omits schema while explicit schema preserves invalid text',async()=>{
    for(const mode of ['auto','schema']) {
        const h=await harness();h.settings['BB-Visual-Novel'].vnJsonMode=mode;
        const run=h.api.bbVnGenerateOptionsFlow();
        assert.equal(h.calls[0].args.jsonSchema?.returnInvalid,mode==='schema'?true:undefined);
        h.respond(0);await run;assert.equal(h.saves,1);
    }
});
test('profile schema uses Tavern override payload without switching connection',async()=>{
    const h=await harness();Object.assign(h.settings['BB-Visual-Novel'],{vnGenerationSource:'profile',vnConnectionProfileId:'profile-a',vnJsonMode:'schema'});
    const run=h.api.bbVnGenerateOptionsFlow();await h.waitForCalls(1);
    assert.equal(h.calls[0].overridePayload.json_schema.strict,true);
    h.respond(0);await run;assert.equal(h.saves,1);
});
test('explicit JSON mode refuses unsupported main route before transport',async()=>{
    const h=await harness();h.settings['BB-Visual-Novel'].vnJsonMode='json';
    await h.api.bbVnGenerateOptionsFlow();assert.equal(h.calls.length,0);assert.equal(h.saves,0);assert.equal(h.errors.length,1);
});

test('all generation routes share the selected connection without rewriting legacy settings', async () => {
    for (const source of ['main', 'custom', 'profile']) {
        const h = await harness({ custom: source === 'main' });
        Object.assign(h.settings['BB-Visual-Novel'], { vnGenerationSource: source, vnConnectionProfileId: 'profile-a' });
        const before = JSON.stringify(h.settings);
        const run = h.api.generateFastPrompt('Generate character traits', {responseFormat:'text'});
        await h.waitForCalls(1);
        assert.equal(h.calls[0].kind, source);
        if (source === 'custom') assert.equal(h.calls[0].body.response_format, undefined);
        if (source === 'profile') assert.equal(h.calls[0].overridePayload.json_schema, undefined);
        h.respond(0, 'Character traits');
        assert.equal(await run, 'Character traits');
        assert.equal(JSON.stringify(h.settings), before);
    }
});
test('profile utility cancellation stays independent from VN generation', async () => {
    const h = await harness();
    selectProfile(h);
    const controller = new AbortController();
    const utility = h.api.generateFastPrompt('Character description', { signal: controller.signal, responseFormat:'text' });
    await h.waitForCalls(1);
    const vn = h.api.bbVnGenerateOptionsFlow();
    await h.waitForCalls(2);
    const rejected = assert.rejects(utility, error => error.code === 'cancelled');
    controller.abort();
    await rejected;
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls[1].signal.aborted, false);
    h.respond(1);
    await vn;
    assert.equal(h.saves, 1);
    assert.equal(h.stops, 0);
});
test('unavailable common profile fails utility generation without silently changing source', async () => {
    const h = await harness(); selectProfile(h); h.profileState.profiles = [];
    await assert.rejects(h.api.generateFastPrompt('Character traits'), error => error.code === 'profile_missing');
    assert.equal(h.calls.length, 0);
});
test('technical controls are collapsed and no separate utility connection is shown', async () => {
    const source = await readFile(new URL('modules/settings.js', root), 'utf8');
    const advanced = source.match(/<details id="bb-vn-advanced-settings">([\s\S]*?)<\/details>/);
    assert.ok(advanced);
    assert.ok(advanced[1].includes('id="bb-vn-cfg-json-mode"'));
    assert.ok(advanced[1].includes('id="bb-vn-cfg-extra-requests"'));
    assert.ok(!source.includes('bb-vn-cfg-usecustom'));
});

test('English options keep their labels and messages instead of Russian fallbacks', async () => {
    const h = await harness(); h.settings['BB-Visual-Novel'].outputLanguage = 'en';
    const run = h.api.bbVnGenerateOptionsFlow();
    assert.match(h.calls[0].args.quietPrompt, /Write newly generated human-readable text in English/);
    assert.doesNotMatch(h.calls[0].args.quietPrompt, /Write in Russian|SHORT_RUSSIAN|natural Russian/);
    const english = ['Open the door','Ask a question','Wait'].map((intent,i)=>({...options[i],intent,message:`*I take action ${i}.*`,tone:['gently','boldly','coldly'][i]}));
    h.respond(0, JSON.stringify(english)); await run;
    assert.equal(h.saves, 1);
    assert.equal(h.rendered[0].data[0].intent, 'Open the door');
    assert.equal(h.rendered[0].data[2].intent, 'Wait');
    assert.equal(h.rendered[0].data[0].message, english[0].message);
});
test('output language is independent of UI settings and preserves stored story data', async () => {
    const h = await harness(); const language = await h.loadApi('./language.js');
    const chat = [{mes:'Я жду у двери.',extra:{memories:['Верный друг'],name:'Алекс'}}];
    const before = JSON.stringify(chat);
    for(const [uiLanguage,outputLanguage,name] of [['ru','en','English'],['en','ru','Russian']]) {
        assert.match(language.buildOutputLanguageDirective({uiLanguage,outputLanguage},chat),new RegExp('text in '+name));
    }
    const auto = language.buildOutputLanguageDirective({outputLanguage:'chat'},chat);
    assert.match(auto,/language of the latest narrative/);
    assert.ok(auto.includes(chat[0].mes));
    assert.equal(JSON.stringify(chat),before);
});
test('Russian and English tone families match without rewriting stored tone text', async () => {
    const h = await harness();
    for(const [ru,en] of [['нежно','gently'],['холодно','coldly'],['иронично','ironically'],['дерзко','boldly'],['опасно','dangerously']]) {
        assert.equal(h.utils.getToneClass(ru),h.utils.getToneClass(en));
        assert.equal(h.utils.normalizeOptionData({...options[0],tone:ru}).tone,ru);
        assert.equal(h.utils.normalizeOptionData({...options[0],tone:en}).tone,en);
    }
    assert.equal(h.utils.sanitizeIntentLabel('Ask a question'),'Ask a question');
    assert.equal(h.utils.sanitizeIntentLabel('Подождать'),'Подождать');
    assert.notEqual(h.utils.sanitizeIntentLabel('ACTION_LABEL'),'ACTION LABEL');
});
test('English character profile prompt preserves source facts and uses selected language', async () => {
    const h = await harness(); h.settings['BB-Visual-Novel'].outputLanguage='en';
    const run = h.api.generateCharacterDescription({charName:'Alex',currentDescription:'Верный друг',stats:{}});
    await h.waitForCalls(1);
    const prompt=h.calls[0].args.quietPrompt;
    assert.match(prompt,/Build a complete character profile/);
    assert.match(prompt,/Верный друг/);
    assert.match(prompt,/Translate the field labels/);
    assert.match(prompt,/text in English/);
    h.respond(0,'Name: Alex\n'+ 'Background: A loyal friend who has lived here for years. '.repeat(5));
    assert.match(await run,/Name: Alex/);
});
test('trait retry and repair instructions are English and carry output language', async () => {
    const h=await harness();h.settings['BB-Visual-Novel'].outputLanguage='ru';
    const run=h.api.crystallizeTraitFromMemories({charName:'Alex',userName:'Player',memories:Array.from({length:5},()=>({text:'An important shared event'}))});
    for(let i=0;i<3;i++) {
        await h.waitForCalls(i+1);
        const prompt=h.calls[i].args.quietPrompt;
        assert.match(prompt,/text in Russian/);
        assert.doesNotMatch(prompt,/[А-Яа-яЁё]/);
        h.respond(i,'invalid');
    }
    await h.waitForCalls(4);
    assert.match(h.calls[3].args.quietPrompt,/Convert this draft to ONE line/);
    assert.match(h.calls[3].args.quietPrompt,/text in Russian/);
    h.respond(3,'Верность: Всегда поддерживает друга в трудные моменты.');
    assert.match(await run,/^Верность:/);
});
test('VN repair keeps the language captured at operation start', async () => {
    const h=await harness();h.settings['BB-Visual-Novel'].outputLanguage='en';
    const run=h.api.bbVnGenerateOptionsFlow();h.respond(0,'broken');
    h.settings['BB-Visual-Novel'].outputLanguage='ru';
    await h.waitForCalls(2);
    assert.match(h.calls[1].args.quietPrompt,/text in English/);
    assert.doesNotMatch(h.calls[1].args.quietPrompt,/original Russian/);
    h.respond(1);await run;assert.equal(h.saves,1);
});

test('UI language resolves independently from output language and has a predictable Auto mode', async () => {
    const h = await harness(); const api = await h.loadApi('./i18n.js');
    assert.equal(api.getUiLanguage({uiLanguage:'auto'},'ru-RU'),'ru');
    assert.equal(api.getUiLanguage({uiLanguage:'auto'},'en-US'),'en');
    assert.equal(api.getUiLanguage({uiLanguage:'auto'},'de-DE'),'en');
    assert.equal(api.getUiLanguage({uiLanguage:'ru',outputLanguage:'en'},'en-US'),'ru');
    assert.equal(api.getUiLanguage({uiLanguage:'en',outputLanguage:'ru'},'ru-RU'),'en');
});
test('localization translates static markup without touching dynamic names or escaping', async () => {
    const h=await harness();const api=await h.loadApi('./i18n.js');
    const stored={name:'Связь',memory:'Память',trait:'Светлая черта',reply:'Открыть дверь'};
    const before=JSON.stringify(stored);
    h.settings['BB-Visual-Novel'].uiLanguage='en';
    assert.equal(api.ui`<b>Персонаж</b>: ${stored.name}; ${stored.memory}; ${stored.trait}; ${stored.reply}`,'<b>Character</b>: Связь; Память; Светлая черта; Открыть дверь');
    const unsafe='Связь <img src=x onerror=alert(1)>';
    const safe=h.utils.escapeHtml(unsafe);
    assert.equal(api.ui`<span title="${safe}">Сцена: ${safe}</span>`,`<span title="${safe}">Scene: ${safe}</span>`);
    assert.equal(JSON.stringify(stored),before);
    h.settings['BB-Visual-Novel'].uiLanguage='ru';
    assert.equal(api.ui`<b>Персонаж</b>: ${stored.name}`,'<b>Персонаж</b>: Связь');
});
test('English UI profile control keeps Russian profile names and saves the same IDs', async () => {
    const h=await harness();h.settings['BB-Visual-Novel'].uiLanguage='en';selectProfile(h);
    h.profileState.profiles[0].name='Связь';
    const api=await h.loadApi('./connection-ui.js');const root=h.createNode('div');
    const controls=api.mountVnConnectionControls(root,h.settings['BB-Visual-Novel'],()=>{});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(root.children[0].textContent,'Generation connection');
    const block=root.children[2];
    assert.equal(block.children[0].textContent,'Connection profile');
    assert.ok(block.children[1].children.some(option=>option.textContent.includes('Связь')));
    assert.equal(block.children[1].value,'profile-a');
    assert.equal(typeof controls.sync,'function');
});
test('English error messages retain codes and cancellation remains recognizable', async () => {
    const h=await harness();h.settings['BB-Visual-Novel'].uiLanguage='en';
    const error=new h.requests.VnRequestError('cancelled');
    assert.equal(error.code,'cancelled');assert.equal(error.message,'Cancelled by user');
    assert.equal(h.api.isVnGenerationAbortError(error),true);
    assert.match(new h.requests.VnRequestError('timeout').message,/timed out/);
});
test('local profile templates follow output language rather than interface language', async () => {
    const h=await harness();const api=await h.loadApi('./i18n.js');
    Object.assign(h.settings['BB-Visual-Novel'],{uiLanguage:'ru',outputLanguage:'en'});
    assert.equal(api.template`Имя: ${'Память'}.`,'Name: Память.');
    Object.assign(h.settings['BB-Visual-Novel'],{uiLanguage:'en',outputLanguage:'ru'});
    assert.equal(api.template`Имя: ${'Memory'}.`,'Имя: Memory.');
    assert.equal(api.getTemplateLanguage({outputLanguage:'chat'},[{mes:'Я жду.'}]),'ru');
    assert.equal(api.getTemplateLanguage({outputLanguage:'chat'},[{mes:'I wait.'}]),'en');
});
test('English catalogue preserves interpolation tokens and distinct full messages', async () => {
    const h=await harness();const {EN}=await h.loadApi('./locales/en.js');const api=await h.loadApi('./i18n.js');
    for(const [key,value] of Object.entries(EN)) {
        assert.deepEqual((key.match(/\{\w+\}/g)||[]).sort(),(value.match(/\{\w+\}/g)||[]).sort(),key);
        assert.equal(api.t(key,'en'),value,key);
        assert.equal(api.t(key,'ru'),key,key);
    }
    assert.equal(api.t('Непереводимое слово','en'),'Непереводимое слово');
});
test('opposite UI and generation languages work through request, validation, and saving', async () => {
    for(const [uiLanguage,outputLanguage,intents,languageName] of [
        ['ru','en',['Open the door','Ask a question','Wait'],'English'],
        ['en','ru',['Открыть дверь','Задать вопрос','Подождать'],'Russian'],
    ]) {
        const h=await harness();Object.assign(h.settings['BB-Visual-Novel'],{uiLanguage,outputLanguage});
        const run=h.api.bbVnGenerateOptionsFlow();
        assert.match(h.calls[0].args.quietPrompt,new RegExp('text in '+languageName));
        h.respond(0,JSON.stringify(options.map((option,i)=>({...option,intent:intents[i]}))));
        await run;assert.equal(h.saves,1);assert.equal(h.rendered[0].data[0].intent,intents[0]);
    }
});

test('Auto interface language follows the installed Tavern locale accessor', async () => {
    const h=await harness();const api=await h.loadApi('./i18n.js');
    h.context.getCurrentLocale=()=> 'en-US';assert.equal(api.getUiLanguage({uiLanguage:'auto'}),'en');
    h.context.getCurrentLocale=()=> 'ru-RU';assert.equal(api.getUiLanguage({uiLanguage:'auto'}),'ru');
    assert.equal(api.getUiLanguage({uiLanguage:'en'}),'en');
});

test('social diagnostics translate system text while preserving macro and character names',async()=>{
 const h=await harness();const api=await h.loadApi('./i18n.js');
 h.settings['BB-Visual-Novel'].uiLanguage='en';
 const message='Режим макроса активен. Прямой {{bb_vn}} в generate_data не найден, возможно он уже был развёрнут пресетом ранее.';
 assert.equal(api.t(message),'Macro mode is active. No literal {{bb_vn}} was found in generate_data; the preset may have already expanded it.');
 const name='Связь';
 assert.equal(api.ui`Отброшены сомнительные обновления: ${name}`,'Skipped questionable updates: Связь');
 h.settings['BB-Visual-Novel'].uiLanguage='ru';assert.equal(api.t(message),message);
});

test('custom token limit normalizes input and settings handler saves it',async()=>{
 const h=await harness();const normalize=h.requests.normalizeCustomApiMaxTokens;
 for(const [input,expected] of [[undefined,0],['',0],[-1,0],['bad',0],[Infinity,0],[1,256],[8192.4,8192],[999999,131072]])assert.equal(normalize(input),expected);
 const source=await readFile(new URL('modules/settings.js',root),'utf8');
 const body=source.match(/jQuery\('#bb-vn-cfg-max-tokens'\)\.on\('change', function\(\) \{([\s\S]*?)\n    \}\);/)[1];
 let value='16384',saved=0;
 const jq=()=>({val(next){if(next!==undefined)value=next;return value;}});
 new Function('jQuery','normalizeCustomApiMaxTokens','extension_settings','MODULE_NAME','saveSettingsDebounced',body).call({},jq,normalize,h.settings,'BB-Visual-Novel',()=>saved++);
 assert.equal(h.settings['BB-Visual-Novel'].customApiMaxTokens,16384);assert.equal(value,16384);assert.equal(saved,1);
 assert.ok(source.includes('normalizeCustomApiMaxTokens(s.customApiMaxTokens)'));
});
test('custom requests use the exact configured budget and preserve automatic budgets',async()=>{
 const h=await harness({custom:true});
 for(const [setting,length,expected] of [[undefined,1000,4000],[0,6000,6000],[16384,1000,16384],[512,6000,512]]){
  h.settings['BB-Visual-Novel'].customApiMaxTokens=setting;
  const index=h.calls.length;const run=h.api.generateFastPrompt('Generate',{responseLength:length});
  assert.equal(h.calls[index].body.max_tokens,expected);h.respond(index);await run;
 }
});
test('custom token budget does not override main or profile budgets',async()=>{
 const h=await harness();h.settings['BB-Visual-Novel'].customApiMaxTokens=16384;
 const main=h.api.generateFastPrompt('Generate',{responseLength:1200});
 assert.equal(h.calls[0].args.responseLength,1200);h.respond(0);await main;
 selectProfile(h);const profile=h.api.generateFastPrompt('Generate',{responseLength:1800});
 await h.waitForCalls(2);assert.equal(h.calls[1].maxTokens,1800);h.respond(1);await profile;
});

test('character navigation filters Unicode names and sorts without changing data',async()=>{
 const h=await harness();const api=await h.loadApi('./character-toolbar.js');
 const stats={'Темари':{affinity:0,romance:3},'Алекс':{affinity:-4,romance:7},'Alex 10':{affinity:2},'Alex 2':{affinity:2}};
 const before=JSON.stringify(stats);
 assert.deepEqual([...api.selectCharacterNames(stats,'  ТЕМ  ','name','ru')],['Темари']);
 assert.deepEqual([...api.selectCharacterNames(stats,'Ａｌｅｘ','name','en')],['Alex 2','Alex 10']);
 assert.equal(api.selectCharacterNames(stats,'','trust_asc','ru')[0],'Алекс');
 assert.equal(api.selectCharacterNames(stats,'','romance_desc','ru')[0],'Алекс');
 assert.equal(api.selectCharacterNames(stats,'','bad','en')[0],'Alex 2');
 assert.equal(api.selectCharacterNames(stats,'missing').length,0);
 assert.equal(JSON.stringify(stats),before);
});
test('toolbar reorders existing cards, preserves drafts, saves preferences and resets search per scene',async()=>{
 const h=await harness();const api=await h.loadApi('./character-toolbar.js');
 function node(tag){return {tag,children:[],listeners:{},dataset:{},classList:{toggle(){}},append(...items){for(const item of items){this.children=this.children.filter(old=>old!==item);this.children.push(item);}},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn;},focus(){}};}
 const doc={createElement:node};
 const stats={Alex:{affinity:2},Blair:{affinity:5}};const settings={};const context={chat:[],chatId:'toolbar-chat'};let saves=0;
 function mount(persona='A'){
  const cards=Object.keys(stats).map(name=>Object.assign(node('card'),{dataset:{char:name},draft:'Unsaved text'}));
  const stack=node('stack');stack.append(...cards);stack.querySelectorAll=()=>cards;
  const root={ownerDocument:doc,children:[],querySelector:()=>stack,insertBefore(item){this.children.push(item);}};
  api.mountCharacterToolbar(root,stats,settings,context,persona,()=>saves++);
  const toolbar=root.children[0];return {cards,stack,search:toolbar.children[0].children[0],sort:toolbar.children[1].children[0],compact:toolbar.children[2].children[0],reset:toolbar.children[3],count:toolbar.children[4],empty:root.children[1]};
 }
 let view=mount();assert.equal(view.stack.children[0].dataset.char,'Blair');
 view.search.value='Alex';view.search.listeners.input();assert.equal(view.cards[1].hidden,true);assert.equal(view.cards[0].draft,'Unsaved text');
 view.sort.value='name';view.sort.listeners.change();assert.equal(settings.hudCharacterSort,'name');
 view.compact.checked=true;view.compact.listeners.change();assert.equal(settings.hudCompactCards,true);assert.equal(saves,2);
 view=mount();assert.equal(view.search.value,'Alex');assert.equal(view.compact.checked,true);
 view=mount('B');assert.equal(view.search.value,'');
 view.search.value='Nobody';view.search.listeners.input();assert.equal(view.empty.hidden,false);
 view.reset.listeners.click();assert.equal(view.search.value,'');assert.equal(view.empty.hidden,true);
 context.chat=[];view=mount();assert.equal(view.search.value,'');
 const many=Object.fromEntries(Array.from({length:500},(_,i)=>['Character '+i,{affinity:i%100}]));
 assert.equal(api.selectCharacterNames(many,'','name','en').length,500);
});


test('persistent preferences reach all option sources with guidance, language and SD', async () => {
    for (const source of ['main', 'custom', 'profile']) {
        const h = await harness();
        Object.assign(h.settings['BB-Visual-Novel'], {
            vnGenerationSource: source, vnConnectionProfileId: 'profile-a',
            vnUserInstructions: '  Prefer concise dialogue.  ', outputLanguage: 'ru',
        });
        h.window.bbGetSceneDirectorPrompt = () => 'SCENE_DIRECTOR_TEST_CONTEXT';
        const run = h.api.bbVnGenerateOptionsFlow({ guidance: 'This time stay silent.', mode: 'guided' });
        await h.waitForCalls(1);
        const call = h.calls[0];
        const prompt = source === 'custom' ? call.body.messages[1].content : source === 'profile' ? call.prompt : call.args.quietPrompt;
        const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        assert.match(text, /Prefer concise dialogue/);
        assert.match(text, /This time stay silent/);
        assert.match(text, /takes precedence where they conflict/);
        assert.match(text, /SCENE_DIRECTOR_TEST_CONTEXT/);
        assert.match(text, /Write newly generated human-readable text in Russian/);
        assert.match(text, /exactly 3 option objects/);
        h.respond(0); await run;
        assert.equal(h.rendered.length, 1);
    }
});

test('empty preferences preserve default prompts and utility prompts remain unaffected', async () => {
    const h = await harness();
    h.settings['BB-Visual-Novel'].vnUserInstructions = '   ';
    let run = h.api.bbVnGenerateOptionsFlow();
    assert.doesNotMatch(h.calls[0].args.quietPrompt, /PERSISTENT USER PREFERENCES/);
    h.respond(0); await run;
    h.settings['BB-Visual-Novel'].vnUserInstructions = 'UNIQUE_OPTION_PREFERENCE';
    run = h.api.generateFastPrompt('Utility request');
    assert.doesNotMatch(h.calls[1].args.quietPrompt, /UNIQUE_OPTION_PREFERENCE/);
    h.respond(1); await run;
});

test('preferences settings save plain text and clear via the same input handler', async () => {
    const source = await readFile(new URL('modules/settings.js', root), 'utf8');
    const extract = (id, event) => source.split("jQuery('#" + id + "').on('" + event + "', function() {")[1].split('    });')[0];
    const settings = {'BB-Visual-Novel': {}};
    let value = '</textarea><img onerror=alert(1)>'; let saves = 0;
    const field = { val(next) { if (arguments.length) {value = next; return this;} return value; }, trigger() { input(); } };
    const jq = () => field;
    const input = () => new Function('jQuery','extension_settings','MODULE_NAME','saveSettingsDebounced', extract('bb-vn-cfg-instructions','input'))(jq,settings,'BB-Visual-Novel',()=>saves++);
    input(); assert.equal(settings['BB-Visual-Novel'].vnUserInstructions,value);
    new Function('jQuery',extract('bb-vn-cfg-instructions-clear','click'))(jq);
    assert.equal(value,''); assert.equal(settings['BB-Visual-Novel'].vnUserInstructions,''); assert.equal(saves,2);
    value = 'a'.repeat(5000); input(); assert.equal(settings['BB-Visual-Novel'].vnUserInstructions.length,4000);
    assert.ok(source.includes("jQuery('#bb-vn-cfg-instructions').val(s.vnUserInstructions || '')"));
});


test('settings containers retain column layout independently of snapshot buttons', async () => {
    const css = (await readFile(new URL('style.css', root), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const find = selector => rules.filter(([, selectors]) => selectors.split(',').some(s => s.trim() === selector));
    for (const name of ['card', 'panel']) {
        const rules = find('#bb-social-settings-wrapper .bb-vn-settings-' + name);
        assert.ok(rules.some(([, , body]) => /display: flex/.test(body) && /flex-direction: column/.test(body) && /text-align: left/.test(body)));
        assert.ok(rules.every(([, , body]) => !/text-align: center/.test(body)));
    }
    const buttons = find('#bb-social-settings-wrapper .bb-vn-settings-card--snapshot .bb-vn-settings-button');
    assert.ok(buttons.some(([, , body]) => /max-width: 100%/.test(body) && /white-space: normal/.test(body)));
});


test('settings groups are balanced, keep controls accessible, and only gameplay starts open', async () => {
    const source = await readFile(new URL('modules/settings.js', root), 'utf8');
    const template = source.slice(source.indexOf('const settingsHtml'), source.indexOf('const target = document.querySelector'));
    const stack = [], groups = [], ids = new Map();
    for (const match of template.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
        const [tag, closing, name] = match;
        if (closing) { assert.equal(stack.pop()?.name, name, tag); continue; }
        const group = tag.match(/data-section="([^"]+)"/)?.[1];
        if (group) groups.push({name: group, open: /\sopen[\s>]/.test(tag)});
        const id = tag.match(/\sid="([^"]+)"/)?.[1];
        if (id) { assert.ok(!ids.has(id), id); ids.set(id, stack.findLast(node => node.group)?.group); }
        if (!['input','hr','br'].includes(name)) stack.push({name, group});
    }
    assert.equal(stack.length, 0);
    assert.deepEqual(groups.map(g => g.name), ['game','answers','connection','relationships','data','debug']);
    assert.deepEqual(groups.filter(g => g.open).map(g => g.name), ['game']);
    for (const [id, group] of Object.entries({
        'bb-vn-cfg-autosend':'game', 'bb-vn-cfg-instructions':'answers',
        'bb-vn-connection-controls':'connection','bb-vn-cfg-disable-tracker':'relationships',
        'bb-social-export-btn':'data','bb-dbg-add-pts':'debug',
    })) assert.equal(ids.get(id),group);
});


test('settings animation opens, closes, reverses rapid clicks and leaves natural height', async () => {
    const h = await harness(); const api = await h.loadApi('./settings-animation.js');
    let click; const animations = [];
    const section = { open: false, style: {overflow:''},
        querySelector: () => ({addEventListener: (_event, fn) => {click = fn;}}),
        getBoundingClientRect() { return {height: this.open ? 300 : 50}; },
        animate(frames, timing) { const a = {frames, timing, cancel() {this.cancelled=true;}}; animations.push(a); return a; },
    };
    const root = {querySelectorAll: () => [section]};
    api.mountSettingsAnimations(root); const originalClick=click; api.mountSettingsAnimations(root); assert.equal(click,originalClick);
    const press = () => click({preventDefault(){}});
    press(); assert.equal(section.open,true); assert.equal(animations[0].frames[1].height,'300px');
    animations[0].onfinish(); assert.equal(section.style.overflow,'');
    press(); assert.equal(section.open,true); assert.equal(animations[1].frames[1].height,'50px');
    press(); assert.equal(animations[1].cancelled,true); assert.equal(animations[1].onfinish,null);
    animations[2].onfinish(); assert.equal(section.open,true);
    press(); animations[3].onfinish(); assert.equal(section.open,false); assert.equal(section.style.overflow,'');
    assert.equal(section.style.height,undefined);
    section.animate = undefined; press(); assert.equal(section.open,true);
});


test('reduced motion switches sections without starting an animation', async () => {
    const source = await readFile(new URL('modules/settings-animation.js',root),'utf8');
    const module = new SourceTextModule(source, {context:createContext({matchMedia:()=>({matches:true})})});
    await module.link(()=>{}); await module.evaluate();
    let click;
    const section = {open:false,style:{overflow:''},querySelector:()=>({addEventListener:(_event,fn)=>{click=fn;}}),
        getBoundingClientRect:()=>({height:50}),animate(){assert.fail('reduced motion must not animate');}};
    module.namespace.mountSettingsAnimations({querySelectorAll:()=>[section]});
    click({preventDefault(){}}); assert.equal(section.open,true);
    click({preventDefault(){}}); assert.equal(section.open,false);
});


test('history count is normalized and settings handler persists the normalized value', async () => {
    const h = await harness(); const {normalizeVnContextMessages: normalize} = await h.loadApi('./constants.js');
    for (const [value,expected] of [[undefined,10],['',10],[null,10],['bad',10],[Infinity,10],[0,1],[-8,1],[1000,100],['12',12],[2.6,3]]) assert.equal(normalize(value),expected);
    const source = await readFile(new URL('modules/settings.js',root),'utf8');
    const body=source.split("jQuery('#bb-vn-cfg-context-messages').on('change', function() {")[1].split('    });')[0];
    let value='999', saves=0;
    const jq=()=>({val(next){if(arguments.length)value=next;return value;}});
    new Function('jQuery','normalizeVnContextMessages','extension_settings','MODULE_NAME','saveSettingsDebounced',body)(jq,normalize,h.settings,'BB-Visual-Novel',()=>saves++);
    assert.equal(value,100);assert.equal(h.settings['BB-Visual-Novel'].vnContextMessages,100);assert.equal(saves,1);
});

test('all option sources receive the selected history window while retaining scene and SD', async () => {
    for (const source of ['main','custom','profile']) {
        for (const count of [1,3,undefined,100]) {
            const h = await harness();
            Object.assign(h.settings['BB-Visual-Novel'],{vnGenerationSource:source,vnConnectionProfileId:'profile-a',vnContextMessages:count});
            h.context.chat=Array.from({length:14},(_,i)=>({name:'Character',mes:'HISTORY_MARK_'+i+'_END',swipe_id:0}));
            h.window.bbGetSceneDirectorPrompt=()=> 'SD_ANCHOR';
            const run=h.api.bbVnGenerateOptionsFlow();await h.waitForCalls(1);
            const call=h.calls[0];
            const prompt=source==='custom'?call.body.messages[1].content:source==='profile'?call.prompt[1].content:call.args.quietPrompt;
            const recent=prompt.split('[RECENT CONTEXT (For background)]:')[1].split('[IMMEDIATE TRIGGER')[0];
            const n=Math.min(count??10,14);
            for(let i=0;i<14;i++) assert.equal(recent.includes('HISTORY_MARK_'+i+'_END'),i>=14-n);
            assert.match(prompt,/SD_ANCHOR/);assert.match(prompt.split('[IMMEDIATE TRIGGER')[1],/HISTORY_MARK_13_END/);
            h.respond(0);await run;assert.equal(h.rendered.length,1);
        }
    }
});

test('short history is retained in full and empty chat makes no request', async () => {
    const h=await harness();h.settings['BB-Visual-Novel'].vnContextMessages=100;
    let run=h.api.bbVnGenerateOptionsFlow();assert.match(h.calls[0].args.quietPrompt,/Initial scene/);h.respond(0);await run;
    h.context.chat=[];await h.api.bbVnGenerateOptionsFlow();assert.equal(h.calls.length,1);assert.equal(h.loading,false);
});


test('disabling hides the whole bar, syncs settings, and preserves saved choices', async () => {
 const h=await harness(); const bar={hidden:false}, checkbox={checked:true};
 h.document.getElementById=id=>id==='bb-vn-action-bar'?bar:id==='bb-vn-cfg-options-enabled'?checkbox:null;
 const run=h.api.bbVnGenerateOptionsFlow();h.respond(0);await run;
 const saved=JSON.stringify(h.context.chat);
 h.api.setVnOptionsEnabled(false);assert.equal(bar.hidden,true);assert.equal(checkbox.checked,false);
 h.api.restoreVNOptions(true);await h.api.bbVnGenerateOptionsFlow();
 assert.equal(h.calls.length,1);assert.equal(h.rendered.length,1);assert.equal(JSON.stringify(h.context.chat),saved);
 assert.equal(h.settings['BB-Visual-Novel'].disableRelationshipTracker,undefined);
 h.api.setVnOptionsEnabled(true);assert.equal(bar.hidden,false);assert.equal(checkbox.checked,true);
 assert.equal(h.calls.length,1);assert.equal(h.rendered.length,2);assert.equal(h.rendered[1].open,false);
 assert.ok(h.events.some(e=>e.type==='bb-vn-options-enabled-changed'));
});

test('disabling invalidates late results from every connection and blocks further requests',async()=>{
 for(const source of ['main','profile','custom']){
  const h=await harness();Object.assign(h.settings['BB-Visual-Novel'],{vnGenerationSource:source,vnConnectionProfileId:'profile-a'});
  const run=h.api.bbVnGenerateOptionsFlow();await h.waitForCalls(1);
  h.api.setVnOptionsEnabled(false);h.respond(0);await run;
  assert.equal(h.saves,0);assert.equal(h.rendered.length,0);assert.equal(h.errors.length,0);
  await h.api.bbVnGenerateOptionsFlow();assert.equal(h.calls.length,1);
  h.api.setVnOptionsEnabled(true);assert.equal(h.calls.length,1);
 }
});


test('disabling clears pending auto-generation and re-enabling does not requeue it',async()=>{
 const h=await harness({boot:true});const pending=new Map();let id=0;
 h.window.setTimeout=callback=>{pending.set(++id,callback);return id;};
 h.window.clearTimeout=key=>pending.delete(key);
 h.settings['BB-Visual-Novel'].autoGen=true;
 await h.emit('MESSAGE_RECEIVED');assert.equal(pending.size,1);
 h.api.setVnOptionsEnabled(false);assert.equal(pending.size,0);
 await h.emit('MESSAGE_RECEIVED');assert.equal(pending.size,0);
 h.api.setVnOptionsEnabled(true);assert.equal(pending.size,0);assert.equal(h.calls.length,0);
 await h.emit('MESSAGE_RECEIVED');assert.equal(pending.size,1);
});


test('option visibility swaps compact restore button and panel, safely reversing animations',async()=>{
 const h=await harness();const api=await h.loadApi('./options-visibility.js');
 const make=height=>({hidden:false,inert:false,style:{},animations:[],getBoundingClientRect(){return {height:this.hidden?0:height};},
  animate(frames){const animation={frames,cancel(){this.cancelled=true;}};this.animations.push(animation);return animation;}});
 const bar=make(300), restore=make(30);restore.hidden=true;
 h.document.getElementById=id=>id==='bb-vn-action-bar'?bar:id==='bb-vn-enable-options'?restore:null;
 api.syncOptionsVisibility(false,true);assert.equal(bar.inert,true);assert.equal(restore.hidden,false);
 const old=bar.animations[0];api.syncOptionsVisibility(true,true);assert.equal(old.cancelled,true);assert.equal(old.onfinish,null);
 bar.animations.at(-1).onfinish();restore.animations.at(-1).onfinish();
 assert.equal(bar.hidden,false);assert.equal(bar.inert,false);assert.equal(restore.hidden,true);assert.equal(bar.style.overflow,'');
 api.syncOptionsVisibility(false);assert.equal(bar.hidden,true);assert.equal(restore.hidden,false);assert.equal(restore.inert,false);
 api.syncOptionsVisibility(true);assert.equal(bar.hidden,false);assert.equal(restore.hidden,true);
});
