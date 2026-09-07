import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { createNeutralNativeBotPackage, type NativeCommandInput } from '../core/native-bot.js';
import type { PromptProgram } from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import type { PromptPreset } from '../core/product.js';

const owned:Store[]=[];
afterEach(()=>{while(owned.length)owned.pop()!.close();});
function database() {const store=new Store(join(mkdtempSync(join(tmpdir(),'Uimori native integration ')),'test.sqlite'));owned.push(store);return store;}
function fixture() {
  const store=database();const chat=store.createChat('Native integration fixture');store.settings(chat.id,chat.settingsRevision,{...chat.settings,translation:false,status:false});
  const native=store.native.importPackage(createNeutralNativeBotPackage());const branchId=`main:${chat.id}`;
  store.native.attach(chat.id,{branchId,packageId:native.id,packageRevision:native.revision,expectedRevision:0,expectedSourceRevision:null,expectedSourceHash:null,idempotencyKey:randomUUID()});
  const program:PromptProgram={version:1,controls:[{id:'tone',label:'Tone',type:'select',default:'calm',options:[{label:'Calm',value:'calm'},{label:'Bright',value:'bright'}]}],blocks:[{id:'instructions',title:'Instructions',kind:'message',role:'system',template:[{kind:'text',text:'SYNTHETIC_TONE='},{kind:'value',expression:{control:'tone'}}]},{id:'native',title:'Native bot',kind:'slot',role:'system',slot:'bot'},{id:'lore',title:'Pinned lore',kind:'slot',role:'system',slot:'lore'},{id:'conversation',title:'Conversation',kind:'history',from:0,to:'end'},{id:'cache',title:'Recent cache',kind:'cache',depth:2,role:'all',policy:'prefer'}]};
  const preset=store.product.promptPreset({title:'Synthetic native program',role:'main',text:'',program}) as PromptPreset;
  const f={store,chatId:chat.id,branchId,preset};setControls(f,'calm');return f;
}
function setControls(f:ReturnType<typeof fixture>,tone:'calm'|'bright') {
  const p=f.store.product.profile(f.chatId);return f.store.product.updateProfile(f.chatId,{expectedRevision:p.revision,attachments:p.attachments,creative:p.creative,routes:p.routes,image:p.image,prompts:{main:{id:f.preset.id,revision:f.preset.revision}},promptControls:{[`${f.preset.id}@${f.preset.revision}`]:{values:{tone},combinations:[{id:'saved',title:'Saved synthetic choice',values:{tone}}],selectedCombinationId:'saved'}}});
}
function nativeCommand(f:ReturnType<typeof fixture>,command:NativeCommandInput,branchId=f.branchId) {const n=f.store.native.snapshot(f.chatId,branchId)!;return f.store.native.command(f.chatId,{branchId,expectedRevision:n.revision,expectedSourceRevision:n.sourceRevision,expectedSourceHash:n.sourceHash,idempotencyKey:randomUUID(),command});}
function run(f:ReturnType<typeof fixture>,request:string,options:{key?:string;nativeCommandId?:string;branchId?:string}={}) {
  const branchId=options.branchId??f.branchId;const branch=f.store.product.branch(f.chatId,branchId);const chat=f.store.chat(f.chatId);
  return f.store.createRun(f.chatId,{branchId,request,expectedRevision:branch.headRevision,expectedSettingsRevision:chat.settingsRevision,idempotencyKey:options.key??randomUUID(),...(options.nativeCommandId?{nativeCommandId:options.nativeCommandId}:{})},selected=>{const profile=f.store.product.snapshot(f.chatId)!;return{chatId:f.chatId,parentRevision:selected.headRevision,settingsRevision:selected.settingsRevision,settings:selected.settings,request,history:f.store.history(selected.headRevision),resources:f.store.product.resources(f.chatId,profile),profile} satisfies RunSnapshot;});
}
function complete(f:ReturnType<typeof fixture>,id:string,text:string) {const r=f.store.run(id);expect(f.store.startRun(id)).toBe(true);return f.store.completeRun(id,text,{modelCalls:0,inputTokens:null,outputTokens:null,costUsd:null},r.snapshot.settings);}

