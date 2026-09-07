import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { NativeBotStore } from '../server/native-bot.js';
import { applyNativeBotCommand, createNeutralNativeBotPackage, initialNativeBotState, nativeStateModule, searchNativeLore, validateNativeBotPackage, type NativeCommandInput } from '../core/native-bot.js';
import { validateStateModule } from '../core/state.js';
import type { RunSnapshot } from '../core/types.js';

function fixture() {
  const store=new Store(join(mkdtempSync(join(tmpdir(),'Uimori native synthetic ')),'test.sqlite'));const native=store.native;const chat=store.createChat('Native state and resource fixture');store.settings(chat.id,chat.settingsRevision,{...chat.settings,translation:false,status:false});
  return {store,native,chatId:chat.id,main:`main:${chat.id}`};
}
function attach(f:ReturnType<typeof fixture>,branchId=f.main,authoritative=false) {
  const p=createNeutralNativeBotPackage();if(authoritative)p.stateModule.mode='authoritative';const saved=f.native.importPackage(p);const branch=f.store.product.branch(f.chatId,branchId);const source=branch.headRevision?f.store.source(branch.headRevision):null;
  return f.native.attach(f.chatId,{branchId,packageId:saved.id,packageRevision:saved.revision,expectedRevision:0,expectedSourceRevision:source?.id??null,expectedSourceHash:source?.hash??null,idempotencyKey:randomUUID()});
}
function command(f:ReturnType<typeof fixture>,input:NativeCommandInput,branchId=f.main) {
  const current=f.native.snapshot(f.chatId,branchId)!;return f.native.command(f.chatId,{branchId,expectedRevision:current.revision,expectedSourceRevision:current.sourceRevision,expectedSourceHash:current.sourceHash,idempotencyKey:randomUUID(),command:input});
}
function queued(f:ReturnType<typeof fixture>,branchId=f.main,sceneCommandId?:string) {
  const current=f.store.chat(f.chatId);const branch=f.store.product.branch(f.chatId,branchId);const request=sceneCommandId?f.store.story.command(sceneCommandId).request:'A synthetic request';
  return f.store.createRun(f.chatId,{branchId,request,expectedRevision:branch.headRevision,expectedSettingsRevision:current.settingsRevision,idempotencyKey:randomUUID(),...(sceneCommandId?{sceneCommandId}:{})},selected=>({chatId:f.chatId,parentRevision:selected.headRevision,settingsRevision:selected.settingsRevision,settings:selected.settings,request,history:f.store.history(selected.headRevision),resources:[]} satisfies RunSnapshot)).run;
}
function source(f:ReturnType<typeof fixture>,branchId=f.main) {const run=queued(f,branchId);expect(f.store.startRun(run.id)).toBe(true);return f.store.completeRun(run.id,'The companion kept the promise.',{modelCalls:0,inputTokens:null,outputTokens:null,costUsd:null},run.snapshot.settings);}

