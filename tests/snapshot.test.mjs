import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
const root = new URL('../modules/', import.meta.url);
async function harness() {
    const metadata = {}; let saves = 0;
    const nodes = new Map();
    const createNode = () => ({
        dataset: {}, children: [], attributes: {}, textContent: '', value: '',
        replaceChildren(...children) { this.children = children; this.textContent = ''; },
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = value; },
    });
    const context = { chat: [], chatId:'test-chat', name1:'Player', substituteParams: text=>text.replaceAll('{{user}}','Player'), callPopup:async()=>false };
    const settings = {'BB-Visual-Novel':{}};
    const sandbox = createContext({ Event, TextEncoder, console, setTimeout, clearTimeout, SillyTavern:{getContext:()=>context}, window:{}, document:{querySelector:selector=>nodes.get(selector)||null,createElement:createNode}, jQuery:()=>({val:()=>null}) });
    const mocks = {
        '../../../../../script.js': {chat_metadata:metadata,saveChatDebounced:()=>saves++,setExtensionPrompt(){},extension_prompt_roles:{SYSTEM:0},extension_prompt_types:{IN_CHAT:0},callPopup:async()=>false},
        '../../../../extensions.js': {extension_settings:settings},
        './generator.js': {buildChoiceContextPrompt:()=>'',getActiveChoiceContext:()=>null,tryBindPendingChoiceContextToMessage:()=>false},
        './toasts.js': {showStoryMomentToast(){},notifySuccess(){},notifyInfo(){},notifyError(){},pickToastMoment:(a,b)=>b,getMomentToastPriority:()=>0},
    };
    const cache=new Map();
    function load(name) {
        if(cache.has(name))return cache.get(name);
        const values=mocks[name];
        const mod=values?new SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context:sandbox}):new SourceTextModule(readFileSync(new URL(name,root),'utf8'),{context:sandbox,identifier:name});
        cache.set(name,mod);return mod;
    }
    const social=load('./social.js');await social.link(load);await social.evaluate();
    const editorUi=load('./memory-editor-ui.js');await editorUi.link(load);await editorUi.evaluate();
    const controls=load('./snapshot-controls.js');await controls.link(load);await controls.evaluate();
    return {editorUi:editorUi.namespace,editor:cache.get('./memory-editor.js').namespace,eventEditor:cache.get('./relationship-event-editor.js').namespace,nodes,createNode,controls:controls.namespace,breakdown:cache.get('./relationship-breakdown.js').namespace,api:social.namespace,snapshot:cache.get('./snapshot.js').namespace,state:cache.get('./state.js').namespace,context,metadata,settings,get saves(){return saves;}};
}
const fixture = () => ({schema_version:1,module:'BB-Visual-Novel',persona_label:'Original persona',data:{characters:{Alex:{affinity:25,romance:0,status:'Friend',history:[],memories:{soft:[],deep:[],archive:[]},core_traits:[]}},char_bases:{Alex:3},char_bases_romance:{},global_log:[{time:'12:00',type:'system',text:'Saved log'}],story_moments:[]}});

test('valid v1 export/import round trip keeps relationships and log',async()=>{
    const h=await harness();h.api.importActivePersonaSnapshot(fixture());h.api.recalculateAllStats(false);
    assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
    const exported=h.api.exportActivePersonaSnapshot();
    assert.equal(exported.module,'BB-Visual-Novel');assert.equal(exported.schema_version,1);
    assert.equal(exported.data.characters.Alex.affinity,25);assert.equal(exported.data.global_log[0].text,'Saved log');
    assert.equal(h.snapshot.parseSnapshot(JSON.stringify(exported)).summary.characters,1);
});

