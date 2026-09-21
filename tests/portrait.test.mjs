import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=';
const connection = { endpoint: 'https://images.example/v1', model: 'test-image', key: 'test-key' };

async function harness({ fetch: fetchImpl, fakeClock = false, uploadFails = false, upload: uploadImpl, promptError } = {}) {
    const requests = [], textRequests = [], applied = [], downloads = [], timers = new Map();
    const dialogs = { name: undefined, confirm: true };
    let timerId = 0, persona = 'a', editorCurrent = true, saves = 0, decodeError = false;
    const context = { chat: [{ mes: 'Scene', swipe_id: 0 }], chatId: 'a', characterId: 1, chatMetadata: {}, getRequestHeaders: () => ({'Content-Type':'application/json'}), saveMetadataDebounced() {} };
    const settings = { 'BB-Visual-Novel': { portrait: { ...connection } } };
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = new Map(); this.value = ''; this.hidden = false; }
        append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        setAttribute(key, value) { this[key] = value; }
        removeAttribute(key) { delete this[key]; }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        emit(type) { if (this.disabled) return; return this.listeners.get(type)?.({ preventDefault() {} }); }
        click() { if (this.tagName === 'a') downloads.push({ href: this.href, filename: this.download }); return this.emit('click'); }
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
        URL, FormData, Blob, Uint8Array, atob, AbortController, Error, TypeError, FileReader: Reader, crypto: globalThis.crypto,
        setTimeout: fakeClock ? callback => { timers.set(++timerId, callback); return timerId; } : setTimeout,
        clearTimeout: fakeClock ? id => timers.delete(id) : clearTimeout,
        setInterval, clearInterval, document, SillyTavern: { getContext: () => context },
        window: { prompt: (_message, value) => dialogs.name === undefined ? value : dialogs.name, confirm: () => dialogs.confirm },
        fetch: async (url, init) => {
            requests.push({ url, init });
            if (url === '/api/images/upload') {
                const body = JSON.parse(init.body);
                if (uploadImpl) return uploadImpl(body, init);
                return {ok: !uploadFails, json: async () => ({path: '/user/images/bb_vne_portraits/' + body.filename + '.' + body.format})};
            }
            if (url.startsWith('/user/images/bb_vne_portraits/')) return {ok:true,blob:async()=>new Blob([Buffer.from(png.split(',')[1],'base64')],{type:'image/png'})};
            return fetchImpl ? fetchImpl(url, init) : { ok: true, json: async () => ({ data_url: png }) };
        },
    });
    const mocks = new Map([
        ['./i18n.js', { t: x => x }], ['./constants.js', { MODULE_NAME: 'BB-Visual-Novel' }],
        ['../../../../extensions.js', { extension_settings: settings }],
        ['../../../../../script.js', { saveSettingsDebounced: () => { saves++; } }],
        ['./social.js', { getCurrentPersonaScopeKey: () => persona, resolveCharacterIdentity: name => ({id:name}) }],
        ['./generator.js', { generatePortraitPrompt: async args => { textRequests.push(args); if (promptError) throw promptError; return 'Portrait of Alex.'; } }],
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
        api: cache.get('./portrait-provider.js').namespace, ui: module.namespace, gallery: cache.get('./portrait-gallery.js').namespace,
        context, settings, requests, textRequests, applied, nodes, dialogs, downloads, sandbox, document,
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

test('OpenAI Images posts a single reference as a real file to edits, normalizing a generation URL', async () => {
    const h = await harness();
    const request = h.api.buildPortraitRequest({ ...connection, endpoint: connection.endpoint + '/images/generations' }, 'Alex', [{ dataUrl: png }]);
    assert.equal(request.url, connection.endpoint + '/images/edits');
    const file = request.init.body.get('image');
    assert.equal(file.type, 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
    assert.equal(request.init.body.has('image[]'), false);
});

test('unavailable edits endpoint reports the reference limitation without a text-only retry', async () => {
    const h = await harness({ fetch: async () => ({ ok: false, status: 404 }) });
    await assert.rejects(h.api.generatePortrait(connection, 'Alex', [{ dataUrl: png }]), /portrait_edits_unavailable/);
    assert.equal(h.requests.length, 1);
});

test('connect loads provider models into the picker without an image generation request', async () => {
    const h = await harness({ fetch: async () => ({ ok: true, json: async () => ({ data: [{id:'portrait-b'}, {id:'portrait-a'}] }) }) });
    h.mountSettings();
    assert.equal(h.button('Отмена').hidden, true);
    await h.button('Подключить').click();
    assert.equal(h.button('Отмена').hidden, true);
    const model = h.nodes().find(n => n.dataset.portraitField === 'model');
    assert.equal(model.tagName, 'select');
    assert.ok(model.children.some(n => n.value === 'portrait-a'));
    assert.equal(h.requests[0].url, connection.endpoint + '/models');
    assert.equal(h.requests[0].init.method, 'GET');
    assert.equal(h.requests[0].init.headers.Authorization, 'Bearer test-key');
    model.value = 'portrait-a'; model.emit('change');
    assert.equal(h.settings['BB-Visual-Novel'].portrait.model, 'portrait-a');
});

test('failed connection does not claim success or replace a saved model', async () => {
    const h = await harness({ fetch: async () => ({ok:false,status:401}) });
    h.mountSettings(); await h.button('Подключить').click();
    assert.equal(h.settings['BB-Visual-Novel'].portrait.model, 'test-image');
    assert.equal(h.button('Подключить').disabled, false);
    assert.doesNotMatch(h.nodes().find(n=>n.className==='bb-portrait-connection-status').textContent, /Подключено/);
});

test('editing connection invalidates an outstanding model discovery', async () => {
    let resolve;
    const h = await harness({ fetch: () => new Promise(r=>resolve=r) }); h.mountSettings();
    const run = h.button('Подключить').click();
    assert.equal(h.button('Отмена').hidden, false);
    const endpoint = h.nodes().find(n=>n.dataset.portraitField==='endpoint');
    endpoint.value = 'https://other.example'; endpoint.emit('input'); endpoint.emit('change');
    resolve({ok:true,json:async()=>({data:[{id:'stale-model'}]})}); await run;
    assert.ok(h.requests[0].init.signal.aborted);
    const model = h.nodes().find(n=>n.dataset.portraitField==='model');
    assert.ok(!model.children.some(n=>n.value==='stale-model'));
});

test('Gemini discovery handles full endpoints, native auth and pagination', async () => {
    let page=0;
    const h = await harness({ fetch: async () => ({ok:true,json:async()=> ++page===1
        ? {models:[{name:'models/image-a'}],nextPageToken:'next'} : {models:[{name:'models/image-b'}]} }) });
    const result = await h.api.fetchPortraitModels({...connection,type:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta/models/example:generateContent'});
    assert.deepEqual(Array.from(result.models), ['image-a','image-b']);
    assert.equal(h.requests[0].url,'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(h.requests[0].init.headers['x-goog-api-key'],'test-key');
    assert.match(h.requests[1].url,/pageToken=next/);
});

test('Naistera built-in models are not reported as a verified connection', async () => {
    const h=await harness();
    const result=await h.api.fetchPortraitModels({...connection,type:'naistera'});
    assert.equal(result.verified,false);assert.ok(result.models.includes('nano banana'));
    assert.equal(h.requests.length,0);
});

test('saved image profiles restore credentials and model but leave shared art style alone', async () => {
    const h=await harness();h.mountSettings();
    const field=caption=>h.nodes().find(n=>n.tagName==='label' && n.children[0]?.textContent===caption).children[1];
    field('Имя профиля').value='Studio';h.button('Сохранить как новый…').click();
    const id=h.settings['BB-Visual-Novel'].portrait.activeProfile;
    h.dialogs.name='Second';h.button('Сохранить как новый…').click();
    const key=h.nodes().find(n=>n.dataset.portraitField==='key');key.value='changed';key.emit('change');
    h.settings['BB-Visual-Novel'].portrait.style='ink';
    field('Сохранённое подключение').value=id;field('Сохранённое подключение').emit('change');
    assert.equal(key.value,'test-key');
    assert.equal(h.settings['BB-Visual-Novel'].portrait.style,'ink');
    assert.equal(h.settings['BB-Visual-Novel'].portrait.model,'test-image');
});

test('profile creation, update and confirmed deletion are distinct actions', async () => {
    const h = await harness(); h.mountSettings();
    const settings = () => h.settings['BB-Visual-Novel'].portrait;
    assert.equal(h.button('Обновить выбранный').disabled, true);
    assert.equal(h.button('Удалить профиль…').disabled, true);
    h.dialogs.name = null; h.button('Сохранить как новый…').click();
    assert.equal(settings().profiles, undefined);
    h.dialogs.name = 'First'; h.button('Сохранить как новый…').click();
    const first = settings().profiles[0].id;
    settings().model = 'new-model'; h.button('Обновить выбранный').click();
    assert.equal(settings().profiles.length, 1);
    assert.equal(settings().profiles[0].id, first);
    assert.equal(settings().profiles[0].model, 'new-model');
    h.dialogs.name = 'Second'; h.button('Сохранить как новый…').click();
    assert.equal(settings().profiles.length, 2);
    assert.notEqual(settings().activeProfile, first);
    h.dialogs.confirm = false; h.button('Удалить профиль…').click();
    assert.equal(settings().profiles.length, 2);
    h.dialogs.confirm = true; h.button('Удалить профиль…').click();
    assert.equal(settings().profiles.length, 1);
    assert.equal(settings().profiles[0].id, first);
    assert.equal(settings().model, 'new-model');
    assert.equal(settings().key, 'test-key');
    assert.equal(h.button('Обновить выбранный').disabled, true);
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
        assert.equal(h.requests.length,2);
        assert.equal(h.requests[1].url, '/api/images/upload');
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
    assert.equal(input('model').parentElement.parentElement.className, 'bb-portrait-connection');
    assert.equal(input('quality').parentElement.parentElement.className, 'bb-portrait-parameters');
    assert.equal(input('timeout').parentElement.parentElement.parentElement.tagName, 'details');
    assert.ok(!input('timeout').parentElement.parentElement.parentElement.open);
    assert.equal(input('style').parentElement.parentElement.parentElement.tagName, 'details');
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

test('gallery stores file links and isolates characters, personas and chat metadata', async () => {
    const h = await harness();
    const first = h.gallery.createPortraitGallery('Alex');
    const entry = await first.add(png);
    assert.match(entry.path, /^\/user\/images\/bb_vne_portraits\//);
    assert.doesNotMatch(JSON.stringify(h.context.chatMetadata), /base64|test-key/);
    assert.equal(h.gallery.createPortraitGallery('Alex').list().length, 1);
    assert.equal(h.gallery.createPortraitGallery('Other').list().length, 0);
    h.setPersona('other');
    assert.equal(h.gallery.createPortraitGallery('Alex').list().length, 0);
    assert.throws(() => first.list(), /portrait_context/);
    h.setPersona('a');
    assert.equal(first.list().length, 1);
    const originalMetadata = h.context.chatMetadata;
    h.context.chatMetadata = {}; h.context.chatId = 'b';
    assert.equal(h.gallery.createPortraitGallery('Alex').list().length, 0);
    assert.throws(() => first.remove(entry.id), /portrait_context/);
    assert.ok(JSON.stringify(originalMetadata).includes(entry.id));
});

test('late upload after a persona switch cannot register a portrait in either gallery', async () => {
    let finish, uploaded;
    const h = await harness({upload: body => { uploaded=body; return new Promise(resolve=>finish=resolve); }});
    const run = h.gallery.createPortraitGallery('Alex').add(png);
    h.setPersona('other');
    finish({ok:true,json:async()=>({path:'/user/images/bb_vne_portraits/'+uploaded.filename+'.png'})});
    await assert.rejects(run, /portrait_context/);
    assert.deepEqual(h.context.chatMetadata, {});
});

test('gallery deletion only removes the index entry and rejected paths are never fetched', async () => {
    const h=await harness(); const gallery=h.gallery.createPortraitGallery('Alex');
    const one=await gallery.add(png), two=await gallery.add(png);
    const before=h.requests.length;
    gallery.remove(one.id);
    assert.deepEqual(Array.from(gallery.list(), item=>item.id), [two.id]);
    assert.equal(h.requests.length,before);
    const rows=Object.values(h.context.chatMetadata.bb_vn_portrait_gallery)[0];
    rows.push({id:'external',path:'https://example.invalid/private.png',createdAt:Date.now()});
    await assert.rejects(gallery.read('external'),/portrait_gallery_missing/);
    assert.equal(h.requests.length,before);
});

test('failed gallery save keeps generated portrait available without claiming it was saved', async () => {
    const h=await harness({uploadFails:true});h.open();
    try {
        h.prompt().value='Alex';await h.button('Сгенерировать портрет').click();
        assert.equal(h.button('Скачать').disabled,false);
        assert.equal(h.button('Использовать').disabled,false);
        assert.match(h.nodes().find(n=>n.className==='bb-portrait-status').textContent,/не сохранён/);
        assert.deepEqual(h.context.chatMetadata,{});
    } finally {h.close();}
});

test('reopening the workshop defaults to its saved gallery and applies only on request', async () => {
    const h=await harness();h.open();
    h.prompt().value='Alex';await h.button('Сгенерировать портрет').click();h.close();
    h.open();
    try {
        assert.equal(h.nodes().find(n=>n.className==='bb-portrait-gallery').hidden,false);
        const actions=h.nodes().find(n=>n.className==='bb-portrait-gallery-actions');
        for(let i=0;i<20 && actions.children[0].disabled;i++)await new Promise(resolve=>setImmediate(resolve));
        assert.equal(actions.children[0].disabled,false);
        assert.equal(h.applied.length,0);
        await actions.children[0].click();
        assert.deepEqual(h.applied,[png]);
    } finally {h.close();}
});

test('gallery removal honours confirmation and keeps the editor untouched', async () => {
    const h=await harness();h.open();
    try {
        h.prompt().value='Alex';await h.button('Сгенерировать портрет').click();
        const remove=h.button('Удалить из галереи…');
        h.dialogs.confirm=false;remove.click();
        assert.equal(h.gallery.createPortraitGallery('<Alex>').list().length,1);
        h.dialogs.confirm=true;remove.click();
        assert.equal(h.gallery.createPortraitGallery('<Alex>').list().length,0);
        assert.equal(h.applied.length,0);
    } finally {h.close();}
});

test('unavailable image clipboard reports a controlled failure', async () => {
    const h=await harness();await assert.rejects(h.gallery.copyPortrait(png),/portrait_clipboard/);
});

test('download exports the original image and removes the temporary link', async () => {
    const h=await harness();
    h.gallery.downloadPortrait(png);
    assert.equal(h.downloads[0].href,png);
    assert.match(h.downloads[0].filename,/^vne-portrait-\d+\.png$/);
    assert.equal(h.nodes().some(n=>n.tagName==='a'),false);
});

test('clipboard writes a PNG blob using the decoded original dimensions', async () => {
    const h=await harness();let clipboard,drawn=false,canvas;
    h.sandbox.Image=class {naturalWidth=512;naturalHeight=768;async decode(){}};
    h.sandbox.ClipboardItem=class {constructor(data){this.data=data;}};
    h.sandbox.navigator={clipboard:{write:async items=>{clipboard=await items[0].data['image/png'];}}};
    const create=h.document.createElement;
    h.document.createElement=tag=>tag==='canvas' ? (canvas={getContext:()=>({drawImage:()=>{drawn=true;}}),toBlob:callback=>callback(new Blob(['png'],{type:'image/png'}))}) : create(tag);
    await h.gallery.copyPortrait(png);
    assert.equal(clipboard.type,'image/png');assert.equal(drawn,true);
    assert.equal(canvas.width,512);assert.equal(canvas.height,768);
});


test('truncated prompt build preserves the draft and reports the limit instead of success',async()=>{
    const h=await harness({promptError:{code:'truncated'}});h.open();
    try {
        h.prompt().value='My existing portrait prompt';
        await h.button('Собрать промпт').click();
        assert.equal(h.prompt().value,'My existing portrait prompt');
        const status=h.nodes().find(n=>n.className==='bb-portrait-status').textContent;
        assert.match(status,/Прежний промпт сохранён/);assert.doesNotMatch(status,/Готово/);
        assert.equal(h.button('Собрать промпт').disabled,false);assert.equal(h.requests.length,0);
    } finally {h.close();}
});
