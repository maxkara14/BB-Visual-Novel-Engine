import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
const root = new URL('../modules/', import.meta.url);
async function harness() {
    const metadata = {}; let saves = 0;
    const context = { chat: [], chatId:'test-chat', name1:'Player', substituteParams: text=>text.replaceAll('{{user}}','Player'), callPopup:async()=>false };
    const settings = {'BB-Visual-Novel':{}};
    const sandbox = createContext({ TextEncoder, console, setTimeout, clearTimeout, SillyTavern:{getContext:()=>context}, window:{}, document:{querySelector:()=>null}, jQuery:()=>({val:()=>null}) });
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
    return {breakdown:cache.get('./relationship-breakdown.js').namespace,api:social.namespace,snapshot:cache.get('./snapshot.js').namespace,state:cache.get('./state.js').namespace,context,metadata,settings,get saves(){return saves;}};
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