test('Russian relationship prompt uses Russian fields and the tracked character name',async()=>{
    const h=await harness();h.settings['BB-Visual-Novel'].outputLanguage='ru';
    h.api.importActivePersonaSnapshot(fixture());
    h.context.chat.push({name:'Alex',mes:'Alex enters the room',swipe_id:0,extra:{}});
    h.api.recalculateAllStats(false);
    const prompt=h.api.getCombinedSocial();
    assert.match(prompt,/Write newly generated human-readable text in Russian/);
    assert.match(prompt,/write <user_label>, <reason>, and <emotion> entirely in that language/);
    assert.match(prompt,/copy their canonical name exactly from \[CURRENT RELATIONSHIP STATUS\]/);
    assert.match(prompt,/use these exact canonical names in <name>: Alex/);
    assert.match(prompt,/Do not translate, transliterate, or change the script of a name/);
});
test('legacy bare data is accepted, unknown envelopes are not',async()=>{
    const h=await harness();assert.equal(h.snapshot.parseSnapshot(fixture().data).summary.format,'legacy');
    for(const change of [{module:'Other'},{schema_version:2},{schema_version:'1'},{schema_version:null}])assert.throws(()=>h.api.importActivePersonaSnapshot({...fixture(),...change}));
    assert.throws(()=>h.api.importActivePersonaSnapshot({data:fixture().data}));
});
test('invalid structures cannot partially modify persona data',async()=>{
    const h=await harness();h.api.importActivePersonaSnapshot(fixture());h.api.recalculateAllStats(false);
    const bad=[null,[],{}, {characters:[]},{characters:{Alex:null}}, {characters:{Alex:{affinity:'25'}}}, {characters:{Alex:{memories:{deep:[{text:7}]}}}}, {characters:{},char_registry:[]}, {characters:{},char_bases:{Alex:{}}}, {characters:{},ignored_chars:'Alex'}, {characters:{},global_log:[null]}, {characters:{},story_moments:[7]},JSON.parse('{"characters":{"__proto__":{}}}'), {characters:{},char_registry:{abc:{primary_name:'Alex',aliases:[{}]}}}];
    const before=JSON.stringify(h.metadata),stats=JSON.stringify(h.state.currentCalculatedStats),saves=h.saves;
    for(const value of bad)assert.throws(()=>h.api.importActivePersonaSnapshot(value));
    assert.throws(()=>h.api.importActivePersonaSnapshot('{broken'));
    assert.equal(JSON.stringify(h.metadata),before);assert.equal(JSON.stringify(h.state.currentCalculatedStats),stats);assert.equal(h.saves,saves);
});
test('size and nesting limits reject hostile input',async()=>{
    const h=await harness();
    assert.throws(()=>h.snapshot.parseSnapshot(' '.repeat(h.snapshot.MAX_SNAPSHOT_BYTES+1)),/SNAPSHOT_TOO_LARGE/);
    assert.throws(()=>h.snapshot.parseSnapshot(JSON.stringify({characters:{},text:'я'.repeat(h.snapshot.MAX_SNAPSHOT_BYTES/2)})),/SNAPSHOT_TOO_LARGE/);
    const data={characters:{}};let cursor=data;for(let i=0;i<42;i++){cursor.child={};cursor=cursor.child;}
    assert.throws(()=>h.snapshot.parseSnapshot(data));
});
test('repeated imports retain the original recovery point',async()=>{
    const h=await harness();const {scopeState}=h.api.bindActivePersonaState();scopeState.char_bases={Alex:7};
    h.api.importActivePersonaSnapshot(fixture());const second=fixture();second.data.char_bases.Alex=18;
    h.api.importActivePersonaSnapshot(second);assert.equal(scopeState.char_bases.Alex,18);
    assert.equal(h.api.clearActivePersonaSnapshot(),true);assert.equal(scopeState.char_bases.Alex,7);
    assert.equal(scopeState.snapshot_baseline,null);assert.equal(h.api.clearActivePersonaSnapshot(),false);
});
test('import preview cancellation, invalid file and changed chat never apply',async()=>{
    const h=await harness();let applied=0,confirmed=0,persona='A';const chat=h.context.chat;
    const file={size:100,name:'example.json',text:async()=>JSON.stringify(fixture())};
    const options={getContext:()=>h.context,getPersonaKey:()=>persona,confirm:async()=>{confirmed++;return false;},apply:()=>++applied};
    assert.equal(await h.snapshot.confirmSnapshotFile(file,options),null);assert.equal(confirmed,1);assert.equal(applied,0);
    await assert.rejects(h.snapshot.confirmSnapshotFile({...file,size:h.snapshot.MAX_SNAPSHOT_BYTES+1,text:()=>assert.fail('must not read')},options),/SNAPSHOT_TOO_LARGE/);
    await assert.rejects(h.snapshot.confirmSnapshotFile({...file,text:async()=>'{broken'},options));assert.equal(confirmed,1);
    options.confirm=async()=>{h.context.chat=[];return true;};
    await assert.rejects(h.snapshot.confirmSnapshotFile(file,options),/SNAPSHOT_CONTEXT_CHANGED/);
    h.context.chat=chat;options.confirm=async()=>{persona='B';return true;};
    await assert.rejects(h.snapshot.confirmSnapshotFile(file,options),/SNAPSHOT_CONTEXT_CHANGED/);assert.equal(applied,0);
});
test('confirmed preview reports source counts and applies the validated document',async()=>{
    const h=await harness();let applied;
    await h.snapshot.confirmSnapshotFile({size:100,text:async()=>JSON.stringify(fixture())},{getContext:()=>h.context,getPersonaKey:()=> 'A',confirm:async summary=>{assert.equal(summary.characters,1);assert.equal(summary.persona,'Original persona');assert.equal(summary.logs,1);return true;},apply:doc=>{applied=doc;return h.api.importActivePersonaSnapshot(doc);}});
    assert.equal(applied.schema_version,1);h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
});
test('post-import events replay once while pre-import messages stay behind cutoff',async()=>{
    const h=await harness();h.context.chat.push({name:'Alex',mes:'Earlier event',swipe_id:0,extra:{}});
    h.api.importActivePersonaSnapshot(fixture());
    const scope=h.api.getCurrentPersonaScopeKey();
    const event={name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'New action',emotion:'happy',scope};
    h.context.chat[0].extra.bb_social_swipes={0:[event]};
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
    assert.equal(h.api.markSnapshotReplayMessage(0,0,'test'),true);
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,27);
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,27);
    h.context.chat.push({name:'Alex',mes:'New scene',swipe_id:0,extra:{bb_social_swipes:{0:[{...event,reason:'Another concrete event'}]}}});
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,29);
});

test('clear after earned relationships, import, new events and export restores chat calculation',async()=>{
    const h=await harness();const {scopeState}=h.api.bindActivePersonaState();
    scopeState.char_bases={Alex:10};
    const scope=h.api.getCurrentPersonaScopeKey();
    const event={name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'Helped with a difficult task',emotion:'happy',scope};
    h.context.chat.push({name:'Alex',mes:'First scene',swipe_id:0,extra:{bb_social_swipes:{0:[event]}}});
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,12);
    h.api.importActivePersonaSnapshot(fixture());h.api.recalculateAllStats(false);
    assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
    h.context.chat.push({name:'Alex',mes:'Second scene',swipe_id:0,extra:{bb_social_swipes:{0:[{...event,reason:'Brought a thoughtful birthday present'}]}}});
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,27);
    const before=JSON.stringify(scopeState.snapshot_restore_state);
    assert.equal(h.api.exportActivePersonaSnapshot().data.characters.Alex.affinity,27);
    assert.equal(JSON.stringify(scopeState.snapshot_restore_state),before);
    h.api.clearActivePersonaSnapshot();h.api.recalculateAllStats(false);
    assert.equal(h.state.currentCalculatedStats.Alex.affinity,14);
    h.api.recalculateAllStats(false);assert.equal(h.state.currentCalculatedStats.Alex.affinity,14);
});

test('live parser diagnostics follow UI language without translating message text',async()=>{
 const h=await harness();const message={mes:'Текст сцены',extra:{}};
 h.settings['BB-Visual-Novel'].uiLanguage='en';
 h.api.scanAndCleanMessage(message,undefined,true);
 assert.equal(h.state.socialParseDebug.details,'No social_updates in the current response');
 assert.equal(message.mes,'Текст сцены');
 h.settings['BB-Visual-Novel'].uiLanguage='ru';
 h.api.scanAndCleanMessage(message,undefined,true);
 assert.equal(h.state.socialParseDebug.details,'В текущем ответе нет social_updates');
});

