import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=';
const connection = { endpoint: 'https://images.example/v1', model: 'test-image', key: 'test-key' };

async function harness({ fetch: fetchImpl, fakeClock = false } = {}) {
    const requests = [], textRequests = [], applied = [], timers = new Map();
    let timerId = 0, persona = 'a', editorCurrent = true, saves = 0, decodeError = false;
    const context = { chat: [{ mes: 'Scene', swipe_id: 0 }], chatId: 'a', characterId: 1 };
    const settings = { 'BB-Visual-Novel': { portrait: { ...connection } } };
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = new Map(); this.value = ''; this.hidden = false; }
        append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        setAttribute(key, value) { this[key] = value; }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        emit(type) { if (this.disabled) return; return this.listeners.get(type)?.({ preventDefault() {} }); }
        click() { return this.emit('click'); }
        focus() {}
        showModal() { this.open = true; }
        close() { this.open = false; }
        remove() { this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
        decode() { return decodeError ? Promise.reject(new Error('decode')) : Promise.resolve(); }
    }
    const body = new Node('body');
    const nodes = () => { const list = []; const visit = n => { list.push(n); n.children.forEach(visit); }; visit(body); return list; };
    const document = {
        body, createElement: tag => new Node(tag),
        querySelector: selector => selector === '.bb-portrait-dialog' ? nodes().find(n => n.className === 'bb-portrait-dialog') : null,
    };
    class Reader {
        readAsDataURL(blob) { blob.arrayBuffer().then(bytes => { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64'); this.onload(); }, () => this.onerror()); }
    }
    const sandbox = createContext({
        URL, FormData, Blob, Uint8Array, atob, AbortController, Error, TypeError, FileReader: Reader,
        setTimeout: fakeClock ? callback => { timers.set(++timerId, callback); return timerId; } : setTimeout,
        clearTimeout: fakeClock ? id => timers.delete(id) : clearTimeout,
        setInterval, clearInterval, document, SillyTavern: { getContext: () => context },
        fetch: async (url, init) => {
            requests.push({ url, init });
            return fetchImpl ? fetchImpl(url, init) : { ok: true, json: async () => ({ data_url: png }) };
        },
    });
    const mocks = new Map([
        ['./i18n.js', { t: x => x }], ['./constants.js', { MODULE_NAME: 'BB-Visual-Novel' }],
        ['../../../../extensions.js', { extension_settings: settings }],
        ['../../../../../script.js', { saveSettingsDebounced: () => { saves++; } }],
        ['./social.js', { getCurrentPersonaScopeKey: () => persona }],
        ['./generator.js', { generatePortraitPrompt: async args => { textRequests.push(args); return 'Portrait of Alex.'; } }],
    ]);
    const cache = new Map();
    const load = name => {
        if (cache.has(name)) return cache.get(name);
        const values = mocks.get(name);
        const module = values
            ? new SyntheticModule(Object.keys(values), function () { for (const [k,v] of Object.entries(values)) this.setExport(k,v); }, { context: sandbox })
            : new SourceTextModule(readFileSync(new URL('../modules/' + name, import.meta.url), 'utf8'), { context: sandbox });
        cache.set(name,module); return module;
    };
    const module = load('./portrait-ui.js'); await module.link(load); await module.evaluate();
    return {
        api: cache.get('./portrait-provider.js').namespace, ui: module.namespace,
        context, settings, requests, textRequests, applied, nodes,
        get saves() { return saves; },
        setPersona: value => { persona = value; },
        invalidateEditor: () => { editorCurrent = false; },
        failDecode: () => { decodeError = true; },
        expire: () => [...timers.values()].forEach(callback => callback()),
        button: text => nodes().find(n => n.tagName === 'button' && n.textContent === text),
        prompt: () => nodes().find(n => n.tagName === 'textarea'),
        open() { module.namespace.openPortraitWorkshop({ charName: '<Alex>', description: 'Unsaved hair', avatar: png, isEditorCurrent: () => editorCurrent, apply: value => applied.push(value) }); },
        close() { nodes().find(n => n.tagName === 'dialog')?.emit('cancel'); },
        mountSettings() { const root = new Node('div'); body.append(root); module.namespace.mountPortraitSettings(root); return root; },
    };
}

test('image transports carry prompt, style and actual references', async () => {
    const h = await harness();
    const refs = [{ dataUrl: png, role: 'appearance' }, { dataUrl: png, role: 'style' }];
    const image = h.api.buildPortraitRequest({ ...connection, style: 'ink' }, 'Alex', refs);
    assert.equal(image.url, 'https://images.example/v1/images/edits');
    assert.equal(image.init.headers['Content-Type'], undefined);
    assert.equal(image.init.body.getAll('image[]').length, 2);
    assert.match(image.init.body.get('prompt'), /Art style: ink/);
    assert.match(image.init.body.get('prompt'), /Reference 2: use artistic style only/);
    assert.equal(image.init.body.getAll('image[]')[0].type, 'image/png');
    const plain = h.api.buildPortraitRequest(connection, 'Alex');
    assert.match(plain.url, /images\/generations$/);
    assert.equal(JSON.parse(plain.init.body).n, 1);
    for (const type of ['openai-chat','gemini','naistera']) {
        const request = h.api.buildPortraitRequest({ ...connection, endpoint: 'https://images.example', type }, 'Alex', refs);
        const body = JSON.parse(request.init.body);
        if (type === 'openai-chat') assert.equal(body.messages[0].content[2].image_url.url, png);
        if (type === 'gemini') assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
        if (type === 'naistera') { assert.equal(body.reference_images.length,2); assert.deepEqual(body.reference_labels,['appearance','style']); }
    }
});

test('Gemini auth is selected by exact hostname and full endpoint is preserved', async () => {
    const h = await harness();
    const s = { ...connection, type: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta' };
    const official = h.api.buildPortraitRequest(s,'Alex');
    assert.equal(official.init.headers['x-goog-api-key'], 'test-key');
    assert.equal(official.init.headers.Authorization, undefined);
    const proxy = h.api.buildPortraitRequest({ ...s, endpoint: 'https://generativelanguage.googleapis.com.example/v1beta/models/custom:generateContent' },'Alex');
    assert.equal(proxy.init.headers.Authorization, 'Bearer test-key');
    assert.match(proxy.url, /custom:generateContent$/);
});

test('invalid settings and references fail before network requests', async () => {
    const h = await harness();
    for (const endpoint of ['', 'file:///tmp/a', 'https://user:pass@example.com', 'https://example.com/?key=x']) {
        assert.throws(() => h.api.buildPortraitRequest({ ...connection,endpoint },'Alex'), /portrait_configuration/);
    }
    assert.throws(() => h.api.buildPortraitRequest(connection, ' '), /portrait_configuration/);
    assert.throws(() => h.api.buildPortraitRequest(connection, 'Alex', [{dataUrl:'data:image/svg+xml;base64,YQ=='}]), /portrait_image/);
    assert.throws(() => h.api.buildPortraitRequest(connection, 'Alex', Array(5).fill({dataUrl:png})), /portrait_references/);
    await assert.rejects(h.api.readPortraitFile(new Blob(['x'],{type:'text/plain'})), /portrait_image/);
    assert.equal(h.requests.length,0);
});

test('image response adapters reject text-only replies', async () => {
    const h = await harness();
    const base64 = png.split(',')[1];
    for (const response of [
        {data_url:png}, {data:[{b64_json:base64}]},
        {candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:base64}}]}}]},
        {choices:[{message:{images:[{image_url:{url:png}}]}}]},
        {choices:[{message:{content:[{source:{media_type:'image/png',data:base64}}]}}]},
    ]) assert.equal(h.api.extractPortraitImage(response),png);
    assert.throws(() => h.api.extractPortraitImage({ choices:[{message:{content:'Sorry, no image'}}] }), /portrait_empty/);
});

