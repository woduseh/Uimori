import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { defaultSolOptions, SOL_GATEWAYS, solGatewayForEndpoint, validateSolEndpoint, validateSolOptions, type SolOptions } from '../core/sol-config.js';
import { PROVIDER_PROTOCOLS, validateProviderEndpoint, type Connection, type ModelPreset } from '../core/product.js';

const owned: {directory:string; store:Store}[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const target=resolve(item.directory), within=relative(resolve(tmpdir()),target);
    if (isAbsolute(within)||within.startsWith('..')||!basename(target).startsWith('uimori-sol-settings-')) throw new Error('Unsafe test cleanup');
    await rm(target,{recursive:true,force:true});
  }
});
async function database() {
  const directory=await mkdtemp(join(tmpdir(),'uimori-sol-settings-'));
  const store=new Store(join(directory,'story.sqlite')); owned.push({directory,store}); return store;
}
const connection = (store:Store, endpoint=SOL_GATEWAYS[0].endpoint as string, protocol:Connection['protocol']='sol-responses-v1') => store.product.connection({title:'Synthetic Sol',protocol,endpoint,enabled:true,credentialEnv:'NARRATIVE_PROVIDER_SOL_TEST'}) as Connection;
const modelBody = (c:Connection, extra:Record<string,unknown>={}) => ({title:'Synthetic Sol model',connectionId:c.id,connectionRevision:c.revision,modelId:'synthetic-sol',maxOutputTokens:8192,temperature:null,...extra});
const fullOptions:SolOptions = {contextMode:'preloaded',maximumToolRounds:32,terminalLateCorrections:true,serviceTier:'flex',verbosity:'high',reasoningSummary:'detailed',includeEncryptedReasoning:false};