test('relationship explanation follows live totals, imports, limits, swipes and clear',async()=>{
 const h=await harness();const {scopeState}=h.api.bindActivePersonaState();scopeState.char_bases={Alex:99};
 const scope=h.api.getCurrentPersonaScopeKey();
 const event={name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'A thoughtful present',scope};
 const msg={name:'Alex',mes:'Alex opens the gift',swipe_id:0,swipes:['Alex opens the gift','Alex is disappointed'],extra:{bb_social_swipes:{0:[event],1:[{...event,friendship_impact:'minor_negative',reason:'An unwelcome interruption'}]}}};
 h.context.chat.push(msg);h.api.recalculateAllStats(false);
 const get=()=>h.breakdown.getRelationshipBreakdown(h.state.currentCalculatedStats.Alex,scopeState,'Alex');
 assert.equal(get().affinity.origin,99);assert.equal(get().affinity.change,1);assert.equal(get().affinity.total,100);
 msg.swipe_id=1;h.api.recalculateAllStats(false);assert.equal(get().affinity.change,-2);assert.equal(get().affinity.total,97);
 h.api.importActivePersonaSnapshot(fixture());h.api.recalculateAllStats(false);
 assert.equal(get().imported,true);assert.equal(get().affinity.origin,25);assert.equal(get().affinity.change,0);
 scopeState.char_bases.Alex=8;h.api.recalculateAllStats(false);assert.equal(get().affinity.adjustment,5);assert.equal(get().affinity.total,30);
 h.api.markSnapshotReplayMessage(0,1,'test');h.api.recalculateAllStats(false);assert.equal(get().affinity.change,-2);assert.equal(get().affinity.total,28);
 h.api.clearActivePersonaSnapshot();h.api.recalculateAllStats(false);assert.equal(get().imported,false);assert.equal(get().affinity.total,97);
 const exported=JSON.stringify(h.api.exportActivePersonaSnapshot()),metadata=JSON.stringify(h.metadata);
 h.settings['BB-Visual-Novel'].uiLanguage='en';
 const html=h.breakdown.buildRelationshipBreakdownHtml(h.state.currentCalculatedStats.Alex,scopeState,'Alex');
 assert.match(html,/How relationships add up/);assert.match(html,/Chat changes \(effective\)/);assert.match(html,/97/);
 assert.equal(JSON.stringify(h.metadata),metadata);assert.equal(JSON.stringify(h.api.exportActivePersonaSnapshot().data),JSON.stringify(JSON.parse(exported).data));
});
test('breakdown accounts for imported base clamping and zero net history',async()=>{
 const h=await harness();const data=fixture();data.data.characters.Alex.affinity=99;
 h.api.importActivePersonaSnapshot(data);const {scopeState}=h.api.bindActivePersonaState();scopeState.char_bases.Alex=13;
 h.api.recalculateAllStats(false);const d=h.breakdown.getRelationshipBreakdown(h.state.currentCalculatedStats.Alex,scopeState,'Alex');
 assert.equal(d.affinity.origin,99);assert.equal(d.affinity.adjustment,10);assert.equal(d.affinity.initialLimit,-9);assert.equal(d.affinity.change,0);assert.equal(d.affinity.total,100);
 const stats={affinity:0,romance:0,history:[{affinityDelta:-2},{affinityDelta:2}]};
 const neutral=h.breakdown.getRelationshipBreakdown(stats,{},'Alex');assert.equal(neutral.affinity.change,0);
 assert.equal(neutral.affinity.total,0);
});

test('romance breakdown uses effective negative limit and platonic filtering',async()=>{
 const h=await harness();const {scopeState}=h.api.bindActivePersonaState();scopeState.char_bases_romance={Alex:-99};
 const scope=h.api.getCurrentPersonaScopeKey();
 h.context.chat.push({name:'Alex',mes:'Alex refuses',swipe_id:0,extra:{bb_social_swipes:{0:[{name:'Alex',friendship_impact:'none',romance_impact:'minor_negative',reason:'Rejected a romantic invitation',scope}]}}});
 h.api.recalculateAllStats(false);
 let d=h.breakdown.getRelationshipBreakdown(h.state.currentCalculatedStats.Alex,scopeState,'Alex');
 assert.equal(d.romance.origin,-99);assert.equal(d.romance.change,-1);assert.equal(d.romance.total,-100);
 scopeState.platonic_chars=['Alex'];h.api.recalculateAllStats(false);
 d=h.breakdown.getRelationshipBreakdown(h.state.currentCalculatedStats.Alex,scopeState,'Alex');
 assert.equal(d.romance.change,0);assert.equal(d.romance.total,-99);
});

