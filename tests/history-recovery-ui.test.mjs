import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

async function harness(generate) {
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; }
        append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
        setAttribute(key, value) { this[key] = value; }
        addEventListener(type, listener) { this.listeners[type] = listener; }
        click() { if (!this.disabled) return this.listeners.click?.(); }
        focus() {} showModal() {} close() {}
        remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    }
    const body = new Node('body');
    const nodes = () => { const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; walk(body); return all; };
    const document = { body, createElement: tag => new Node(tag), querySelector: selector => selector === '.bb-history-recovery' ? nodes().find(n => n.tagName === 'dialog') : null };
    const context = { chat: [{ name: 'Scene', mes: 'Alex helps Player', extra: {} }], chatId: 'chat', name1: 'Player' };
    const scopeState = {}, metadata = { integrity: 'chat' }, settings = { disableRelationshipTracker: true };
    let saves = 0, recalculations = 0, calls = 0;
    const sandbox = createContext({ document, window: {}, AbortController, SillyTavern: { getContext: () => context } });
    const mocks = {
        './i18n.js': { t: text => text },
        './social.js': { bindActivePersonaState: () => ({ scopeKey: 'player', scopeState, aliasSet: new Set(['player']) }), getCurrentPersonaScopeKey: () => 'player', recalculateAllStats: () => recalculations++ },
        './generator.js': { generateFastPrompt: async (...args) => { calls++; return generate ? generate(...args) : JSON.stringify({ messages: [{ message: 1, updates: [{ name: '<img src=x onerror=evil>', friendship_impact: 'minor_positive', romance_impact: 'none', reason: '<script>evil</script>' }] }] }); } },
        './state.js': { currentCalculatedStats: {} },
        '../../../../../script.js': { chat_metadata: metadata, saveChatDebounced: () => saves++, saveSettingsDebounced() {} },
        '../../../../extensions.js': { extension_settings: { 'BB-Visual-Novel': settings } },
        './constants.js': { MODULE_NAME: 'BB-Visual-Novel', normalizeImpactSettings: () => ({ none: 0, minor_positive: 2 }) },
    };
    const cache = new Map();
    function load(name) {
        if (cache.has(name)) return cache.get(name);
        const values = mocks[name];
        const module = values ? new SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context: sandbox }) : new SourceTextModule(readFileSync(new URL(`../modules/${name.replace('./', '')}`, import.meta.url), 'utf8'), { context: sandbox });
        cache.set(name, module); return module;
    }
    const module = load('./history-recovery-ui.js'); await module.link(load); await module.evaluate();
    return { api: module.namespace, context, settings, nodes, button: text => nodes().find(n => n.tagName === 'button' && n.textContent === text), get saves() { return saves; }, get recalculations() { return recalculations; }, get calls() { return calls; } };
}

test('history settings flow previews safe text, saves once, and enables the tracker', async () => {
    const h = await harness(); h.api.openHistoryRecovery(); h.api.openHistoryRecovery();
    assert.equal(h.nodes().filter(n => n.tagName === 'dialog').length, 1);
    await h.button('Анализировать').click();
    assert.equal(h.calls, 1); assert.equal(h.saves, 0); assert.equal(h.settings.disableRelationshipTracker, true);
    assert.ok(h.nodes().some(n => n.textContent.includes('<script>evil</script>')));
    assert.equal(h.nodes().some(n => n.tagName === 'script' || n.tagName === 'img'), false);
    h.button('Сохранить выбранное').click(); h.button('Сохранить выбранное').click();
    assert.equal(h.saves, 1); assert.equal(h.recalculations, 1); assert.equal(h.settings.disableRelationshipTracker, false);
    assert.equal(h.context.chat[0].extra.bb_social_swipes[0].length, 1);
});

test('preview cannot save into a switched chat', async () => {
    const h = await harness(); h.api.openHistoryRecovery(); await h.button('Анализировать').click();
    h.context.chatId = 'other'; h.button('Сохранить выбранное').click();
    assert.equal(h.saves, 0); assert.deepEqual(h.context.chat[0].extra, {});
});

test('failed generation and closing an in-flight dialog leave chat data unchanged', async () => {
    const failed = await harness(async () => { throw new Error('API unavailable'); });
    failed.api.openHistoryRecovery(); await failed.button('Анализировать').click();
    assert.equal(failed.saves, 0); assert.equal(failed.button('Сохранить выбранное').hidden, true);
    let release, requestSignal;
    const h = await harness((prompt, { signal }) => { requestSignal = signal; return new Promise(resolve => { release = resolve; }); });
    h.api.openHistoryRecovery(); const pending = h.button('Анализировать').click();
    h.button('Закрыть').click(); assert.equal(requestSignal.aborted, true);
    release('{}'); await pending;
    assert.equal(h.saves, 0); assert.deepEqual(h.context.chat[0].extra, {});
});