test('failed edit is not retried without references', async () => {
    const h = await harness({fetch: async () => ({ok:false,status:400})});
    await assert.rejects(h.api.generatePortrait(connection,'Alex',[{dataUrl:png}]), {code:'request_rejected'});
    assert.equal(h.requests.length,1);
    assert.match(h.requests[0].url,/edits$/);
});

test('URL image download never receives provider credentials', async () => {
    const h = await harness({ fetch: async url => url.includes('/images/generations')
        ? {ok:true,json:async()=>({data:[{url:'https://cdn.example/result.png'}]})}
        : {ok:true,blob:async()=>new Blob([Buffer.from(png.split(',')[1],'base64')],{type:'image/png'})} });
    assert.equal(await h.api.generatePortrait(connection,'Alex',[]),png);
    assert.equal(h.requests[1].init.headers,undefined);
    assert.equal(h.requests[1].init.credentials,'omit');
});

test('abort and timeout release stalled image transports', async () => {
    const h = await harness({fetch: () => new Promise(()=>{}),fakeClock:true});
    const controller = new AbortController();
    const run = h.api.generatePortrait(connection,'Alex',[],controller.signal);
    controller.abort(); await assert.rejects(run,{code:'cancelled'});
    const timeout = h.api.generatePortrait(connection,'Alex',[]);
    h.expire(); await assert.rejects(timeout,{code:'timeout'});
    assert.ok(h.requests.every(request=>request.init.signal.aborted));
});