test('snapshot status supports new and old imports and escapes no untrusted HTML',async()=>{
 const h=await harness();const {scopeState}=h.api.bindActivePersonaState();
 assert.match(h.controls.snapshotStatusText(scopeState),/Импорт не активен/);
 h.api.importActivePersonaSnapshot(fixture());
 assert.ok(Number.isFinite(Date.parse(scopeState.snapshot_baseline.imported_at)));
 assert.match(h.controls.snapshotStatusText(scopeState),/основа активна/);
 delete scopeState.snapshot_baseline.imported_at;
 assert.match(h.controls.snapshotStatusText(scopeState),/время неизвестно/);
 h.settings['BB-Visual-Novel'].uiLanguage='en';
 assert.match(h.controls.snapshotStatusText(scopeState),/time unknown/);
 assert.match(h.controls.snapshotRemovalPrompt(false),/no saved recovery point/);
 assert.match(h.controls.snapshotRemovalPrompt(true),/before the first import/);
 h.api.clearActivePersonaSnapshot();assert.match(h.controls.snapshotStatusText(scopeState),/No active import/);
});
test('removal confirmation cancels safely and rejects scene, persona and baseline changes',async()=>{
 for(const change of ['cancel','chat','persona','length','baseline','none']){
  const h=await harness();h.api.importActivePersonaSnapshot(fixture());let persona='A',cleared=0;
  const scope=h.api.bindActivePersonaState().scopeState;
  const options={getContext:()=>h.context,getPersonaKey:()=>persona,getScope:()=>scope,
   confirm:async hasRestore=>{assert.equal(hasRestore,true);
    if(change==='cancel')return false;
    if(change==='chat')h.context.chat=[];
    if(change==='persona')persona='B';
    if(change==='length')h.context.chat.push({mes:'New message'});
    if(change==='baseline')h.api.importActivePersonaSnapshot(fixture());
    return true;},clear:()=>{cleared++;return h.api.clearActivePersonaSnapshot();}};
  if(['chat','persona','length','baseline'].includes(change))await assert.rejects(h.snapshot.confirmSnapshotRemoval(options),/SNAPSHOT_CONTEXT_CHANGED/);
  else assert.equal(await h.snapshot.confirmSnapshotRemoval(options),change==='none');
  assert.equal(cleared,change==='none'?1:0);
  if(change!=='none')assert.ok(scope.snapshot_baseline);
 }
});
test('legacy baseline without recovery requires confirmation and inactive baseline does nothing',async()=>{
 const h=await harness();let asked=0;const {scopeState}=h.api.bindActivePersonaState();
 const options={getContext:()=>h.context,getPersonaKey:()=> 'A',getScope:()=>scopeState,confirm:async hasRestore=>{asked++;assert.equal(hasRestore,false);return true;},clear:h.api.clearActivePersonaSnapshot};
 assert.equal(await h.snapshot.confirmSnapshotRemoval(options),false);assert.equal(asked,0);
 h.api.importActivePersonaSnapshot(fixture());scopeState.snapshot_restore_state=null;
 assert.equal(await h.snapshot.confirmSnapshotRemoval(options),true);assert.equal(asked,1);
});

test('snapshot controls refresh text and availability when scope changes',async()=>{
 const h=await harness();const status={},button={};
 h.nodes.set('#bb-social-snapshot-status',status);h.nodes.set('#bb-social-clear-snapshot-btn',button);
 h.controls.refreshSnapshotControls({});assert.equal(button.disabled,true);
 const scope={snapshot_baseline:{imported_at:'2026-09-18T12:00:00Z'}};
 h.controls.refreshSnapshotControls(scope);assert.equal(button.disabled,false);assert.match(status.textContent,/2026/);
 h.controls.refreshSnapshotControls({});assert.equal(button.disabled,true);assert.match(status.textContent,/Импорт не активен/);
});

test('imported record editor shows readable entries, filters, and a selected preview',async()=>{
 const h=await harness();
 for(const id of ['records','record-search','record-filters','record-list','record-preview','record-remove','record-undo']) {
  const selector=id==='records'?'#bb-social-snapshot-records':`#bb-social-snapshot-${id}`;
  h.nodes.set(selector,h.createNode());
 }
 const scope={snapshot_baseline:{characters:{Alex:{affinity:25,romance:0}},global_log:[{time:'12:00',text:'<div class="bb-glog-main"><span class="bb-glog-char">Alex</span><span class="bb-glog-delta">calm</span></div><div class="bb-glog-reason">Trust &amp; care</div><div class="bb-glog-points">🤝 Trust: +5</div>'}],story_moments:[{title:'A promise',text:'Alex remembered'}]}};
 h.controls.refreshSnapshotControls(scope);
 const list=h.nodes.get('#bb-social-snapshot-record-list');
 const preview=h.nodes.get('#bb-social-snapshot-record-preview');
 assert.equal(list.children.length,3);
 assert.equal(list.children[1].children[1].textContent,'Alex');
 assert.equal(list.children[1].children[2].textContent,'calm');
 assert.equal(list.children[1].children[3].textContent,'Trust & care');
 assert.equal(list.dataset.selected,'character:Alex');
 assert.equal(preview.children[1].textContent,'Alex');
 const filters=h.nodes.get('#bb-social-snapshot-record-filters');
 filters.dataset.filter='log';
 h.controls.refreshSnapshotControls(scope);
 assert.equal(list.children.length,1);
 assert.equal(list.dataset.selected,'log:0');
 assert.equal(preview.children[1].textContent,'Alex');
 assert.equal(preview.children[2].textContent,'calm');
 assert.equal(preview.children[3].textContent,'Trust & care');
 assert.equal(preview.children[4].children[0].textContent,'🤝 Trust: +5');
 const search=h.nodes.get('#bb-social-snapshot-record-search');
 search.value='missing';
 h.controls.refreshSnapshotControls(scope);
 assert.equal(list.children.length,0);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-remove').disabled,true);
});

