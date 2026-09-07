import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { assetDeletionRoutes, deleteChatAsset } from '../server/asset-deletion.js';
import { imageJobInput } from '../server/package-images.js';

const owned: { directory:string;store:Store;app:FastifyInstance }[]=[];
afterEach(async()=>{
  for(const {directory,store,app} of owned.splice(0)){
    await app.close();store.close();
    const target=resolve(directory),inside=relative(resolve(tmpdir()),target);
    if(isAbsolute(inside)||inside.startsWith('..')||!basename(target).startsWith('uimori-asset-deletion-'))throw new Error('Unsafe fixture cleanup');
    rmSync(target,{recursive:true,force:true});
  }
});
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'uimori-asset-deletion-')),store=new Store(join(directory,'synthetic.sqlite')),app=Fastify();
  owned.push({directory,store,app});
  app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode??500).send({message:(error as Error).message}));
  const published:string[]=[];assetDeletionRoutes(app,store,id=>published.push(id));
  const chat=store.createChat('Synthetic image deletion');
  const asset=store.product.createAsset(chat.id,{title:'Unused synthetic image',mime:'image/png',base64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),description:'Synthetic',actor:'',outfit:'',location:'',allowedUse:'both'});
  return {store,app,chat,asset,published};
}
function begin(store:Store,chatId:string){
  const chat=store.chat(chatId),profile=store.product.snapshot(chatId);
  return store.createRun(chatId,{request:'Synthetic',expectedRevision:chat.headRevision,expectedSettingsRevision:chat.settingsRevision,idempotencyKey:'asset-run'},selected=>({chatId,parentRevision:selected.headRevision,settingsRevision:selected.settingsRevision,settings:selected.settings,request:'Synthetic',history:[],resources:[],profile})).run;
}

test('unused upload deletion removes bytes, emits an event, and leaves archive valid',async()=>{
  const {store,app,chat,asset,published}=fixture();const before=store.product.export();
  const result=await app.inject({method:'DELETE',url:`/api/chats/${chat.id}/assets/${asset.id}`,payload:{}});
  expect(result.statusCode).toBe(200);expect(result.json()).toEqual({deleted:true,id:asset.id});
  expect(()=>store.product.asset(asset.id)).toThrow('Asset not found');expect(store.product.assets(chat.id)).toEqual([]);
  expect(published).toEqual([chat.id]);expect(store.events(chat.id,0)).toEqual(expect.arrayContaining([expect.objectContaining({kind:'asset.deleted',entityId:asset.id})]));
  expect(before.tables.assets).toHaveLength(1);expect(store.product.export().tables.assets).toHaveLength(0);
  const directory=mkdtempSync(join(tmpdir(),'uimori-asset-deletion-')),target=new Store(join(directory,'import.sqlite')),appForImport=Fastify();
  owned.push({directory,store:target,app:appForImport});
  expect(()=>target.product.import(store.product.export())).not.toThrow();
});

test('cross-chat and malformed deletions preserve the uploaded bytes',async()=>{
  const {store,app,chat,asset,published}=fixture(),other=store.createChat('Other');
  expect((await app.inject({method:'DELETE',url:`/api/chats/${other.id}/assets/${asset.id}`,payload:{}})).statusCode).toBe(404);
  expect((await app.inject({method:'DELETE',url:`/api/chats/${chat.id}/assets/${asset.id}`,payload:{force:true}})).statusCode).toBe(400);
  expect(store.product.asset(asset.id).bytes).toHaveLength(8);expect(published).toEqual([]);
});

test('active execution and immutable completed image catalogs prevent deletion',()=>{
  const {store,chat,asset}=fixture(),run=begin(store,chat.id);
  expect(()=>deleteChatAsset(store,chat.id,asset.id,{})).toThrow('진행 중인');
  store.startRun(run.id);
  const source=store.completeRun(run.id,'Synthetic source.',{modelCalls:0,inputTokens:null,outputTokens:null,costUsd:null},{...run.snapshot.settings,translation:false,status:false});
  const input=imageJobInput(store,run.snapshot),now=new Date().toISOString();
  store.db.prepare("INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,created_at,updated_at) VALUES(?,?,?,?,?,'completed',?,?,?)").run('frozen-image-job',chat.id,source.id,source.hash,'image',JSON.stringify(input),now,now);
  expect(()=>deleteChatAsset(store,chat.id,asset.id,{})).toThrow('과거');
  expect(store.product.asset(asset.id).bytes).toHaveLength(8);
});
