import { DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { defaultCreative, type ChatProfile, type PromptPreset } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { createTranslationPlan } from '../core/auxiliary.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';

const owned:{directory:string;app?:App}[]=[];
beforeEach(()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network in prompt settings tests'));});
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const item of owned.splice(0).reverse()){
    await item.app?.close();const target=resolve(item.directory);const within=relative(resolve(tmpdir()),target);
    if(isAbsolute(within)||within.startsWith('..')||!basename(target).startsWith('Uimori prompt settings '))throw new Error('Refusing cleanup outside owned test directory');
    await rm(target,{recursive:true,force:true});
  }
});
async function application(){const directory=await mkdtemp(join(tmpdir(),'Uimori prompt settings '));const item:(typeof owned)[number]={directory};owned.push(item);item.app=await createApp({dbPath:join(directory,'story.sqlite'),buildId:'prompt-settings-synthetic',instanceId:randomUUID(),testMode:true});await item.app.ready();return item.app;}
async function request<T=any>(app:App,path:string,payload:unknown,status=200,method:'POST'|'PUT'='POST'):Promise<T>{const response=await app.inject({method,url:'/api'+path,payload:JSON.stringify(payload),headers:{host:'127.0.0.1','content-type':'application/json'}});expect(response.statusCode,response.body).toBe(status);return response.json() as T;}
async function read<T=any>(app:App,path:string,status=200):Promise<T>{const response=await app.inject({method:'GET',url:'/api'+path,headers:{host:'127.0.0.1'}});expect(response.statusCode,response.body).toBe(status);return response.json() as T;}
const reference=({id,revision}:{id:string;revision:number})=>({id,revision});
const prompt=(role:'main'|'translation',text:string,title='Synthetic prompt')=>({title,role,text});
const profileBody=(prior:ChatProfile,changes:Record<string,unknown>={})=>({expectedRevision:prior.revision,attachments:prior.attachments,creative:prior.creative,routes:prior.routes,image:prior.image,...changes});
function capture(app:App,chatId:string){const store=app.store;const chat=store.chat(chatId);const profile=store.product.snapshot(chatId);const text='Synthetic source capture, no provider execution';return store.createRun(chatId,{request:text,expectedRevision:chat.headRevision,expectedSettingsRevision:chat.settingsRevision,expectedProfileRevision:store.product.profile(chatId).revision,idempotencyKey:randomUUID()},current=>({chatId,parentRevision:current.headRevision,settingsRevision:current.settingsRevision,settings:current.settings,request:text,history:store.history(current.headRevision),resources:store.product.resources(chatId,profile),...(profile?{profile}:{})} satisfies RunSnapshot)).run;}
function complete(app:App,run:ReturnType<typeof capture>){app.store.startRun(run.id);return app.store.completeRun(run.id,'Mira waits by the quiet harbor.',{modelCalls:0,inputTokens:null,outputTokens:null,costUsd:null},run.snapshot.settings);}