describe('Sol persisted configuration', () => {
  test('defaults are fresh and strict validation preserves explicit false and optional omission', () => {
    expect(defaultSolOptions()).toEqual({contextMode:'model-selected',maximumToolRounds:8,terminalLateCorrections:false,includeEncryptedReasoning:true});
    const first=defaultSolOptions(); first.maximumToolRounds=1; expect(defaultSolOptions().maximumToolRounds).toBe(8);
    const validated=validateSolOptions(fullOptions); expect(validated).toEqual(fullOptions); expect(validated).not.toBe(fullOptions);
    expect(validateSolOptions({contextMode:'model-selected',maximumToolRounds:8,terminalLateCorrections:false})).not.toHaveProperty('includeEncryptedReasoning');
    expect(validateSolOptions({...defaultSolOptions(),maximumToolRounds:0}).maximumToolRounds).toBe(0);
    for (const invalid of [undefined,null,[],{}, {maximumToolRounds:8,terminalLateCorrections:false}, {...fullOptions,contextMode:'auto'}, {...fullOptions,maximumToolRounds:'8'}, {...fullOptions,maximumToolRounds:-1}, {...fullOptions,maximumToolRounds:33}, {...fullOptions,maximumToolRounds:1.5}, {...fullOptions,maximumToolRounds:NaN}, {...fullOptions,terminalLateCorrections:1}, {...fullOptions,serviceTier:null}, {...fullOptions,verbosity:'auto'}, {...fullOptions,reasoningSummary:false}, {...fullOptions,includeEncryptedReasoning:undefined}, {...fullOptions,background:true}, {...fullOptions,credentials:'not-a-setting'}]) expect(()=>validateSolOptions(invalid)).toThrow('INVALID_SOL_OPTIONS');
  });

  test('only three official roots and literal loopback /v1 are accepted', () => {
    expect(PROVIDER_PROTOCOLS).toContain('sol-responses-v1');
    for(const gateway of SOL_GATEWAYS) {
      expect(validateSolEndpoint(gateway.endpoint+'/')).toBe(gateway.endpoint);
      expect(solGatewayForEndpoint(gateway.endpoint)).toBe(gateway.id);
      expect(validateProviderEndpoint('sol-responses-v1',gateway.endpoint)).toBe(gateway.endpoint);
    }
    for(const endpoint of ['http://127.0.0.1:9999/v1','http://[::1]:9999/v1/']) expect(solGatewayForEndpoint(endpoint)).toBe('local');
    for(const endpoint of ['https://unapproved.invalid/v1','https://api.openai.com/v1/responses','https://api.openai.com/other/../v1','https://user:password@api.openai.com/v1','https://api.openai.com/v1?x=1','https://api.openai.com/v1?','https://api.openai.com/v1#','https://api.openai.com:9999/v1','http://api.openai.com/v1','http://localhost:9999/v1','http://127.1:9999/v1','http://2130706433:9999/v1','http://0x7f000001:9999/v1','http://127.0.0.2:9999/v1','http://127.0.0.1:9999/wrong','http://127.0.0.1:9999/a/../v1',' https://api.openai.com/v1','https://api.openai.com\\v1']) expect(()=>validateSolEndpoint(endpoint),endpoint).toThrow('INVALID_SOL_ENDPOINT');
  });

  test('saves default omission and revisioned options, rejects cross-protocol and malformed options', async () => {
    const store=await database(); const c=connection(store);
    const omitted=store.product.model(modelBody(c)) as ModelPreset; expect(omitted).not.toHaveProperty('sol');
    const saved=store.product.model(modelBody(c,{sol:fullOptions,reasoningEffort:'max'})) as ModelPreset;
    expect(saved.sol).toEqual(fullOptions);
    const updated=store.product.model(modelBody(c,{sol:defaultSolOptions(),expectedRevision:saved.revision}),saved.id) as ModelPreset;
    expect(updated).toMatchObject({revision:2,sol:defaultSolOptions()}); expect(store.product.get('model',saved.id,1)).toEqual(saved);
    expect(()=>store.product.model(modelBody(c,{sol:{...fullOptions,maximumToolRounds:33}}))).toThrow();
    expect(()=>store.product.model(modelBody(c,{sol:null}))).toThrow();
    const other=connection(store,'https://api.openai.com/v1','openai-responses-v1');
    expect(()=>store.product.model(modelBody(other,{sol:defaultSolOptions()}))).toThrow('Sol options require');
    expect(store.product.all('model')).toHaveLength(2);
  });

  test('archive roundtrip preserves all Sol revisions and strips connection credentials without changing input', async () => {
    const source=await database(); const c=connection(source);
    const model=source.product.model(modelBody(c,{sol:fullOptions})) as ModelPreset;
    source.product.model(modelBody(c,{sol:defaultSolOptions(),expectedRevision:model.revision}),model.id);
    const archive=source.product.export(), before=JSON.stringify(archive); const target=await database();
    expect(target.product.import(archive)).toMatchObject({restored:true});
    expect(target.product.get('model',model.id,1)).toEqual(model);
    expect(target.product.get('model',model.id,2)).toMatchObject({sol:defaultSolOptions()});
    const restored=target.product.get<Connection>('connection',c.id); expect(restored.enabled).toBe(false); expect(restored).not.toHaveProperty('credentialEnv');
    expect(JSON.stringify(archive)).toBe(before); expect(target.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('archive graph validation rejects bad Sol fields and Sol options attached to another protocol atomically', async () => {
    const source=await database(); const c=connection(source,'https://api.openai.com/v1'); source.product.model(modelBody(c,{sol:fullOptions}));
    const pristine=source.product.export();
    for(const attack of ['unknown-option','invalid-rounds','wrong-protocol','invalid-endpoint']) {
      const archive=structuredClone(pristine);
      const modelRow=archive.tables.versions.find(row=>row.kind==='model')!, connectionRow=archive.tables.versions.find(row=>row.kind==='connection')!;
      const model=JSON.parse(modelRow.body), linked=JSON.parse(connectionRow.body);
      if(attack==='unknown-option') model.sol.hiddenRetry=true;
      if(attack==='invalid-rounds') model.sol.maximumToolRounds=-1;
      if(attack==='wrong-protocol') linked.protocol='openai-responses-v1';
      if(attack==='invalid-endpoint') linked.endpoint='https://unapproved.invalid/v1';
      modelRow.body=JSON.stringify(model); connectionRow.body=JSON.stringify(linked);
      const before=JSON.stringify(archive), target=await database();
      expect(()=>target.product.import(archive),attack).toThrow(); expect(target.product.library()).toMatchObject({models:[],connections:[]}); expect(JSON.stringify(archive)).toBe(before);
    }
  });
});