describe('native nonsexual package and commands',()=>{
  test('10 localized scenes, 16 guarded proposals and exact synthetic asset references',()=>{
    const p=createNeutralNativeBotPackage(); expect(p.scenes).toHaveLength(10);expect(p.actions).toHaveLength(16);
    expect(new Set(p.scenes.flatMap(s=>Object.keys(s.request)))).toEqual(new Set(['en','kr','jp']));
    const invalid=structuredClone(p);invalid.scenes[0].assetId='missing';expect(()=>validateNativeBotPackage(invalid)).toThrow('NATIVE_ASSET_REF');
    invalid.scenes[0].assetId=p.assets[0].id;invalid.assets[0].path='../private.webp';expect(()=>validateNativeBotPackage(invalid)).toThrow('NATIVE_ASSET');
    expect(validateStateModule(nativeStateModule('extra')).rules['trust-sharp-increase'].delta).toBe(8);
  });
  test('56 organized lore nodes have meaningful reference/search scope and 114 exact synthetic assets',()=>{
    const p=createNeutralNativeBotPackage();expect(p.lore).toHaveLength(56);expect(p.lore.filter(l=>l.kind==='group')).toHaveLength(11);expect(new Set(p.lore.filter(l=>l.kind==='entry').map(l=>l.text)).size).toBe(45);
    expect(searchNativeLore(p,{loading:'discoverable'})).toHaveLength(41);expect(searchNativeLore(p,{loading:'pinned'})).toHaveLength(4);
    expect(searchNativeLore(p,{text:'뜨거운',groupId:'group-kitchen',loading:'discoverable'}).map(l=>l.id)).toEqual(['kitchen-heat']);expect(searchNativeLore(p,{text:'뜨거운',groupId:'group-school'})).toHaveLength(0);
    expect(searchNativeLore(p,{text:'대출'}).map(l=>l.id)).toEqual(['library-loan']);expect(searchNativeLore(p,{groupId:'group-state',limit:2})).toHaveLength(2);expect(()=>searchNativeLore(p,{groupId:'missing'})).toThrow('NATIVE_LORE_GROUP');
    const invalid=structuredClone(p);invalid.lore.find(l=>l.kind==='entry')!.relatedIds=['missing'];expect(()=>validateNativeBotPackage(invalid)).toThrow('NATIVE_LORE_REF');
    const disconnected=structuredClone(p);disconnected.lore.find(l=>l.kind==='group')!.relatedIds.pop();expect(()=>validateNativeBotPackage(disconnected)).toThrow('NATIVE_LORE_GROUP_MEMBERSHIP');
    expect(p.assets).toHaveLength(114);expect(new Set(p.assets.map(a=>a.path)).size).toBe(114);for(const outfit of ['Home','Out','School','Sleep'])expect(p.assets.filter(a=>a.outfit===outfit)).toHaveLength(28);expect(p.assets.filter(a=>a.use==='icon')).toHaveLength(1);expect(p.assets.filter(a=>a.outfit==='Kitchen')).toHaveLength(1);
    expect(p.scenes.every(scene=>p.assets.some(asset=>asset.id===scene.assetId&&asset.use==='scene'))).toBe(true);
  });
  test('server-level guards, decimal clamping, neutral state and pending replacement',()=>{
    const p=createNeutralNativeBotPackage();const state=initialNativeBotState();
    expect(()=>applyNativeBotCommand(p,state,null,{kind:'action',id:'action-16'},'a')).toThrow('NATIVE_LOCKED');
    expect(applyNativeBotCommand(p,state,null,{kind:'set-stat',field:'trust',value:150},'a').state.trust).toBe(100);
    expect(applyNativeBotCommand(p,state,null,{kind:'set-stat',field:'trust',value:30.5},'a').state.trust).toBe(30.5);
    expect(()=>applyNativeBotCommand(p,state,null,{kind:'set-stat',field:'trust',value:NaN},'a')).toThrow();
    const selected=applyNativeBotCommand(p,state,null,{kind:'scene',id:'scene-1'},'a');expect(selected.pending?.commandId).toBe('a');expect(state.sceneId).toBeNull();
    const replaced=applyNativeBotCommand(p,selected.state,selected.pending,{kind:'scene',id:'scene-2'},'b');expect(replaced.pending?.commandId).toBe('b');
    expect(applyNativeBotCommand(p,replaced.state,replaced.pending,{kind:'back'},'c').pending).toBeNull();
  });
  test('transactional CAS, source hash, idempotency, immutable snapshot and branch isolation',()=>{
    const store=new Store(join(mkdtempSync(join(tmpdir(),'Uimori native synthetic ')),'test.sqlite'));
    try {
      const native=new NativeBotStore(store);native.init();const chat=store.createChat('synthetic native');const branchId=`main:${chat.id}`;const p=native.importPackage(createNeutralNativeBotPackage());
      const guard={branchId,expectedRevision:0,expectedSourceRevision:null,expectedSourceHash:null,idempotencyKey:'attach'};
      const attached=native.attach(chat.id,{...guard,packageId:p.id,packageRevision:p.revision});expect(attached.revision).toBe(1);
      const body={...guard,expectedRevision:1,idempotencyKey:'scene',command:{kind:'scene',id:'scene-1'}};
      const queued=native.command(chat.id,body);expect(native.command(chat.id,body)).toEqual(queued);
      expect(()=>native.command(chat.id,{...body,command:{kind:'scene',id:'scene-2'}})).toThrow('Idempotency');
      expect(()=>native.command(chat.id,{...body,idempotencyKey:'stale'})).toThrow('revision conflict');
      expect(()=>native.command(chat.id,{...body,expectedRevision:2,idempotencyKey:'wrong-hash',expectedSourceHash:'a'.repeat(64)})).toThrow('hash conflict');
      const snapshot=native.snapshot(chat.id)!;native.command(chat.id,{...body,expectedRevision:2,idempotencyKey:'clear',command:{kind:'clear-pending'}});expect(snapshot.pending).not.toBeNull();expect(native.snapshot(chat.id)?.pending).toBeNull();
      const branch=store.product.createBranch(chat.id,{title:'other',fromRevision:null});expect(native.detail(chat.id,branch.id)).toBeNull();
      expect((store.db.prepare('SELECT COUNT(*) AS n FROM native_actions').get() as {n:number}).n).toBe(3);
    } finally {store.close();}
  });
  test('native config ownership isolates attached branches and preserves global fallback and saved model/memory settings',()=>{
    const f=fixture();try {
      const other=f.store.product.createBranch(f.chatId,{title:'Other',fromRevision:null});const untouched=f.store.product.createBranch(f.chatId,{title:'Untouched',fromRevision:null});const first=attach(f);const second=attach(f,other.id);
      expect(first.stateConfigRevision).toBe(1);expect(second.stateConfigRevision).toBe(2);expect(f.store.story.configForBranch(f.chatId,untouched.id).revision).toBe(0);expect(f.store.story.configForBranch(f.chatId,f.main).revision).toBe(1);
      const old=f.store.story.configForBranch(f.chatId,f.main);const edited=f.store.story.saveConfig(f.chatId,{branchId:f.main,expectedRevision:old.revision,module:old.module,stateModel:null,memory:{...old.memory,enabled:true,recentCount:3}});expect(edited.revision).toBe(3);expect(f.native.detail(f.chatId)!.stateConfigRevision).toBe(3);
      const changed=command(f,{kind:'set-stat',field:'trust',value:65});const next=f.store.story.config(f.chatId,changed.stateConfigRevision);expect(next.revision).toBe(4);expect(next.memory).toEqual(edited.memory);expect(next.stateModel).toBe(edited.stateModel);expect(next.module!.fields.trust.initial).toBe(65);
      expect(f.store.story.configForBranch(f.chatId,other.id).revision).toBe(2);expect(f.store.story.configForBranch(f.chatId,untouched.id).revision).toBe(0);
      const global=f.store.story.saveConfig(f.chatId,{branchId:untouched.id,expectedRevision:0,module:null,stateModel:null,memory:old.memory});expect(global.revision).toBe(5);expect(f.store.story.configForBranch(f.chatId,untouched.id).revision).toBe(5);expect(f.store.story.configForBranch(f.chatId,f.main).revision).toBe(4);
      expect((f.store.db.prepare('SELECT COUNT(*) AS n FROM native_state_config_owners').get() as {n:number}).n).toBe(4);
    } finally {f.store.close();}
  });
  test('branch clone allocates an owned config while retaining rule revision and dropping queued proposals',()=>{
    const f=fixture();try {
      const initial=attach(f);const queued=command(f,{kind:'scene',id:'scene-1'});const other=f.store.product.createBranch(f.chatId,{title:'Clone target',fromRevision:null});
      const cloned=f.store.transaction(()=>f.native.cloneToBranchInTransaction(queued,other.id));expect(cloned).toMatchObject({branchId:other.id,revision:1,pending:null,sourceRevision:null,sourceHash:null,stateConfigRevision:2});
      const sourceConfig=f.store.story.config(f.chatId,initial.stateConfigRevision);const targetConfig=f.store.story.config(f.chatId,cloned.stateConfigRevision);expect(targetConfig.revision).not.toBe(sourceConfig.revision);expect(targetConfig.module).toEqual(sourceConfig.module);expect(f.store.story.configForBranch(f.chatId,other.id)).toEqual(targetConfig);expect(f.native.detail(f.chatId)!.pending).not.toBeNull();
      expect(()=>f.store.transaction(()=>f.native.cloneToBranchInTransaction(queued,other.id))).toThrow('already configured');expect((f.store.db.prepare('SELECT COUNT(*) AS n FROM story_configs').get() as {n:number}).n).toBe(2);
    } finally {f.store.close();}
  });
  test('M2 evidence-backed overlay survives ordinary controls and is discarded after source edits',()=>{
    const f=fixture();try {
      attach(f);const s=source(f);const job=f.store.story.detail(f.chatId).jobs.find(j=>j.sourceRevision===s.id&&j.kind==='state')!;const claim=f.store.story.claim(job.id,'native-test')!;expect(claim).not.toBeNull();const config=f.store.story.bundle(job.id).snapshot.story!.config;
      const quote='kept the promise';const start=s.text.indexOf(quote);const result={sourceRevision:s.id,sourceHash:s.hash,moduleRevision:config.module!.revision,operations:[{id:'kept',kind:'event',event:'trust-increase',evidence:{start,end:start+quote.length,quote}}]};
      expect(f.store.story.finish(job.id,claim.generation,'native-test',{status:'completed',result,error:null,mock:true}).status).toBe('completed');expect(f.native.detail(f.chatId)!.state.trust).toBe(30);expect(f.native.snapshot(f.chatId)!.state.trust).toBe(31);
      command(f,{kind:'language',value:'kr'});expect(f.native.detail(f.chatId)!.state.trust).toBe(31);expect(f.native.snapshot(f.chatId)!.state.trust).toBe(31);
      f.store.editSource(s.id,{text:'The companion made no promise.',expectedRevision:s.editRevision??0});expect(f.native.snapshot(f.chatId)!.state.trust).toBe(30);
      const updated=command(f,{kind:'volume',value:'extra'});const next=f.store.story.config(f.chatId,updated.stateConfigRevision);expect(next.module!.rules['trust-sharp-increase'].delta).toBe(8);expect(next.activatedAt!.hash).toBe(f.store.source(s.id).hash);
    } finally {f.store.close();}
  });
  test('native change cancels only this branch owners/waiting runs and scene commands; stale workers cannot commit',()=>{
    const f=fixture();try {
      const other=f.store.product.createBranch(f.chatId,{title:'Other',fromRevision:null});attach(f,f.main,true);attach(f,other.id,true);const a=source(f);const b=source(f,other.id);
      const jobs=f.store.story.detail(f.chatId).jobs;const mainJob=jobs.find(j=>j.sourceRevision===a.id&&j.kind==='state')!;const otherJob=jobs.find(j=>j.sourceRevision===b.id&&j.kind==='state')!;const mainClaim=f.store.story.claim(mainJob.id,'main-owner')!;const otherClaim=f.store.story.claim(otherJob.id,'other-owner')!;
      const aCommand=f.store.story.createCommand(f.chatId,{branchId:f.main,label:'Next main',request:'Next main',idempotencyKey:randomUUID()});const bCommand=f.store.story.createCommand(f.chatId,{branchId:other.id,label:'Next other',request:'Next other',idempotencyKey:randomUUID()});const aRun=queued(f,f.main,aCommand.id);const bRun=queued(f,other.id,bCommand.id);expect(aRun.status).toBe('waiting_for_state');expect(bRun.status).toBe('waiting_for_state');
      command(f,{kind:'set-stat',field:'affection',value:50});expect(f.store.story.job(mainJob.id)).toMatchObject({status:'cancelled',generation:mainClaim.generation+1,owner:null});expect(f.store.story.job(otherJob.id)).toMatchObject({status:'running',generation:otherClaim.generation,owner:'other-owner'});expect(f.store.run(aRun.id).status).toBe('cancelled');expect(f.store.run(bRun.id).status).toBe('waiting_for_state');expect(f.store.story.command(aCommand.id).status).toBe('cancelled');expect(f.store.story.command(bCommand.id).status).toBe('pending');
      expect(f.store.story.finish(mainJob.id,mainClaim.generation,'main-owner',{status:'completed',result:{},error:null,mock:true}).status).toBe('cancelled');expect(f.store.run(aRun.id).snapshot.story!.config.revision).toBe(1);
    } finally {f.store.close();}
  });
});