describe('literal user-editable main and translation prompt presets',()=>{
  test('saves exact whitespace, empty text and version history, rejecting stale writes and invalid shapes without generation',async()=>{
    const app=await application();const literal='\r\n  {{char}} ${literal}\n<instructions>Keep my exact wording.</instructions>\t\n';
    const first=await request<PromptPreset>(app,'/prompt-presets',prompt('main',literal));expect(first.program).toEqual(createDefaultPromptProgram(literal)); expect(first).not.toHaveProperty('text');expect(first).toMatchObject({role:'main',revision:1});
    const empty=await request<PromptPreset>(app,'/prompt-presets',prompt('translation',''));expect(empty.program).toEqual(createDefaultPromptProgram('', 'translation'));
    const blank=await request<PromptPreset>(app,'/prompt-presets',prompt('translation',' \r\n\t'));expect(blank.program).toEqual(createDefaultPromptProgram(' \r\n\t', 'translation'));
    const next=await request<PromptPreset>(app,'/prompt-presets/'+first.id,{...prompt('main','Replacement\n'),expectedRevision:1},200,'PUT');expect(next).toMatchObject({id:first.id,revision:2,program:createDefaultPromptProgram('Replacement\n')});
    await request(app,'/prompt-presets/'+first.id,{...prompt('main','Lost update'),expectedRevision:1},409,'PUT');
    await request(app,'/prompt-presets/'+first.id,prompt('main','Missing revision'),400,'PUT');
    expect(await read(app,`/revisions/prompt-preset/${first.id}/1`)).toEqual(first);
    const library=await read(app,'/library');expect(library.promptPresets).toHaveLength(3);expect(library.promptPresets.find((item:PromptPreset)=>item.id===first.id)).toEqual(next);
    for(const changes of [{role:'status'},{text:null},{text:3},{text:'x'.repeat(200001)},{title:''},{unknown:true}])await request(app,'/prompt-presets',{...prompt('main','original'),...changes},400);
    expect((await request<PromptPreset>(app,'/prompt-presets',prompt('main','x'.repeat(200000)))).program).toEqual(createDefaultPromptProgram('x'.repeat(200000)));
    const ast=createDefaultPromptProgram('AST wins'); const explicit=await request<PromptPreset>(app,'/prompt-presets',{title:'AST',role:'main',text:'ignored draft',program:ast}); expect(explicit.program).toEqual(ast); expect(explicit).not.toHaveProperty('text');
    expect(app.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({n:0});expect(app.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({n:0});expect(fetch).not.toHaveBeenCalled();
  });

  test('preserves omitted prompt roles, distinguishes null from an empty preset, and rejects cross-role references',async()=>{
    const app=await application();const chat=app.store.createChat('Synthetic prompt selections');const product=app.store.product;
    const main=await request<PromptPreset>(app,'/prompt-presets',prompt('main','Main prompt'));const translation=await request<PromptPreset>(app,'/prompt-presets',prompt('translation',''));
    expect(product.profile(chat.id)).not.toHaveProperty('prompts');
    let profile=await request<ChatProfile>(app,`/chats/${chat.id}/profile`,profileBody(product.profile(chat.id),{prompts:{main:reference(main),translation:reference(translation)}}),200,'PUT');
    expect(product.snapshot(chat.id)?.promptPresets).toEqual({main,translation});
    profile=await request<ChatProfile>(app,`/chats/${chat.id}/profile`,profileBody(profile,{image:true}),200,'PUT');expect(profile.prompts).toEqual({main:reference(main),translation:reference(translation)});
    const creative=product.preset({title:'Creative only',controls:defaultCreative()}) as {id:string;revision:number};
    profile=await request<ChatProfile>(app,`/chats/${chat.id}/preset`,{expectedRevision:profile.revision,presetId:creative.id,presetRevision:creative.revision});expect(profile.prompts?.translation).toEqual(reference(translation));
    profile=await request<ChatProfile>(app,`/chats/${chat.id}/profile`,profileBody(profile,{prompts:{main:null}}),200,'PUT');expect(profile.prompts).toEqual({main:null,translation:reference(translation)});expect(product.snapshot(chat.id)?.promptPresets).toEqual({translation});
    profile=await request<ChatProfile>(app,`/chats/${chat.id}/profile`,profileBody(profile,{prompts:{}}),200,'PUT');expect(profile.prompts).toEqual({main:null,translation:reference(translation)});
    for(const prompts of [{main:reference(translation)},{translation:reference(main)},{status:null},{translation:false},{translation:{id:translation.id,revision:0}},null])await request(app,`/chats/${chat.id}/profile`,profileBody(profile,{prompts}),400,'PUT');
    await request(app,`/chats/${chat.id}/profile`,profileBody(profile,{prompts:{main:{id:'missing',revision:1}}}),404,'PUT');
    expect(product.profile(chat.id)).toEqual(profile);expect(fetch).not.toHaveBeenCalled();
  });

  test('pins both prompt versions in a source snapshot and candidate while a new scene captures current selections',async()=>{
    const app=await application();const chat=app.store.createChat('Synthetic frozen prompts');const product=app.store.product;
    const main=await request<PromptPreset>(app,'/prompt-presets',prompt('main','Main version one'));const translation=await request<PromptPreset>(app,'/prompt-presets',prompt('translation','Translation version one'));
    let profile=product.updateProfile(chat.id,profileBody(product.profile(chat.id),{prompts:{main:reference(main),translation:reference(translation)}}));
    const original=capture(app,chat.id);complete(app,original);const frozen=JSON.stringify(original.snapshot);
    const updated=await request<PromptPreset>(app,'/prompt-presets/'+main.id,{...prompt('main','Main version two'),expectedRevision:main.revision},200,'PUT');
    profile=product.updateProfile(chat.id,profileBody(profile,{prompts:{main:reference(updated),translation:null}}));
    expect(JSON.stringify(app.store.run(original.id).snapshot)).toBe(frozen);
    const candidate=app.store.candidate(original.id,randomUUID(),'Preserved candidate').run;expect(candidate.snapshot.profile?.promptPresets).toEqual({main,translation});
    const next=capture(app,chat.id);expect(next.snapshot.profile?.prompts).toEqual({main:reference(updated),translation:null});expect(next.snapshot.profile?.promptPresets).toEqual({main:updated});expect(fetch).not.toHaveBeenCalled();
  });

  test('overlays only the explicitly captured job translation prompt and keeps source-time facts, main prompt and model fixed',async()=>{
    const app=await application();const chat=app.store.createChat('Synthetic job prompt');const product=app.store.product;
    const main=await request<PromptPreset>(app,'/prompt-presets',prompt('main','Main fixed'));const old=await request<PromptPreset>(app,'/prompt-presets',prompt('translation','Old translation'));const selected=await request<PromptPreset>(app,'/prompt-presets',prompt('translation',''));
    product.updateProfile(chat.id,profileBody(product.profile(chat.id),{prompts:{main:reference(main),translation:reference(old)}}));const run=capture(app,chat.id);const original=JSON.stringify(run.snapshot);
    const input={promptSelection:{translation:reference(selected)}};const resolved=product.resolveJobPrompt(run.snapshot,input);
    expect(resolved.profile?.promptPresets).toEqual({main,translation:selected});expect(resolved.profile?.models).toEqual(run.snapshot.profile?.models);expect(resolved.profile?.contents).toEqual(run.snapshot.profile?.contents);
    await request(app,'/prompt-presets/'+selected.id,{...prompt('translation','Edited later'),expectedRevision:selected.revision},200,'PUT');
    expect(product.resolveJobPrompt(run.snapshot,input).profile?.promptPresets?.translation?.program).toEqual(createDefaultPromptProgram('', 'translation'));
    expect(product.resolveJobPrompt(run.snapshot,{promptSelection:{translation:null}}).profile?.promptPresets).toEqual({main});
    expect(product.resolveJobPrompt(run.snapshot,null)).toEqual(run.snapshot);expect(JSON.stringify(run.snapshot)).toBe(original);
    for(const promptSelection of [{translation:reference(main)},{translation:{id:selected.id,revision:99}},{main:reference(main)},null,{}])expect(()=>product.resolveJobPrompt(run.snapshot,{promptSelection})).toThrow();
  });

  test('round-trips literal versions and frozen snapshots while accepting legacy absence',async()=>{
    const source=await application();const product=source.store.product;const chat=source.store.createChat('Synthetic archive prompts');
    const main=await request<PromptPreset>(source,'/prompt-presets',prompt('main','  Literal main\r\n'));const empty=await request<PromptPreset>(source,'/prompt-presets',prompt('translation',''));
    product.updateProfile(chat.id,profileBody(product.profile(chat.id),{prompts:{main:reference(main),translation:reference(empty)}}));const run=capture(source,chat.id);complete(source,run);
    await request(source,'/prompt-presets/'+main.id,{...prompt('main','Latest main'),expectedRevision:1},200,'PUT');
    const legacy=source.store.createChat('Legacy absence');product.updateProfile(legacy.id,profileBody(product.profile(legacy.id)));capture(source,legacy.id);
    const archive=product.export();const unchanged=JSON.stringify(archive);const target=await application();expect(target.store.product.import(archive)).toMatchObject({restored:true,chats:2});expect(JSON.stringify(archive)).toBe(unchanged);
    expect(target.store.product.get('prompt-preset',main.id,1)).toEqual(main);expect(target.store.product.get('prompt-preset',main.id)).toMatchObject({revision:2,program:createDefaultPromptProgram('Latest main')});
    expect(target.store.run(run.id).snapshot.profile?.promptPresets).toEqual({main,translation:empty});expect(target.store.product.profile(legacy.id)).not.toHaveProperty('prompts');expect(target.store.product.snapshot(legacy.id)).not.toHaveProperty('promptPresets');
    expect(target.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects forged prompt versions, profile roles and frozen text with archive rollback',async()=>{
    const source=await application();const chat=source.store.createChat('Synthetic archive binding');const main=await request<PromptPreset>(source,'/prompt-presets',prompt('main','Original literal'));const translation=await request<PromptPreset>(source,'/prompt-presets',prompt('translation','Translation literal'));
    source.store.product.updateProfile(chat.id,profileBody(source.store.product.profile(chat.id),{prompts:{main:reference(main),translation:reference(translation)}}));const run=capture(source,chat.id);const scene=complete(source,run);source.store.requestTranslation(scene.id);const archive=source.store.product.export();
    const attacks:((value:typeof archive)=>void)[]=[
      value=>{const row=value.tables.versions.find(row=>row.kind==='prompt-preset')!;row.body=JSON.stringify({...JSON.parse(row.body),role:'status'});},
      value=>{const row=value.tables.versions.find(row=>row.kind==='prompt-preset')!;row.body=JSON.stringify({...JSON.parse(row.body),text:'x'.repeat(200001)});},
      value=>{const row=value.tables.profiles[0];row.body=JSON.stringify({...JSON.parse(row.body),prompts:{main:reference(translation)}});},
      value=>{const row=value.tables.runs[0];const snapshot=JSON.parse(row.snapshot);snapshot.profile.promptPresets.main.text='Forged text';row.snapshot=JSON.stringify(snapshot);},
      value=>{const row=value.tables.runs[0];const snapshot=JSON.parse(row.snapshot);delete snapshot.profile.promptPresets;row.snapshot=JSON.stringify(snapshot);},
      value=>{const row=value.tables.jobs.find(row=>row.kind==='translation')!;row.input=JSON.stringify({promptSelection:{translation:reference(main)}});},
      value=>{const row=value.tables.jobs.find(row=>row.kind==='status')!;row.input=JSON.stringify({promptSelection:{translation:reference(translation)}});},
    ];
    for(const attack of attacks){const forged=structuredClone(archive);attack(forged);const original=JSON.stringify(forged);const target=await application();expect(()=>target.store.product.import(forged)).toThrow();expect(JSON.stringify(forged)).toBe(original);expect(target.store.chats()).toEqual([]);expect(target.store.product.library().promptPresets).toEqual([]);}
  });

  test('stores the prompt chosen for explicit retranslation and keeps it across profile changes and failed-chunk retry',async()=>{
    const app=await application();const chat=app.store.createChat('Synthetic retranslation prompt');const product=app.store.product;
    const first=await request<PromptPreset>(app,'/prompt-presets',prompt('translation','First translation'));
    let profile=product.updateProfile(chat.id,profileBody(product.profile(chat.id),{prompts:{translation:reference(first)}}));const run=capture(app,chat.id);const source=complete(app,run);
    const second=await request<PromptPreset>(app,'/prompt-presets',prompt('translation','Second translation'));
    profile=product.updateProfile(chat.id,profileBody(profile,{prompts:{translation:reference(second)}}));
    const job=app.store.retranslate(source.id);expect(job.input).toMatchObject({promptSelection:{translation:reference(second)}});
    const overlaid=product.resolveJobPrompt(run.snapshot,job.input);expect(overlaid.profile?.promptPresets?.translation).toEqual(second);
    const plan=createTranslationPlan(source,sourceTimeContext(overlaid,'translation'));
    const claimed=app.store.claimJob(job.id,'synthetic-worker',{initial:{},inputs:[],toolEvents:[]},plan)!;expect(claimed.input).toMatchObject({promptSelection:{translation:reference(second)}});
    const generation=claimed.generation;product.chunk(job.id,plan.chunks[0].id,'failed',undefined,undefined,'Synthetic transport error');app.store.finishAuxiliary(job.id,generation,'synthetic-worker',{status:'failed',result:null,error:'Synthetic transport error'});
    profile=product.updateProfile(chat.id,profileBody(profile,{prompts:{translation:null}}));
    const retried=app.store.retryJob(job.id);expect(retried.input).toMatchObject({promptSelection:{translation:reference(second)}});expect(product.resolveJobPrompt(run.snapshot,retried.input).profile?.promptPresets?.translation).toEqual(second);
    const retryClaim=app.store.claimJob(job.id,'retry-worker',retried.input)!;
    app.store.failJob(job.id,retryClaim.generation,'retry-worker','Synthetic retry failure');
    const savedArchive=product.export();
    const builtin=app.store.retranslate(source.id);expect(builtin.id).toBe(job.id);expect(builtin.revision).toBeGreaterThan(job.revision ?? 1);expect(builtin.input).toMatchObject({promptSelection:{translation:null}});expect(product.resolveJobPrompt(run.snapshot,builtin.input).profile?.promptPresets).toEqual({});
    expect(app.store.run(run.id).snapshot.profile?.promptPresets?.translation).toEqual(first);
    const target=await application();expect(target.store.product.import(savedArchive)).toMatchObject({restored:true,chats:1});
    const restored=target.store.job(job.id);expect(restored.input).toMatchObject({promptSelection:{translation:reference(second)}});expect(target.store.product.resolveJobPrompt(target.store.run(run.id).snapshot,restored.input).profile?.promptPresets?.translation).toEqual(second);expect(fetch).not.toHaveBeenCalled();
  });
});


describe('translation prompt preview uses the job compiler without writes',()=>{
  test.each([false,true])('default translation preview with stored source=%s',async stored=>{
    const app=await application(),chat=app.store.createChat('Translation preview');
    const source=stored?complete(app,capture(app,chat.id)):undefined;
    const before=app.store.db.prepare('SELECT total_changes() AS n').get();
    const program=createDefaultPromptProgram(DEFAULT_TRANSLATION_PROMPT,'translation');
    const preview=await request(app,`/chats/${chat.id}/prompt-preview`,{role:'translation',program,request:'Synthetic preview source.'});
    expect(preview.scope).toBe('preview-only-no-provider-call');expect(preview.error).toBeUndefined();
    expect(preview.previewSource.kind).toBe(stored?'stored':'synthetic');
    expect(preview.compilation.messages[0].content[0].text).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(preview.compilation.messages.some((m:any)=>m.id==='context')).toBe(true);
    expect(preview.compilation.messages.some((m:any)=>m.id==='outputSchema')).toBe(true);
    const blocks=JSON.parse(preview.compilation.messages.find((m:any)=>m.id==='source').content[0].text.split('\n').slice(1).join('\n'));
    expect(blocks[0].text).toBe(stored?'Mira waits by the quiet harbor.':'Synthetic preview source.');
    if(source)expect(preview.previewSource).toMatchObject({sourceRevision:source.id,sourceHash:source.hash});
    expect(preview.compilation.messages.filter((m:any)=>m.provenance.origin==='current')).toHaveLength(1);
    expect(preview.compilation.messages.filter((m:any)=>m.provenance.origin==='history')).toHaveLength(0);
    program.controls=[{id:'tone',label:'Tone',type:'text',default:'default'}];
    if(program.blocks[0].kind==='message')program.blocks[0].template.push({kind:'value',expression:{control:'tone'}});
    const changed=await request(app,`/chats/${chat.id}/prompt-preview`,{role:'translation',program,request:'Synthetic preview source.',values:{tone:'PREVIEW OVERRIDE'}});
    expect(changed.compilation.messages[0].content[0].text).toContain('PREVIEW OVERRIDE');
    expect(app.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
});