test('one Data editor lists chat memories without import and imported entries after import',async()=>{
 const h=await harness();const scopeKey=h.api.getCurrentPersonaScopeKey();
 h.context.chat.push({name:'Alex',mes:'Alex says thanks',swipe_id:0,extra:{bb_social_swipes:{0:[{name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'Helped carry books',scope:scopeKey}]}}});
 h.api.recalculateAllStats(false);
 const scope=h.api.bindActivePersonaState().scopeState;
 let records=h.controls.listRelationshipEditorRecords(scope);
 const chatMemory=records.find(record=>record.kind==='memory');
 assert.equal(chatMemory.title,'Alex');assert.equal(chatMemory.imported,false);
 assert.equal(scope.snapshot_baseline,null);
 for(const id of ['records','record-search','record-filters','record-list','record-preview','record-remove','record-undo','record-text','record-text-label','record-hint','record-save','event-fields','event-mood','event-friendship','event-romance']) {
  h.nodes.set(id==='records'?'#bb-social-snapshot-records':`#bb-social-snapshot-${id}`,h.createNode());
 }
 h.controls.refreshSnapshotControls(scope);
 assert.equal(h.nodes.get('#bb-social-snapshot-records').hidden,false);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-text').value,'Helped carry books');
 assert.equal(h.nodes.get('#bb-social-snapshot-record-save').disabled,false);
 assert.match(h.nodes.get('#bb-social-snapshot-record-list').children[0].children[0].textContent,/Чат/);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-list').children[0].children.length,2);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-preview').hidden,true);
 h.nodes.get('#bb-social-snapshot-record-filters').dataset.filter='event';
 h.controls.refreshSnapshotControls(scope);
 assert.equal(h.nodes.get('#bb-social-snapshot-event-fields').hidden,false);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-text').value,'Helped carry books');
 assert.equal(h.nodes.get('#bb-social-snapshot-event-friendship').value,2);
 h.nodes.get('#bb-social-snapshot-record-filters').dataset.filter='memory';
 h.controls.refreshSnapshotControls(scope);
 const originalChat=h.context.chat;h.context.chat=[];
 assert.equal(h.controls.listRelationshipEditorRecords(scope).some(record=>record.kind==='memory'),false);
 h.context.chat=originalChat;
 h.editor.changeMemoryEntry(chatMemory.index,chatMemory.revision,'edit','A revised recollection');
 h.api.recalculateAllStats(false);
 records=h.controls.listRelationshipEditorRecords(scope);
 assert.equal(records.find(record=>record.kind==='memory').text,'A revised recollection');
 let memory=records.find(record=>record.kind==='memory');
 h.editor.changeMemoryEntry(memory.index,memory.revision,'delete');h.api.recalculateAllStats(false);
 h.controls.refreshSnapshotControls(scope);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-save').disabled,true);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-undo').disabled,false);
 memory=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='memory');
 h.editor.changeMemoryEntry(memory.index,memory.revision,'undo');h.api.recalculateAllStats(false);
 assert.equal(h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='memory').text,'A revised recollection');
 const imported=fixture();imported.data.characters.Alex.memories.archive=[{text:'Imported promise',delta:10,tone:'positive'}];
 h.api.importActivePersonaSnapshot(imported);h.api.recalculateAllStats(false);
 records=h.controls.listRelationshipEditorRecords(scope);
 assert.ok(records.some(record=>record.kind==='memory'&&record.imported&&record.text==='Imported promise'));
 assert.ok(records.some(record=>record.kind==='character'&&record.title==='Alex'));
 assert.ok(records.some(record=>record.kind==='log'));
 h.nodes.get('#bb-social-snapshot-record-filters').dataset.filter='log';
 h.controls.refreshSnapshotControls(scope);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-preview').hidden,false);
});

test('zero-point chat events still expose their character in the editor',async()=>{
 const h=await harness();const scopeKey=h.api.getCurrentPersonaScopeKey();
 h.context.chat.push({name:'Alex',mes:'Alex reacts',swipe_id:0,extra:{bb_social_swipes:{0:[{
  name:'Alex',friendship_impact:'none',romance_impact:'none',reason:'Stayed distant',emotion:'irritated',scope:scopeKey,
 }]}}});
 h.api.recalculateAllStats(false);
 const scope=h.api.bindActivePersonaState().scopeState;
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,0);
 const records=h.controls.listRelationshipEditorRecords(scope);
 assert.equal(records.filter(record=>record.kind==='character'&&record.title==='Alex').length,1);
 assert.equal(records.find(record=>record.kind==='character').readOnly,true);
 assert.equal(records.find(record=>record.kind==='event').friendshipDelta,0);
 for(const id of ['records','record-search','record-filters','record-list','record-preview','record-remove','record-undo']) {
  h.nodes.set(id==='records'?'#bb-social-snapshot-records':`#bb-social-snapshot-${id}`,h.createNode());
 }
 h.nodes.get('#bb-social-snapshot-record-filters').dataset.filter='character';
 h.controls.refreshSnapshotControls(scope);
 assert.match(h.nodes.get('#bb-social-snapshot-record-filters').children[1].textContent,/Персонажи 1/);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-remove').disabled,true);
 assert.equal(h.nodes.get('#bb-social-snapshot-record-undo').disabled,true);
});

test('editing a chat relationship event recalculates scores, memory, and journal with undo',async()=>{
 const h=await harness();const scopeKey=h.api.getCurrentPersonaScopeKey();
 const update={name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'Original reason',emotion:'calm',scope:scopeKey};
 h.context.chat.push({name:'Alex',mes:'Alex replies',swipe_id:0,extra:{bb_social_swipes:{0:[update]}}});
 h.api.recalculateAllStats(false);
 const scope=h.api.bindActivePersonaState().scopeState;
 let event=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 assert.ok(event);assert.equal(event.friendshipDelta,2);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,2);
 assert.equal(event.text,'Original reason');
 assert.throws(()=>h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'edit',{
  reason:'Invalid',mood:'',friendshipDelta:101,romanceDelta:0,
 }),/EDITOR_VALUE/);
 h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'edit',{
  reason:'Revised reason',mood:'hopeful',friendshipDelta:7,romanceDelta:3,
 });
 assert.throws(()=>h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'disable'),/EDITOR_STALE/);
 h.api.recordActivePersonaBranchState();h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,7);
 assert.equal(h.state.currentCalculatedStats.Alex.romance,3);
 assert.equal(h.state.currentCalculatedStats.Alex.memories.soft[0].text,'Revised reason');
 assert.match(h.api.exportActivePersonaSnapshot().data.global_log.at(-1).text,/Revised reason/);
 assert.equal(update.reason,'Original reason');
 event=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'disable');
 h.api.recordActivePersonaBranchState();h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex,undefined);
 assert.equal(h.api.exportActivePersonaSnapshot().data.global_log.length,0);
 event=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 assert.equal(event.disabled,true);assert.equal(event.canUndo,true);
 h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'undo');
 h.api.recordActivePersonaBranchState();h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,7);
 const reloaded=await harness();Object.assign(reloaded.metadata,structuredClone(h.metadata));
 reloaded.context.chat=structuredClone(h.context.chat);reloaded.api.recalculateAllStats(false);
 assert.equal(reloaded.state.currentCalculatedStats.Alex.affinity,7);
 assert.equal(reloaded.controls.listRelationshipEditorRecords(reloaded.api.bindActivePersonaState().scopeState).find(record=>record.kind==='event').text,'Revised reason');
});

