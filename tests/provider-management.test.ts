import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { readiness, managementImpact } from '../server/provider-management.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { defaultStoryConfig } from '../core/story.js';

const owned: {directory:string;store:Store}[] = [];
const database = () => {
  const directory = mkdtempSync(join(tmpdir(),'uimori-management-'));
  const store = new Store(join(directory,'test.sqlite')); owned.push({directory,store}); return store;
};
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const {directory,store} of owned.splice(0).reverse()) {
    store.close(); const target = resolve(directory); const within = relative(resolve(tmpdir()),target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori-management-')) throw new Error('Unsafe test cleanup');
    rmSync(target,{recursive:true,force:true});
  }
});
const connectionBody = (extra:Record<string,unknown> = {}) => ({title:'Synthetic',protocol:'openai-chat-v1',endpoint:'http://127.0.0.1:9999/v1',enabled:true,...extra});
const editConnection = (c:Connection,extra:Record<string,unknown> = {}) => connectionBody({title:c.title,protocol:c.protocol,endpoint:c.endpoint,enabled:c.enabled,...(c.credentialEnv ? {credentialEnv:c.credentialEnv}:{}),expectedRevision:c.revision,...extra});
const modelBody = (c:Connection,extra:Record<string,unknown> = {}) => ({title:'Model',connectionId:c.id,connectionRevision:c.revision,modelId:'synthetic',maxOutputTokens:1000,temperature:null,...extra});
const ref = ({id,revision}:{id:string;revision:number}) => ({id,revision});
const count = (s:Store) => Number((s.db.prepare('SELECT COUNT(*) AS n FROM versions').get() as {n:number}).n);
const stamp = '2026-09-07T00:00:00.000Z';

test('prepare is read only and create/update enforce the same CAS contract', () => {
  const s = database(); const p = s.product;
  expect(p.prepareConnection(connectionBody()).value.catalog).toEqual([]); expect(count(s)).toBe(0);
  const c = p.connection(connectionBody()) as Connection;
  expect(p.prepareModel(modelBody(c)).value.source).toEqual({kind:'manual',connectionRevision:1,catalogUpdatedAt:null}); expect(count(s)).toBe(1);
  const m = p.model(modelBody(c)) as ModelPreset;
  const prepared = p.prepareModel(modelBody(c,{expectedRevision:1,enabled:false}),m.id);
  expect(count(s)).toBe(2); expect(prepared.value.enabled).toBe(false);
  const updated = p.model(modelBody(c,{expectedRevision:1,enabled:false}),m.id);
  expect(updated).toMatchObject(prepared.value);
  expect(() => p.prepareModel(modelBody(c,{expectedRevision:1}),m.id)).toThrow('Revision conflict');
  expect(() => p.model(modelBody(c,{expectedRevision:1}),m.id)).toThrow('Revision conflict');
  expect(() => p.prepareModel(modelBody(c),m.id)).toThrow('Invalid revision');
  expect(() => p.connection(connectionBody(),c.id)).toThrow('Invalid revision');
  p.connection(editConnection(c,{title:'Renamed'}),c.id);
  expect(() => p.prepareConnection(editConnection(c),c.id)).toThrow('Revision conflict');
  expect(() => p.connection(editConnection(c),c.id)).toThrow('Revision conflict');
  expect(p.get<ModelPreset>('model',m.id,1)).toEqual(m);
});

test('catalog/error retention uses credential authority and old connection execution is revoked', () => {
  const s = database(); const p = s.product;
  const c = p.connection(connectionBody({credentialEnv:'NARRATIVE_PROVIDER_TEST_A'})) as Connection;
  const cached = p.save('connection',{...c,catalog:[{id:'synthetic',name:'Synthetic',capabilities:{tools:null},priceRevision:null}],catalogUpdatedAt:stamp,catalogError:'CATALOG_FAILED'},c.id,c.revision) as Connection;
  const rename = p.connection(editConnection(cached,{title:'Renamed'}),c.id) as Connection;
  expect(rename).toMatchObject({catalog:cached.catalog,catalogUpdatedAt:stamp,catalogError:'CATALOG_FAILED'});
  const changed = p.connection(editConnection(rename,{credentialEnv:'NARRATIVE_PROVIDER_TEST_B'}),c.id) as Connection;
  expect(changed).toMatchObject({catalog:[],catalogUpdatedAt:null,catalogError:null});
  expect(() => p.authorize(cached)).toThrow('authority changed'); expect(p.get('connection',cached.id,cached.revision)).toEqual(cached);
  const disabled = p.connection(editConnection(changed,{enabled:false}),c.id) as Connection;
  expect(() => p.authorize(changed)).toThrow('disabled'); expect(disabled.enabled).toBe(false);
});

test('model metadata is server sourced, strict and preserves pinned models after disabling', () => {
  const s = database(); const p = s.product; const chat = s.createChat('Metadata only');
  const c = p.connection(connectionBody()) as Connection;
  const cached = p.save('connection',{...c,catalog:[{id:'synthetic',name:'Synthetic',capabilities:{},priceRevision:null}],catalogUpdatedAt:stamp},c.id,c.revision) as Connection;
  const overrides = {tools:false,structuredOutput:null,note:'User confirmed; no provider claim'};
  const m = p.model(modelBody(cached,{enabled:true,userOverrides:overrides})) as ModelPreset;
  expect(m.source).toEqual({kind:'catalog',connectionRevision:cached.revision,catalogUpdatedAt:stamp});
  const profile = p.profile(chat.id);
  const {chatId:_chatId,revision:_revision,...profileBody} = profile;
  p.updateProfile(chat.id,{...profileBody,expectedRevision:profile.revision,routes:{...profile.routes,main:ref(m)}});
  p.model(modelBody(cached,{enabled:false,expectedRevision:m.revision,userOverrides:overrides}),m.id);
  expect(p.snapshot(chat.id)?.models.main).toMatchObject({...m,connection:cached});
  expect(p.authorize(cached)).toEqual(cached);
  for (const userOverrides of [null,{tools:true,structuredOutput:null},{tools:1,structuredOutput:null,note:''},{tools:null,structuredOutput:null,note:'',grant:true}]) expect(() => p.model(modelBody(cached,{userOverrides}))).toThrow();
  expect(() => p.model(modelBody(cached,{source:m.source}))).toThrow('Unknown request field');
  expect(() => p.model(modelBody(cached,{enabled:null}))).toThrow('Invalid boolean');
});