describe('native Run/archive/fork integration (fresh file DB, synthetic only)',()=>{
  test('Run freezes controls/native values and reconstructs actual user/assistant history roles',()=>{
    const f=fixture();const first=run(f,'FIRST_USER_REQUEST').run;const frozen=structuredClone(first.snapshot);const s=complete(f,first.id,'FIRST_ASSISTANT_PROSE');
    nativeCommand(f,{kind:'set-stat',field:'trust',value:50});nativeCommand(f,{kind:'language',value:'kr'});setControls(f,'bright');
    const second=run(f,'SECOND_USER_REQUEST').run;expect(f.store.run(first.id).snapshot).toEqual(frozen);expect(first.snapshot.promptCompilation!.values).toEqual({tone:'calm'});expect(second.snapshot.promptCompilation!.values).toEqual({tone:'bright'});expect(second.snapshot.nativeBot!.state).toMatchObject({trust:50,language:'kr'});
    const history=second.snapshot.promptCompilation!.messages.filter(m=>m.provenance.origin!=='prompt');expect(history.map(m=>m.role)).toEqual(['user','assistant','user']);expect(history.map(m=>m.content[0].text)).toEqual(['FIRST_USER_REQUEST','FIRST_ASSISTANT_PROSE','SECOND_USER_REQUEST']);expect(history[1].provenance).toMatchObject({sourceRevision:s.id,sourceHash:s.hash,runId:first.id});
    expect(second.snapshot.resources.filter(r=>r.id.startsWith('native:'))).toHaveLength(45);expect(second.snapshot.resources.every(r=>!r.description.includes('group'))).toBe(true);expect(f.store.product.attempts(f.chatId)).toHaveLength(0);
  });
  test('nativeCommandId is consumed exactly once and stale revision/hash cannot queue a replacement',()=>{
    const f=fixture();const selected=nativeCommand(f,{kind:'scene',id:'scene-1'});const pending=selected.pending!;const key=randomUUID();const first=run(f,pending.request,{nativeCommandId:pending.commandId,key});expect(first.created).toBe(true);expect(first.run.snapshot.nativeBot!.pending).toEqual(pending);expect(f.store.native.detail(f.chatId)!.pending).toBeNull();expect(run(f,pending.request,{nativeCommandId:pending.commandId,key})).toMatchObject({created:false,run:{id:first.run.id}});
    f.store.finishRun(first.run.id,'cancelled','synthetic cancellation');expect(()=>run(f,pending.request,{nativeCommandId:pending.commandId})).toThrow('Native command no longer');
    const base=run(f,'BASE_REQUEST').run;const source=complete(f,base.id,'The original scene.');const selectedAgain=nativeCommand(f,{kind:'scene',id:'scene-2'});f.store.editSource(source.id,{text:'The edited scene.',expectedRevision:0});expect(f.store.native.snapshot(f.chatId)!.pending).toBeNull();expect(()=>run(f,selectedAgain.pending!.request,{nativeCommandId:selectedAgain.pending!.commandId})).toThrow('Native command no longer');
    expect(()=>f.store.native.command(f.chatId,{branchId:f.branchId,expectedRevision:selectedAgain.revision,expectedSourceRevision:source.id,expectedSourceHash:source.hash,idempotencyKey:randomUUID(),command:{kind:'language',value:'jp'}})).toThrow('hash conflict');
    expect(()=>f.store.native.command(f.chatId,{branchId:f.branchId,expectedRevision:selectedAgain.revision-1,expectedSourceRevision:source.id,expectedSourceHash:f.store.source(source.id).hash,idempotencyKey:randomUUID(),command:{kind:'language',value:'jp'}})).toThrow('revision conflict');
  });
  test('archive v5 restores frozen compilation/native ownership and fork remaps exact logical history',()=>{
    const f=fixture();const first=run(f,'FIRST_REQUEST').run;complete(f,first.id,'FIRST_PROSE');nativeCommand(f,{kind:'set-stat',field:'trust',value:55});setControls(f,'bright');const second=run(f,'SECOND_REQUEST').run;const s=complete(f,second.id,'SECOND_PROSE');
    const archive=f.store.product.export();expect(archive.version).toBe(8);expect(archive.tables.native_state_config_owners).toHaveLength(2);const before=structuredClone(archive);const restored=database();expect(restored.product.import(archive)).toEqual({restored:true,chats:1});expect(archive).toEqual(before);expect(restored.run(second.id).snapshot.promptCompilation).toEqual(second.snapshot.promptCompilation);expect(restored.native.snapshot(f.chatId)!.package.assets).toHaveLength(114);expect(restored.story.configForBranch(f.chatId,f.branchId).revision).toBe(2);
    const fork=forkChat(restored,f.chatId,{fromRevision:s.id,title:'Native fork',idempotencyKey:'fork-synthetic'});const source=restored.source(fork.headRevision!);const copied=restored.run(source.runId);expect(source.text).toBe('SECOND_PROSE');expect(copied.snapshot.nativeBot!.branchId).toBe(`main:${fork.id}`);expect(copied.snapshot.promptCompilation!.values).toEqual({tone:'bright'});const proseMessages=(snapshot:typeof second.snapshot)=>snapshot.promptCompilation!.messages.filter(m=>m.id!=='native.host-context').map(m=>[m.role,m.content]);expect(proseMessages(copied.snapshot)).toEqual(proseMessages(second.snapshot));
    const hostContext=(snapshot:typeof second.snapshot)=>JSON.parse(snapshot.promptCompilation!.messages.find(m=>m.id==='native.host-context')!.content[0].text.split('\n').slice(1).join('\n'));
    const expectedContext=hostContext(second.snapshot);expectedContext.source.parentRevision=copied.snapshot.parentRevision;expectedContext.source.state.sourceRevision=copied.snapshot.parentRevision;expect(hostContext(copied.snapshot)).toEqual(expectedContext);expect(restored.run(second.id).snapshot).toEqual(second.snapshot);
    expect(copied.snapshot.logicalHistory![0].sourceRevision).not.toBe(second.snapshot.logicalHistory![0].sourceRevision);expect(copied.snapshot.logicalHistory![0].sourceHash).toBe(second.snapshot.logicalHistory![0].sourceHash);expect(restored.native.snapshot(fork.id)!.pending).toBeNull();expect(restored.product.attempts(fork.id)).toHaveLength(0);
    const roundtrip=database();expect(roundtrip.product.import(restored.product.export())).toEqual({restored:true,chats:2});expect(roundtrip.source(fork.headRevision!).text).toBe('SECOND_PROSE');
  });
  test('distinct native module branches freeze independently and archive rejects forged compilation atomically',()=>{
    const f=fixture();const other=f.store.product.createBranch(f.chatId,{title:'Other native module',fromRevision:null});const p=createNeutralNativeBotPackage();p.stateModule.id='different-native-module';p.stateModule.name='Different synthetic module';const saved=f.store.native.importPackage(p);f.store.native.attach(f.chatId,{branchId:other.id,packageId:saved.id,packageRevision:saved.revision,expectedRevision:0,expectedSourceRevision:null,expectedSourceHash:null,idempotencyKey:randomUUID()});nativeCommand(f,{kind:'volume',value:'extra'},other.id);
    const a=run(f,'MAIN_REQUEST').run;const b=run(f,'OTHER_REQUEST',{branchId:other.id}).run;expect(a.snapshot.story!.config.module!.id).not.toBe(b.snapshot.story!.config.module!.id);expect(a.snapshot.story!.config.module!.rules['trust-increase'].delta).toBe(1);expect(b.snapshot.story!.config.module!.rules['trust-increase'].delta).toBe(3);complete(f,a.id,'Main source');complete(f,b.id,'Other source');
    const archive=f.store.product.export();const row=archive.tables.runs.find((r:any)=>r.id===a.id)!;const snapshot=JSON.parse(row.snapshot as string);snapshot.promptCompilation.messages[0].content[0].text='FORGED';row.snapshot=JSON.stringify(snapshot);const target=database();expect(()=>target.product.import(archive)).toThrow('compiled prompt mismatch');expect(target.chats()).toHaveLength(0);expect(target.native.list()).toHaveLength(0);
  });
  test('candidate branch keeps frozen native rules, next-run controls and archive-valid branch identities',()=>{
    const f=fixture();const original=run(f,'CANDIDATE_USER_REQUEST').run;complete(f,original.id,'ORIGINAL_CANDIDATE_PROSE');
    const candidate=f.store.candidate(original.id,'native-candidate','Native candidate').run;expect(candidate.snapshot.nativeBot!.branchId).toBe(candidate.snapshot.branchId);expect(candidate.snapshot.nativeBot!.pending).toBeNull();expect(candidate.snapshot.story!.config.module).toEqual(original.snapshot.story!.config.module);expect(candidate.snapshot.nativeBot!.stateConfigRevision).toBe(candidate.snapshot.story!.config.revision);const selected=complete(f,candidate.id,'ALTERNATE_CANDIDATE_PROSE');
    expect(f.store.native.snapshot(f.chatId,candidate.snapshot.branchId)!.package.id).toBe(original.snapshot.nativeBot!.package.id);const following=run(f,'AFTER_CANDIDATE',{branchId:candidate.snapshot.branchId}).run;expect(following.snapshot.nativeBot!.branchId).toBe(candidate.snapshot.branchId);expect(following.snapshot.logicalHistory!.map(m=>m.text)).toEqual(['CANDIDATE_USER_REQUEST','ALTERNATE_CANDIDATE_PROSE']);f.store.finishRun(following.id,'cancelled','synthetic completion boundary');
    const restored=database();expect(restored.product.import(f.store.product.export())).toEqual({restored:true,chats:1});expect(restored.source(selected.id).text).toBe('ALTERNATE_CANDIDATE_PROSE');
  });
});