test('a platonic relationship event cannot save attraction points',async()=>{
 const h=await harness();const scopeKey=h.api.getCurrentPersonaScopeKey();
 h.context.chat.push({name:'Alex',mes:'Alex replies',swipe_id:0,extra:{bb_social_swipes:{0:[{
  name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'A conversation',scope:scopeKey,
 }]}}});
 h.api.recalculateAllStats(false);
 const scope=h.api.bindActivePersonaState().scopeState;
 scope.platonic_chars=['Alex'];h.api.recalculateAllStats(false);
 const event=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 assert.equal(event.platonic,true);
 assert.throws(()=>h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'edit',{
  reason:'A conversation',mood:'calm',friendshipDelta:3,romanceDelta:2,
 }),/EDITOR_VALUE/);
});

test('a branch before an event edit keeps the earlier relationship change',async()=>{
 const parent=await harness();parent.metadata.integrity='parent';
 const scopeKey=parent.api.getCurrentPersonaScopeKey();
 parent.context.chat.push({name:'Alex',mes:'First',swipe_id:0,extra:{bb_social_swipes:{0:[{name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'First event',scope:scopeKey}]}}});
 parent.api.recalculateAllStats(false);
 parent.context.chat.push({name:'Alex',mes:'Later',swipe_id:0,extra:{}});parent.api.recalculateAllStats(false);
 const scope=parent.api.bindActivePersonaState().scopeState;
 const event=parent.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 parent.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'edit',{
  reason:'Revised later',mood:'',friendshipDelta:9,romanceDelta:0,
 });
 parent.api.recordActivePersonaBranchState();parent.api.recalculateAllStats(false);
 assert.equal(parent.state.currentCalculatedStats.Alex.affinity,9);
 async function branch(length) {
  const child=await harness();Object.assign(child.metadata,structuredClone(parent.metadata),{integrity:`branch-${length}`,main_chat:'parent'});
  child.context.chatId=`branch-${length}`;child.context.chat=structuredClone(parent.context.chat.slice(0,length));
  child.api.recalculateAllStats(false);return child;
 }
 assert.equal((await branch(1)).state.currentCalculatedStats.Alex.affinity,2);
 assert.equal((await branch(2)).state.currentCalculatedStats.Alex.affinity,9);
});

test('relationship event edits follow the selected swipe',async()=>{
 const h=await harness();const scopeKey=h.api.getCurrentPersonaScopeKey();
 const message={name:'Alex',mes:'First',swipe_id:0,swipes:['First','Second'],extra:{bb_social_swipes:{
  0:[{name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'First event',scope:scopeKey}],
  1:[{name:'Alex',friendship_impact:'minor_negative',romance_impact:'none',reason:'Second event',scope:scopeKey}],
 }}};
 h.context.chat.push(message);h.api.recalculateAllStats(false);
 const scope=h.api.bindActivePersonaState().scopeState;
 const event=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'edit',{
  reason:'Edited first',mood:'',friendshipDelta:6,romanceDelta:0,
 });h.api.recordActivePersonaBranchState();h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,6);
 const edited=h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event');
 message.swipe_id=1;message.mes='Second';
 assert.throws(()=>h.eventEditor.changeRelationshipEvent(scope,edited.index,edited.revision,'disable'),/EDITOR_STALE/);
 h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,-2);
 assert.equal(h.controls.listRelationshipEditorRecords(scope).find(record=>record.kind==='event').text,'Second event');
 message.swipe_id=0;message.mes='First';h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,6);
});

test('the editor lists post-import chat changes beside imported journal entries',async()=>{
 const h=await harness();const scopeKey=h.api.getCurrentPersonaScopeKey();
 const makeMessage=(reason)=>({name:'Alex',mes:reason,swipe_id:0,extra:{bb_social_swipes:{0:[{
  name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason,scope:scopeKey,
 }]}}});
 h.context.chat.push(makeMessage('Before import'));h.api.recalculateAllStats(false);
 h.api.importActivePersonaSnapshot(fixture());
 h.context.chat.push(makeMessage('After import'));h.api.recalculateAllStats(false);
 const scope=h.api.bindActivePersonaState().scopeState;
 const records=h.controls.listRelationshipEditorRecords(scope);
 assert.equal(records.filter(record=>record.kind==='event').map(record=>record.text).join('|'),'After import');
 assert.ok(records.some(record=>record.kind==='log'&&record.text==='Saved log'));
 const event=records.find(record=>record.kind==='event');
 h.eventEditor.changeRelationshipEvent(scope,event.index,event.revision,'disable');
 h.api.recordActivePersonaBranchState();h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
 assert.equal(h.api.exportActivePersonaSnapshot().data.global_log.length,1);
});

test('snapshot removal confirmation separates journal fields and escapes saved text',async()=>{
 const h=await harness();
 const prompt=h.controls.snapshotRecordRemovalPrompt({
  kind:'log',number:1,title:'Alex <script>',mood:'calm & curious',
  reason:'A promise <img src=x>',points:['🤝 Trust: +5'],detail:'12:00',text:'flattened entry',
 });
 assert.match(prompt,/bb-vn-snapshot-confirm-field/);
 assert.match(prompt,/calm &amp; curious/);
 assert.match(prompt,/A promise &lt;img src=x&gt;/);
 assert.match(prompt,/🤝 Trust: \+5/);
 assert.doesNotMatch(prompt,/<script>|<img src=x>|flattened entry/);
 const fallback=h.controls.snapshotRecordRemovalPrompt({kind:'log',number:2,title:'#2',text:'Old journal text',detail:'13:00'});
 assert.match(fallback,/Old journal text/);
});

