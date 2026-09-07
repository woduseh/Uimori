import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import type { Content, ChatProfile, PromptPreset } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import { packageContext } from '../core/package-context.js';
const owned:{store:Store;dir:string}[]=[];
afterEach(()=>{for(const{store,dir}of owned.splice(0)){store.close();const inside=relative(resolve(tmpdir()),resolve(dir));if(isAbsolute(inside)||inside.startsWith('..')||!inside.startsWith('uimori-redesign-integration-'))throw Error('Unsafe fixture cleanup');rmSync(dir,{recursive:true,force:true});}});
function db(){const dir=mkdtempSync(join(tmpdir(),'uimori-redesign-integration-'));const store=new Store(join(dir,'test.sqlite'));owned.push({store,dir});return store;}
const reference=({id,revision}:{id:string;revision:number})=>({id,revision});
function packageBody():ContentPackage{return{version:1,id:'imported',revision:17,title:'Imported title',description:'Imported description',body:'Imported body',lore:[{id:'knowledge',title:'Lore',description:'Unchanged metadata',text:'Exact original lore',loading:'discoverable'}],instructions:[{id:'guide',target:'main',text:'Exact original instruction',when:{control:'enabled'}}],controls:[{id:'enabled',label:'Enabled',type:'boolean',default:true}],transforms:[]};}
function save(store:Store,pkg=packageBody(),prior?:Content){return store.product.content({kind:'module',title:'Outer title',description:'Outer description',text:'',loading:'pinned',relatedIds:[],package:pkg,...(prior?{expectedRevision:prior.revision}:{})},prior?.id) as Content;}
function update(store:Store,chatId:string,changes:Record<string,unknown>){const p=store.product.profile(chatId);return store.product.updateProfile(chatId,{expectedRevision:p.revision,attachments:p.attachments,creative:p.creative,routes:p.routes,image:p.image,...changes});}
function capture(store:Store,chatId:string){const chat=store.chat(chatId);const profile=store.product.snapshot(chatId);const run=store.createRun(chatId,{request:'Synthetic',expectedRevision:chat.headRevision,expectedSettingsRevision:chat.settingsRevision,idempotencyKey:randomUUID()},c=>({chatId,parentRevision:c.headRevision,settingsRevision:c.settingsRevision,settings:c.settings,request:'Synthetic',history:store.history(c.headRevision),resources:store.product.resources(chatId,profile),profile})).run;store.startRun(run.id);store.completeRun(run.id,'Synthetic original',{modelCalls:0,inputTokens:null,outputTokens:null,costUsd:null},run.snapshot.settings);return store.run(run.id);}
test('package persistence normalizes envelope fields, keeps internal data and old run source-time package after editing',()=>{
  const store=db(),input=packageBody(),saved=save(store,input);expect(saved.package).toEqual({...input,id:saved.id,revision:1,title:saved.title,description:saved.description,body:''});expect(input.id).toBe('imported');
  const chat=store.createChat('Story','calm',()=>[],{botId:saved.id});const run=capture(store,chat.id),before=JSON.stringify(run.snapshot);
  const edited=save(store,{...saved.package!,instructions:[{id:'guide',target:'main',text:'NEW'}]},saved);expect(edited.revision).toBe(2);
  expect(JSON.stringify(store.run(run.id).snapshot)).toBe(before);expect(packageContext(store.run(run.id).snapshot,'main')!.instructions[0].text).toBe('Exact original instruction');
  const summary=store.product.library(true).contents.find(c=>c.id===saved.id)!;expect(summary.hasPackage).toBe(true);expect(summary.package).toBeUndefined();expect(summary.text).toBe('');
});
test('cross-role attachment of one package namespaces resources while invalid refs and mixed primary roles reject atomically',()=>{
  const store=db(),pkg=save(store),chat=store.createChat('Story');
  const refs=[{...reference(pkg),role:'bot'},{...reference(pkg),role:'persona'}];update(store,chat.id,{packageAttachments:refs});
  const profile=store.product.snapshot(chat.id)!,resources=store.product.resources(chat.id,profile);expect(new Set(resources.map(r=>r.id)).size).toBe(resources.length);expect(resources.some(r=>r.id.includes(':bot:'))).toBe(true);expect(resources.some(r=>r.id.includes(':persona:'))).toBe(true);
  const legacy=(kind:'bot'|'persona')=>store.product.content({kind,title:kind,description:'',text:'Original',loading:'pinned',relatedIds:[]});
  for(const kind of ['bot','persona'] as const){const content=legacy(kind);expect(()=>update(store,chat.id,{attachments:[reference(content)]})).toThrow('Duplicate legacy and package primary role');}
  const before=store.product.profile(chat.id);expect(()=>update(store,chat.id,{attachments:[reference(pkg)]})).toThrow('Package is also attached');
  expect(()=>update(store,chat.id,{packageAttachments:[{id:pkg.id,revision:999,role:'bot'}]})).toThrow('revision not found');
  expect(()=>update(store,chat.id,{packageAttachments:[refs[0],refs[0]]})).toThrow('Duplicate package');expect(store.product.profile(chat.id)).toEqual(before);
  expect(()=>update(store,chat.id,{attachments:[reference(pkg)],packageAttachments:[]})).toThrow('explicit attachment role');
});
test('changing attachments drops only inherited obsolete package control keys and rejects explicit stale values',()=>{
  const store=db(),pkg=save(store),chat=store.createChat('Story');const key=`${pkg.id}@1:module`;
  update(store,chat.id,{packageAttachments:[{...reference(pkg),role:'module'}],packageValues:{[key]:{enabled:false}}});
  expect(()=>update(store,chat.id,{packageAttachments:[],packageValues:{[key]:{enabled:false}}})).toThrow('outside attachment scope');
  const detached=update(store,chat.id,{packageAttachments:[]});expect(detached.packageValues).toEqual({});
  const reattached=update(store,chat.id,{packageAttachments:[{...reference(pkg),role:'module'}]});expect(reattached.packageValues).toEqual({});expect(packageContext({...capture(store,chat.id).snapshot},'main')!.instructions).toHaveLength(1);
});
function prompt(store:Store,id='choice'):PromptPreset{return store.product.promptPreset({title:'Composed',role:'main',text:'',program:{version:1,controls:[{id,label:id,type:'boolean',default:true}],blocks:[{id:'turn',title:'Turn',kind:'current'}]}}) as PromptPreset;}
test('prompt combinations reject nonprimitive values and controls from a different prompt',()=>{
  const store=db(),p=prompt(store),other=prompt(store,'different');
  expect(()=>store.product.promptCombination({title:'Bad',prompt:reference(p),values:{choice:{nested:true}}})).toThrow('PROMPT_INVALID_VALUE');
  expect(()=>store.product.promptCombination({title:'Bad',prompt:reference(other),values:{choice:true}})).toThrow('PROMPT_UNKNOWN_CONTROL');
  expect(store.product.promptCombination({title:'Saved',prompt:reference(p),values:{choice:false}}).values).toEqual({choice:false});
});
test('v6 archive roundtrips package refs, large internal lore, empty body, option combinations and bot folder ownership',()=>{
  const store=db(),body=packageBody();body.lore[0].text='L'.repeat(100001);const pkg=save(store,body);
  const folder=store.organization.createFolder(pkg.id,{title:'Folder',defaultPersona:reference(pkg)});const chat=store.createChat('Story','calm',()=>[],{botId:pkg.id,folderId:folder.id});
  const p=prompt(store);const combination=store.product.promptCombination({title:'Saved',prompt:reference(p),values:{choice:false}});
  update(store,chat.id,{packageValues:{[`${pkg.id}@1:persona`]:{enabled:false}}});const run=capture(store,chat.id);
  const archive=store.product.export();expect(archive.version).toBe(9);const before=JSON.stringify(archive);const restored=db();expect(restored.product.import(archive)).toEqual({restored:true,chats:1});expect(JSON.stringify(archive)).toBe(before);
  expect(restored.organization.metadata(chat.id)).toEqual(store.organization.metadata(chat.id));expect(restored.organization.folder(pkg.id,folder.id)).toEqual(folder);
  expect(restored.product.profile(chat.id)).toEqual(store.product.profile(chat.id));expect(restored.product.get('prompt-combination',combination.id)).toEqual(combination);
  expect(restored.run(run.id).snapshot.resources).toEqual(run.snapshot.resources);expect(restored.run(run.id).snapshot.profile!.packages).toEqual(run.snapshot.profile!.packages);
});
test('malformed package import and forged archive package body roll back all writes',()=>{
  const store=db();expect(()=>save(store,{...packageBody(),lore:[{id:'a',title:'',description:'',text:'x',loading:'discoverable',relatedIds:['missing']}]})).toThrow('PACKAGE_LORE_REFERENCE');expect(store.product.all('content')).toEqual([]);
  save(store);const archive=store.product.export();const row=archive.tables.versions.find(r=>r.kind==='content')!;const body=JSON.parse(row.body);body.package.body='Forged';row.body=JSON.stringify(body);
  const restored=db();expect(()=>restored.product.import(archive)).toThrow('Package identity mismatch');expect(restored.product.all('content')).toEqual([]);
});
test('package body and description limits survive archive while legacy limits stay unchanged',()=>{
  const store=db(),body=packageBody(),value={kind:'module',title:'Large',description:'d'.repeat(3000),text:'b'.repeat(100001),loading:'pinned',relatedIds:[],package:body};
  const saved=store.product.content(value) as Content;expect(saved.package!.body).toBe(value.text);expect(saved.package!.description).toBe(value.description);
  const restored=db();restored.product.import(store.product.export());expect(restored.product.get('content',saved.id)).toEqual(saved);
  const {package:_package,...legacy}=value;expect(()=>store.product.content(legacy)).toThrow('Invalid description');
  expect(()=>store.product.content({...legacy,description:''})).toThrow('Invalid text');
});
