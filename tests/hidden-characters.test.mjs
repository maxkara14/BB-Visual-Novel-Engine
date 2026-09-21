import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

async function harness() {
    let names = ['Alex', '<Temari>'], current = true;
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.value = ''; this.listeners = {}; }
        append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
        setAttribute(key,value) { this[key] = value; }
        addEventListener(type,listener) { this.listeners[type] = listener; }
        click() { if (!this.disabled) this.listeners.click?.(); }
        focus() {}
        showModal() { this.open = true; }
        close() { this.open = false; }
        remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
        querySelector() { return null; }
    }
    const body = new Node('body');
    const nodes = () => { const out=[]; const walk=n=>{out.push(n);n.children.forEach(walk);};walk(body);return out; };
    const document = { body, createElement: tag=>new Node(tag), querySelector: ()=>nodes().find(n=>n.tagName==='dialog') };
    const sandbox=createContext({document});
    const module=new SourceTextModule(readFileSync(new URL('../modules/hidden-characters-ui.js',import.meta.url),'utf8'),{context:sandbox});
    const mocks = {
        './i18n.js': {t:text=>text},
        './social.js': {createHiddenCharacterSession:()=>({current:()=>current,list:()=>names.slice(),restore:name=>{names=name===null?[]:names.filter(n=>n!==name);return true;}})},
    };
    await module.link(name=>new SyntheticModule(Object.keys(mocks[name]),function(){for(const[k,v]of Object.entries(mocks[name]))this.setExport(k,v);},{context:sandbox}));
    await module.evaluate();
    return {api:module.namespace,body,nodes,button:text=>nodes().find(n=>n.tagName==='button'&&n.textContent===text),get names(){return names;},invalidate(){current=false;}};
}

test('hidden manager filters, restores one or all, and remains open',async()=>{
    const h=await harness();h.api.mountHiddenCharactersButton(h.body);h.button('Скрытые · 2').click();
    h.api.openHiddenCharacters();assert.equal(h.nodes().filter(n=>n.tagName==='dialog').length,1);
    const search=h.nodes().find(n=>n.tagName==='input');search.value='temari';search.listeners.input();
    const rows=()=>h.nodes().filter(n=>n.className==='bb-hidden-row');
    assert.equal(rows().length,1);assert.equal(rows()[0].children[1].textContent,'<Temari>');
    h.button('Вернуть').click();assert.deepEqual(h.names,['Alex']);assert.equal(rows().length,0);
    h.button('Вернуть всех').click();assert.deepEqual(h.names,[]);
    assert.equal(h.button('Вернуть всех').disabled,true);
    assert.equal(h.nodes().find(n=>n.tagName==='dialog').open,true);
    h.button('Закрыть').click();assert.equal(h.nodes().some(n=>n.tagName==='dialog'),false);
});

test('stale hidden manager refuses actions and explains how to reopen',async()=>{
    const h=await harness();h.api.openHiddenCharacters();h.invalidate();h.button('Вернуть').click();
    assert.deepEqual(h.names,['Alex','<Temari>']);
    assert.match(h.nodes().find(n=>n.className==='bb-portrait-status').textContent,/Откройте список заново/);
    assert.equal(h.button('Вернуть всех').disabled,true);
});
