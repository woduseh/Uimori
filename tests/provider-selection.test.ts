import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { assertModelSelection } from '../server/provider-selection.js';
import { isModelSelectable } from '../web/model-selection.js';
import { defaultStoryConfig } from '../core/story.js';
import type { Connection, ContentRef, ModelPreset } from '../core/product.js';

const owned:{directory:string;store:Store}[]=[];
const database=()=>{const directory=mkdtempSync(join(tmpdir(),'uimori-selection-'));const store=new Store(join(directory,'story.sqlite'));owned.push({directory,store});return store;};
afterEach(()=>{for(const {directory,store} of owned.splice(0).reverse()){store.close();const target=resolve(directory),within=relative(resolve(tmpdir()),target);if(isAbsolute(within)||within.startsWith('..')||!basename(target).startsWith('uimori-selection-'))throw new Error('Unsafe cleanup');rmSync(target,{recursive:true,force:true});}});
const ref=({id,revision}:ContentRef)=>({id,revision});
const connectionBody=(extra:Record<string,unknown>={})=>({title:'Connection',protocol:'openai-chat-v1',endpoint:'http://127.0.0.1:9999/v1',enabled:true,...extra});
const modelBody=(c:Connection,extra:Record<string,unknown>={})=>({title:'Model',connectionId:c.id,connectionRevision:c.revision,modelId:'synthetic',maxOutputTokens:1000,temperature:null,...extra});
function setup(){const s=database(),chat=s.createChat('Synthetic');const c=s.product.connection(connectionBody()) as Connection,m=s.product.model(modelBody(c)) as ModelPreset;return {s,chat,c,m};}
function assign(s:Store,chatId:string,routes:Record<string,ContentRef|null>){const p=s.product.profile(chatId);return s.product.updateProfile(chatId,{expectedRevision:p.revision,attachments:p.attachments,creative:p.creative,image:p.image,routes:{...p.routes,...routes}});}

test('latest model flag denies new assignments but exact existing roles survive and source snapshots remain immutable',()=>{
  const {s,chat,c,m}=setup();assign(s,chat.id,{main:ref(m)});
  const profile=s.product.snapshot(chat.id)!;
  const run=s.createRun(chat.id,{request:'Synthetic request',expectedRevision:null,expectedSettingsRevision:chat.settingsRevision,idempotencyKey:randomUUID()},current=>({chatId:chat.id,parentRevision:null,settingsRevision:current.settingsRevision,settings:current.settings,request:'Synthetic request',history:[],resources:[],profile})).run;
  s.startRun(run.id);const source=s.completeRun(run.id,'Synthetic immutable original',{modelCalls:1,inputTokens:null,outputTokens:null,costUsd:null},run.snapshot.settings);
  const snapshot=s.run(run.id).snapshot,original=s.source(source.id);
  const disabled=s.product.model(modelBody(c,{expectedRevision:m.revision,enabled:false}),m.id) as ModelPreset;
  expect(()=>assertModelSelection(s.product,ref(m))).toThrow('비활성');
  expect(()=>assign(s,chat.id,{translation:ref(m)})).toThrow('비활성');
  expect(()=>assign(s,chat.id,{main:ref(disabled)})).toThrow('비활성');
  expect(assign(s,chat.id,{main:ref(m)}).routes.main).toEqual(ref(m));
  expect(s.source(source.id)).toEqual(original);expect(s.run(run.id).snapshot).toEqual(snapshot);expect(s.product.get('model',m.id,m.revision)).toEqual(m);
  s.product.model(modelBody(c,{expectedRevision:disabled.revision}),m.id);
  expect(()=>assign(s,chat.id,{translation:ref(m)})).not.toThrow();
});

test('connection authority drift blocks new old-revision assignments and keeps original role assignments editable',()=>{
  for(const change of [{enabled:false},{endpoint:'http://127.0.0.1:9998/v1'},{credentialEnv:'NARRATIVE_PROVIDER_DIFFERENT'},{protocol:'fixture-sse-v1',endpoint:'http://127.0.0.1:9999/v1'}]){
    const {s,chat,c,m}=setup();assign(s,chat.id,{main:ref(m)});
    const latest=s.product.connection(connectionBody({expectedRevision:c.revision,...change}),c.id) as Connection;
    expect(()=>assign(s,chat.id,{translation:ref(m)})).toThrow('연결');expect(assign(s,chat.id,{main:ref(m)}).routes.main).toEqual(ref(m));
    expect(isModelSelectable(m,[m],[latest],[c])).toBe(false);
  }
  const {s,c,m}=setup();const rename=s.product.connection(connectionBody({title:'Renamed',expectedRevision:c.revision}),c.id) as Connection;
  expect(()=>assertModelSelection(s.product,ref(m))).not.toThrow();
  expect(isModelSelectable(m,[m],[rename])).toBe(false);expect(isModelSelectable(m,[m],[rename],[c])).toBe(true);
  const vertex=s.product.connection(connectionBody({protocol:'vertex-gemini-v1',endpoint:'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',requestTier:'standard'})) as Connection;
  const vm=s.product.model(modelBody(vertex,{modelId:'gemini-3.8-flash'})) as ModelPreset;
  const flex=s.product.connection({...connectionBody(),protocol:vertex.protocol,endpoint:vertex.endpoint,requestTier:'flex',expectedRevision:vertex.revision},vertex.id) as Connection;
  expect(()=>assertModelSelection(s.product,ref(vm))).toThrow('연결');expect(isModelSelectable(vm,[vm],[flex],[vertex])).toBe(false);
});

test('state and memory preserve exact pinned roles while rejecting a disabled model newly assigned to another role',()=>{
  const {s,chat,c,m}=setup();const defaults=defaultStoryConfig();
  s.story.saveConfig(chat.id,{expectedRevision:0,module:null,stateModel:ref(m),memory:defaults.memory});
  s.product.model(modelBody(c,{expectedRevision:m.revision,enabled:false}),m.id);
  expect(()=>s.story.saveConfig(chat.id,{expectedRevision:1,module:null,stateModel:ref(m),memory:{...defaults.memory,model:ref(m)}})).toThrow('비활성');
  const saved=s.story.saveConfig(chat.id,{expectedRevision:1,module:null,stateModel:ref(m),memory:{...defaults.memory,recentCount:3}});
  expect(saved.stateModel).toEqual(ref(m));expect(saved.memory.recentCount).toBe(3);
  const other=s.createChat('Other');expect(()=>s.story.saveConfig(other.id,{expectedRevision:0,module:null,stateModel:ref(m),memory:defaults.memory})).toThrow('비활성');
});

test('model draft validation uses explicit matching unsaved connection without any DB writes',()=>{
  const s=database();const prepared=s.product.prepareConnection(connectionBody());const draft={...prepared.value,id:'unpersisted',revision:1};
  expect(s.product.prepareModel(modelBody(draft),undefined,draft).value.source).toEqual({kind:'manual',connectionRevision:1,catalogUpdatedAt:null});
  expect(()=>s.product.prepareModel(modelBody(draft,{connectionRevision:2}),undefined,draft)).toThrow('Validation connection revision mismatch');
  expect(()=>s.product.prepareModel(modelBody(draft,{connectionId:'another'}),undefined,draft)).toThrow('Validation connection revision mismatch');
  expect(()=>s.product.prepareModel(modelBody(draft,{thinkingMode:'enabled'}),undefined,draft)).toThrow('Unsupported provider model option');
  expect(s.product.all('connection')).toEqual([]);expect(s.product.all('model')).toEqual([]);
});