test('memory edits persist on sources, undo deletion and preserve scores and journal across swipes',async()=>{
 const h=await harness();const scope=h.api.getCurrentPersonaScopeKey();
 const event={name:'Alex',friendship_impact:'minor_positive',romance_impact:'none',reason:'Helped carry books',scope};
 const msg={name:'Alex',mes:'Alex says thanks',swipe_id:0,swipes:['Alex says thanks','Alex turns away'],extra:{bb_social_swipes:{0:[event],1:[{...event,reason:'Shared an umbrella'}]}}};
 h.context.chat.push(msg);h.api.recalculateAllStats(false);
 const score=h.state.currentCalculatedStats.Alex.affinity;
 const originalLog=h.api.exportActivePersonaSnapshot().data.global_log.map(e=>e.text);
 const entry=()=>h.editor.memoryEditorEntries('Alex')[0];
 let record=entry();h.editor.changeMemoryEntry(record.index,record.revision,'edit','A revised recollection');h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.memories.soft[0].text,'A revised recollection');
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,score);
 assert.deepEqual(h.api.exportActivePersonaSnapshot().data.global_log.map(e=>e.text),originalLog);
 assert.equal(event.reason,'Helped carry books');
 msg.swipe_id=1;h.api.recalculateAllStats(false);assert.equal(entry().text,'Shared an umbrella');
 msg.swipe_id=0;h.api.recalculateAllStats(false);assert.equal(entry().text,'A revised recollection');
 record=entry();h.editor.changeMemoryEntry(record.index,record.revision,'delete');h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.memories.soft.length,0);assert.equal(entry().hidden,true);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,score);
 record=entry();h.editor.changeMemoryEntry(record.index,record.revision,'undo');h.api.recalculateAllStats(false);assert.equal(entry().text,'A revised recollection');
 record=entry();h.editor.changeMemoryEntry(record.index,record.revision,'undo');h.api.recalculateAllStats(false);assert.equal(entry().text,'Helped carry books');
 record=entry();h.editor.changeMemoryEntry(record.index,record.revision,'edit','Persisted');h.api.recalculateAllStats(false);
 // Rehydrate serialized chat and metadata into fresh modules, as after a reload.
 const reloaded=await harness();Object.assign(reloaded.metadata,JSON.parse(JSON.stringify(h.metadata)));reloaded.context.chat=JSON.parse(JSON.stringify(h.context.chat));
 reloaded.api.recalculateAllStats(false);assert.equal(reloaded.state.currentCalculatedStats.Alex.memories.soft[0].text,'Persisted');
 assert.equal(reloaded.editor.memoryEditorEntries('Alex')[0].canUndo,true);
});
test('imported memory and trait edits are materialized in exports, including archived memories',async()=>{
 const h=await harness();const data=fixture();
 data.data.characters.Alex.memories.archive=[{text:'Archived promise',delta:10,tone:'positive'}];
 data.data.characters.Alex.core_traits=[{trait:'Kind: Offers help',type:'positive'}];
 h.api.importActivePersonaSnapshot(data);h.context.chat.push({name:'Alex',mes:'Alex waits',extra:{}});h.api.recalculateAllStats(false);
 let rows=h.editor.memoryEditorEntries('Alex');assert.equal(rows.length,2);
 let trait=rows.find(r=>r.kind==='trait');
 assert.throws(()=>h.editor.changeMemoryEntry(trait.index,trait.revision,'edit','No separator'),/EDITOR_TEXT/);
 h.editor.changeMemoryEntry(trait.index,trait.revision,'edit','Patient: Listens first');h.api.recalculateAllStats(false);
 const archive=h.editor.memoryEditorEntries('Alex').find(r=>r.kind==='archive');h.editor.changeMemoryEntry(archive.index,archive.revision,'delete');h.api.recalculateAllStats(false);
 const exported=h.api.exportActivePersonaSnapshot();assert.equal(exported.data.characters.Alex.affinity,25);
 assert.equal(exported.data.characters.Alex.memories.archive.length,0);assert.equal(exported.data.characters.Alex.core_traits[0].trait,'Patient: Listens first');
 assert.equal(JSON.stringify(exported).includes('bb_vn_text_edits'),false);
 const other=await harness();other.api.importActivePersonaSnapshot(exported);other.api.recalculateAllStats(false);
 assert.equal(other.state.currentCalculatedStats.Alex.core_traits[0].trait,'Patient: Listens first');
 assert.equal(other.state.currentCalculatedStats.Alex.memories.archive.length,0);
});
test('editor rejects stale operations and separates personas on a shared source',async()=>{
 const h=await harness();const source={};
 const calculate=scope=>{h.editor.resetMemoryEditor();const stats={memories:{soft:[h.editor.trackEditableRecord({text:'Original'},source,'positive','text')]},core_traits:[]};h.editor.applyMemoryEdits(stats,scope,'Alex');return stats;};
 calculate('A');let row=h.editor.memoryEditorEntries('Alex')[0];h.editor.changeMemoryEntry(row.index,row.revision,'edit','Persona A');
 assert.throws(()=>h.editor.changeMemoryEntry(row.index,row.revision,'delete'),/EDITOR_STALE/);
 assert.equal(calculate('B').memories.soft[0].text,'Original');assert.equal(calculate('A').memories.soft[0].text,'Persona A');
});