test('archive roundtrip retains management metadata, strips authority, and rejects forged metadata atomically', () => {
  const s = database(); const p = s.product;
  const c = p.connection(connectionBody({credentialEnv:'NARRATIVE_PROVIDER_TEST_A'})) as Connection;
  const m = p.model(modelBody(c,{enabled:false,userOverrides:{tools:null,structuredOutput:false,note:'manual verification'}})) as ModelPreset;
  const archive = p.export(); const restored = database(); restored.product.import(archive);
  expect(restored.product.get('model',m.id)).toEqual(m);
  expect(restored.product.get<Connection>('connection',c.id)).toMatchObject({enabled:false,catalogUpdatedAt:null});
  expect(restored.product.get('connection',c.id)).not.toHaveProperty('credentialEnv');
  expect(p.get<Connection>('connection',c.id).credentialEnv).toBe('NARRATIVE_PROVIDER_TEST_A');
  for (const mutate of [
    (body:any) => {body.source.connectionRevision=999;},
    (body:any) => {body.source.kind='catalog';},
    (body:any) => {body.userOverrides.tools='yes';},
    (body:any) => {body.source.catalogUpdatedAt='2026-02-30T00:00:00.000Z';},
  ]) {
    const bad = structuredClone(archive); const row = bad.tables.versions.find((r:any) => r.kind === 'model')!; const body = JSON.parse(row.body); mutate(body); row.body=JSON.stringify(body);
    const empty = database(); expect(() => empty.product.import(bad)).toThrow(); expect(count(empty)).toBe(0);
  }
  const legacy = structuredClone(archive);
  for (const row of legacy.tables.versions) { const body = JSON.parse(row.body); delete body.source; delete body.enabled; delete body.userOverrides; delete body.catalogUpdatedAt; if(row.kind==='connection')body.enabled=true;row.body=JSON.stringify(body); }
  const legacyStore = database(); legacyStore.product.import(legacy); expect(legacyStore.product.get('model',m.id)).not.toHaveProperty('enabled');
});

test('readiness reveals only presence and approved origin without authenticating', () => {
  const s = database(); const c = s.product.connection(connectionBody()) as Connection;
  const network = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
  expect(readiness(s.product,c,[])).toEqual({enabled:true,originApproved:false,credentialStatus:'not-required',catalogKind:'remote'});
  vi.stubEnv('NARRATIVE_PROVIDER_READINESS','TOP_SECRET');
  const withKey = {...c,credentialEnv:'NARRATIVE_PROVIDER_READINESS'};
  const ready = readiness(s.product,withKey,['http://127.0.0.1:9999']);
  expect(ready.credentialStatus).toBe('configured'); expect(JSON.stringify(ready)).not.toContain('TOP_SECRET');
  vi.stubEnv('NARRATIVE_PROVIDER_READINESS','bad\r\nvalue'); expect(readiness(s.product,withKey,[]).credentialStatus).toBe('missing');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS',s.path);
  expect(readiness(s.product,{...c,protocol:'vertex-gemini-v1'},[])).toMatchObject({credentialStatus:'adc-configured',catalogKind:'local-support'});
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS',s.path+'.absent'); expect(readiness(s.product,{...c,protocol:'vertex-gemini-v1'},[]).credentialStatus).toBe('adc-unchecked');
  expect(network).not.toHaveBeenCalled();
});

test('impact counts current profile references through old model revisions and exposes metadata only', () => {
  const s = database(); const p = s.product; const chat = s.createChat('Reference title');
  const c = p.connection(connectionBody()) as Connection; const m = p.model(modelBody(c)) as ModelPreset;
  const profile = p.profile(chat.id); const {chatId:_chatId,revision:_revision,...body} = profile;
  p.updateProfile(chat.id,{...body,expectedRevision:profile.revision,routes:{...profile.routes,main:ref(m),translation:ref(m)}});
  const config = defaultStoryConfig(); s.story.saveConfig(chat.id,{expectedRevision:0,module:null,stateModel:ref(m),memory:{...config.memory,model:ref(m)}});
  s.story.saveConfig(chat.id,{expectedRevision:1,module:null,stateModel:null,memory:{...config.memory,model:ref(m)}});
  p.model(modelBody(c,{expectedRevision:m.revision,enabled:false}),m.id);
  const impact = managementImpact(p,'connection',c.id);
  expect(impact).toMatchObject({profileCount:1,storyProfileCount:1,modelRevisionCount:2,profiles:[{chatId:chat.id,title:chat.title,roles:['main','translation']}],storyProfiles:[{chatId:chat.id,title:chat.title,roles:['memory']}]});
  expect(managementImpact(p,'model',m.id).archivedRevisionCount).toBe(1);
  expect(Object.keys(impact.profiles[0]).sort()).toEqual(['chatId','roles','title']);
});