test('workshop manual generation previews without a text request and applies only on click', async () => {
    const h = await harness(); h.open();
    try {
        assert.equal(h.nodes().find(n=>n.tagName==='h3').textContent,'Портрет · <Alex>');
        h.prompt().value = 'Manual appearance';
        await h.button('Текущий аватар').click();
        await h.button('Сгенерировать портрет').click();
        assert.equal(h.textRequests.length,0);
        assert.equal(h.requests.length,1);
        assert.equal(h.applied.length,0);
        assert.match(h.requests[0].init.body.get('prompt'),/Manual appearance/);
        assert.equal(h.button('Использовать').disabled,false);
        h.button('Использовать').click();
        assert.deepEqual(h.applied,[png]);
    } finally { h.close(); }
});

test('build prompt uses editor draft without generating an image', async () => {
    const h = await harness(); h.open();
    try {
        await h.button('Собрать промпт').click();
        assert.equal(h.prompt().value,'Portrait of Alex.');
        assert.equal(h.textRequests[0].currentDescription,'Unsaved hair');
        assert.equal(h.requests.length,0);
    } finally { h.close(); }
});

test('changed chat, persona, swipe or editor prevents applying a preview', async () => {
    for (const change of [h=>h.context.chatId='b',h=>h.setPersona('b'),h=>h.context.chat[0].swipe_id++,h=>h.invalidateEditor()]) {
        const h=await harness();h.open();
        try {
            h.prompt().value='Alex';await h.button('Сгенерировать портрет').click();
            change(h);h.button('Использовать').click();
            assert.equal(h.applied.length,0);
        } finally {h.close();}
    }
});

test('closed workshop ignores late transport completion', async () => {
    let resolve;
    const h=await harness({fetch:()=>new Promise(r=>resolve=r)});h.open();h.prompt().value='Alex';
    const run=h.button('Сгенерировать портрет').click();h.close();
    resolve({ok:true,json:async()=>({data_url:png})});await run;
    assert.equal(h.applied.length,0);
    assert.equal(h.nodes().filter(n=>n.tagName==='dialog').length,0);
});

test('bad reroll preserves the previous valid preview', async () => {
    const h=await harness();h.open();
    try {
        h.prompt().value='Alex';await h.button('Сгенерировать портрет').click();
        h.failDecode();await h.button('Сгенерировать портрет').click();
        assert.equal(h.nodes().find(n=>n.className==='bb-portrait-preview').children[0].src,png);
        h.button('Использовать').click();assert.deepEqual(h.applied,[png]);
    } finally {h.close();}
});

test('image settings persist separately and show only relevant provider fields', async () => {
    const h=await harness();h.mountSettings();
    const input=key=>h.nodes().find(n=>n.dataset.portraitField===key);
    input('type').value='gemini';input('type').emit('change');
    assert.equal(h.settings['BB-Visual-Novel'].portrait.type,'gemini');
    assert.equal(input('size').parentElement.hidden,true);
    assert.equal(input('imageSize').parentElement.hidden,false);
    assert.equal(input('key').type,'password');
    input('timeout').value='9999';input('timeout').emit('change');
    assert.equal(h.settings['BB-Visual-Novel'].portrait.timeout,600);
    assert.equal(h.saves,2);
    assert.equal(h.settings['BB-Visual-Novel'].customApiKey,undefined);
});