test('memory editor renders escaped text and guards delayed confirmation against changed scene',async()=>{
 const h=await harness();const source={};
 const stats={memories:{soft:[h.editor.trackEditableRecord({text:'<img src=x onerror=alert(1)>'},source,'positive','text')]},core_traits:[]};
 h.editor.resetMemoryEditor();h.editor.applyMemoryEdits(stats,'A','Alex');
 h.settings['BB-Visual-Novel'].uiLanguage='en';
 const html=h.editorUi.buildMemoryEditorHtml('Alex');assert.match(html,/Memory and trait editor/);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
 const listeners={};const row=h.editor.memoryEditorEntries('Alex')[0];
 const select={value:String(row.index),options:[{value:String(row.index)}],addEventListener(){},dispatchEvent(){}};
 const text={};const buttons=['edit','delete','undo'].map(action=>({dataset:{action},addEventListener(type,callback){listeners[action]=callback;}}));
 const editor={dataset:{char:'Alex'},querySelector:selector=>selector==='.bb-memory-select'?select:text,querySelectorAll:()=>buttons};
 const root={querySelectorAll:()=>[editor]};let changed=0,errors=[];
 h.editorUi.mountMemoryEditors(root,{getContext:()=>h.context,getPersonaKey:()=> 'A',confirm:async()=>{h.context.chat.push({mes:'New scene'});return true;},changed:()=>changed++,error:message=>errors.push(message)});
 await listeners.delete({stopPropagation(){}});assert.equal(changed,0);assert.equal(errors.length,1);assert.equal(source.bb_vn_text_edits,undefined);
 h.editorUi.mountMemoryEditors(root,{getContext:()=>h.context,getPersonaKey:()=> 'A',confirm:async()=>false,changed:()=>changed++,error:message=>errors.push(message)});
 await listeners.delete({stopPropagation(){}});assert.equal(changed,0);
 text.value='Edited safely';await listeners.edit({stopPropagation(){}});assert.equal(changed,1);assert.equal(source.bb_vn_text_edits.A.positive.text,'Edited safely');
});
test('trait edits from chat survive recalculation and archive retention does not multiply',async()=>{
 const h=await harness();const scope=h.api.getCurrentPersonaScopeKey();
 h.context.chat.push({name:'Alex',mes:'Alex is patient',swipe_id:0,extra:{bb_vn_char_traits_swipes:{0:[{charName:'Alex',trait:'Patient: Waits calmly',type:'positive',scope}]}}});h.api.recalculateAllStats(false);
 const row=h.editor.memoryEditorEntries('Alex').find(r=>r.kind==='trait');assert.ok(row);
 h.editor.changeMemoryEntry(row.index,row.revision,'edit','Patient: Thinks first');h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.core_traits[0].trait,'Patient: Thinks first');
 assert.equal(h.context.chat[0].extra.bb_vn_char_traits_swipes[0][0].trait,'Patient: Waits calmly');
 const imported=fixture();imported.data.characters.Alex.memories.archive=[{text:'Old promise',delta:10,tone:'positive'}];
 h.api.importActivePersonaSnapshot(imported);h.api.recalculateAllStats(false);h.api.recalculateAllStats(false);
 assert.equal(h.state.currentCalculatedStats.Alex.memories.archive.length,1);
});

test('memory undo is bounded and edited text reaches the social prompt',async()=>{
 const h=await harness();const data=fixture();data.data.characters.Alex.memories.deep=[{text:'Original promise',delta:10,tone:'positive'}];
 h.api.importActivePersonaSnapshot(data);h.context.chat.push({name:'Alex',mes:'Alex remembers the promise',extra:{}});h.api.recalculateAllStats(false);
 for(let i=0;i<22;i++){
  const row=h.editor.memoryEditorEntries('Alex').find(r=>r.kind==='deep');h.editor.changeMemoryEntry(row.index,row.revision,'edit','Rewritten promise '+i);h.api.recalculateAllStats(false);
 }
 assert.match(h.api.getCombinedSocial(),/Rewritten promise 21/);
 const scope=h.api.bindActivePersonaState().scopeState;
 const stored=scope.snapshot_baseline.characters.Alex.memories.deep[0];
 assert.equal(Object.values(stored.bb_vn_text_edits)[0].memory.undo.length,20);
 for(let i=0;i<20;i++){
  const row=h.editor.memoryEditorEntries('Alex')[0];h.editor.changeMemoryEntry(row.index,row.revision,'undo');h.api.recalculateAllStats(false);
 }
 assert.equal(h.editor.memoryEditorEntries('Alex')[0].canUndo,false);
 assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
});

test('memory selector previews are bounded without truncating the editable record',async()=>{
 const h=await harness();h.settings['BB-Visual-Novel'].uiLanguage='en';
 const original='A long memory with many details '.repeat(20);
 const record=h.editor.trackEditableRecord({text:original},{},'positive','text');
 h.editor.resetMemoryEditor();h.editor.applyMemoryEdits({memories:{soft:[record]},core_traits:[]},'A','Alex');
 const html=h.editorUi.buildMemoryEditorHtml('Alex');
 const label=html.match(/<option value="0">([^<]*)<\/option>/)[1];
 assert.ok(Array.from(label).length<=32);assert.ok(label.endsWith('…'));
 assert.equal(h.editor.memoryEditorEntries('Alex')[0].text,original);
});


test('restore one hidden character preserves others, profile and relationship data',async()=>{
    const h=await harness();const data=fixture();data.data.ignored_chars=['Alex','Other'];
    h.api.importActivePersonaSnapshot(data);h.api.recalculateAllStats(false);
    const session=h.api.createHiddenCharacterSession();
    assert.deepEqual(Array.from(session.list()),['Alex','Other']);
    assert.equal(session.restore('Alex'),true);
    assert.deepEqual(Array.from(h.metadata.bb_vn_ignored_chars),['Other']);
    assert.equal(h.state.currentCalculatedStats.Alex.affinity,25);
    const saves=h.saves;assert.equal(session.restore('Missing'),false);assert.equal(h.saves,saves);
    assert.equal(session.restore(),true);assert.equal(session.list().length,0);
});

test('a restore session cannot change a different chat',async()=>{
    const h=await harness();const data=fixture();data.data.ignored_chars=['Alex'];h.api.importActivePersonaSnapshot(data);
    const session=h.api.createHiddenCharacterSession();h.context.chatId='other';h.context.chat=[];
    const before=JSON.stringify(h.metadata);const saves=h.saves;
    assert.equal(session.restore('Alex'),false);assert.equal(session.restore(),false);
    assert.equal(JSON.stringify(h.metadata),before);assert.equal(h.saves,saves);
});


test('a restore session rejects a different persona',async()=>{
    const h=await harness();h.context.user_avatar='persona-a.png';
    const data=fixture();data.data.ignored_chars=['Alex'];h.api.importActivePersonaSnapshot(data);
    const session=h.api.createHiddenCharacterSession();h.context.user_avatar='persona-b.png';
    assert.equal(session.current(),false);assert.equal(session.restore(),false);
});
