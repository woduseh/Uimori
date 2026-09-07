import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { splitSource, createTranslationPlan, validateTranslationPlan, aggregateTranslation, type TranslationPlan, type TranslationResult } from '../core/auxiliary.js';
import type { Resource, RunSnapshot } from '../core/types.js';
import { HttpError, type Store, type Chat, type Source } from './store.js';
import { fields, record, text } from './product-store.js';
import { latestTranslation, validateTranslationArtifact } from './source-editing.js';
import { sourceTimeContext } from './product-auxiliary.js';
import { mapNativeForkSnapshot, copyNativeFork } from './native-archive.js';
import { contextDependencyKey, measureMainContext } from './context-planning.js';
import { nativeResources } from '../core/native-context.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import { copyStoryFork } from './story-archive.js';
import { copyPackageFork } from './package-behavior-host.js';

type Row = Record<string, any>;
const json = JSON.stringify;
const parse = (value: string | null): any => value === null ? null : JSON.parse(value);
const zeroUsage = { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null };
function forkId(chatId: string, key: string) {
  const hash = createHash('sha256').update(json(['chat-fork-v1',chatId,key])).digest('hex').slice(0,32).split('');
  hash[12]='5'; hash[16]=((parseInt(hash[16],16)&3)|8).toString(16);
  const value=hash.join(''); return [value.slice(0,8),value.slice(8,12),value.slice(12,16),value.slice(16,20),value.slice(20)].join('-');
}

/** Copy stored artifacts only. This function never queues jobs or records provider attempts. */
export function forkChat(store: Store, chatId: string, value: unknown): Chat {
  const body=record(value); fields(body,['fromRevision','title','idempotencyKey']);
  const fromRevision=text(body.fromRevision,'source revision',100);
  const key=text(body.idempotencyKey,'idempotency key',120);
  const suppliedTitle=body.title === undefined ? null : text(body.title,'title',200);
  const id=forkId(chatId,key); const branchId='main:'+id;
  const command=json({chatId,fromRevision,title:suppliedTitle});
  return store.transaction(()=>{
    const existing=store.db.prepare('SELECT id FROM chats WHERE id=?').get(id);
    if(existing){
      const event=store.db.prepare("SELECT entity_id FROM events WHERE chat_id=? AND kind='chat.forked' ORDER BY seq LIMIT 1").get(id) as Row | undefined;
      if(event?.entity_id !== command)throw new HttpError(409,'Fork idempotency key reused with different selection');
      return store.chat(id);
    }
    const originalChat=store.chat(chatId); const selected=store.source(fromRevision);
    if(selected.chatId !== chatId)throw new HttpError(400,'Source outside chat');
    const ancestors:Source[]=[]; const seen=new Set<string>(); let cursor:Source | null=selected;
    while(cursor){
      if(cursor.chatId !== chatId || seen.has(cursor.id))throw new HttpError(400,'Invalid fork ancestry');
      seen.add(cursor.id); ancestors.unshift(cursor); cursor=cursor.parentRevision ? store.source(cursor.parentRevision) : null;
    }
    const sourceIds=new Map(ancestors.map(source=>[source.id,randomUUID()]));
    const runIds=new Map(ancestors.map(source=>[source.runId,randomUUID()]));
    const originalRuns=new Map(ancestors.map(source=>[source.runId,store.run(source.runId)]));
    for(const source of ancestors){
      const run=originalRuns.get(source.runId)!;
      if(run.status !== 'completed' || run.sourceRevision !== source.id || run.chatId !== chatId || run.parentRevision !== source.parentRevision ||
        !store.validateHistory(run.snapshot.history,source.parentRevision))throw new HttpError(400,'Invalid completed fork source');
    }
    const resourceIds=new Map<string,string>();
    const localResources=store.resources(chatId);
    for(const resource of [...localResources,...[...originalRuns.values()].filter(run=>!run.snapshot.profile).flatMap(run=>run.snapshot.resources)]){
      if(!resourceIds.has(resource.id))resourceIds.set(resource.id,randomUUID());
    }
    const resource=(value:Resource):Resource=>({...structuredClone(value),chatId:id,id:resourceIds.get(value.id) ?? value.id,
      ...(value.relatedIds ? {relatedIds:value.relatedIds.map(reference=>resourceIds.get(reference) ?? reference)} : {})});
    const assetIds=new Map(store.product.assets(chatId).map(asset=>[asset.id,randomUUID()]));
    const time=new Date().toISOString(); let title=suppliedTitle;
    if(title===null){
      const titles=new Set(store.chats().map(chat=>chat.title));
      for(let number=1;title===null;number++){
        const suffix=' · 포크 '+number; const candidate=originalChat.title.slice(0,200-suffix.length)+suffix;
        if(!titles.has(candidate))title=candidate;
      }
    }
    store.db.prepare('INSERT INTO chats VALUES(?,?,NULL,1,?,?)').run(id,title,json(originalChat.settings),time);
    store.organization.copy(chatId,id);
    store.db.prepare('INSERT INTO branches VALUES(?,?,?,NULL,1,1)').run(branchId,id,'기본 분기');
    for(const original of localResources){const copied=resource(original);store.db.prepare('INSERT INTO resources VALUES(?,?,?)').run(copied.id,id,json(copied));}
    const profile=store.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chatId) as Row | undefined;
    if(profile)store.db.prepare('INSERT INTO profiles VALUES(?,?)').run(id,json({...parse(profile.body),chatId:id,revision:1}));
    for(const [oldId,newId] of assetIds){
      const {asset,bytes}=store.product.asset(oldId); const copied={...asset,id:newId,chatId:id,url:'/api/assets/'+newId};
      store.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(newId,id,json(copied),bytes);
    }
    for(const original of ancestors){
      const run=originalRuns.get(original.runId)!; const runId=runIds.get(run.id)!; const sourceId=sourceIds.get(original.id)!;
      const parentRevision=original.parentRevision ? sourceIds.get(original.parentRevision)! : null;
      const snapshot:RunSnapshot={...structuredClone(run.snapshot),chatId:id,parentRevision,branchId,
        history:run.snapshot.history.map(item=>({...item,revision:sourceIds.get(item.revision)!})),
        forkedFrom:{chatId,runId:run.id,sourceRevision:original.id}};
      delete snapshot.candidateOf;
      mapNativeForkSnapshot(snapshot,id,branchId,sourceIds,runIds);
      if(snapshot.profile){
        snapshot.profile.chatId=id;
        snapshot.resources=[...store.product.resources(id,snapshot.profile),...nativeResources(id,snapshot.nativeBot)];
      }else snapshot.resources=snapshot.resources.map(resource);
      store.db.prepare("INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,usage,created_at,updated_at,branch_id) VALUES(?,?,?,'completed',?,?,?,?,?,?,?,?,?)")
        .run(runId,id,parentRevision,run.request,json(snapshot),'fork:'+original.id,json({forkedFrom:{chatId,runId:run.id,sourceRevision:original.id}}),sourceId,json(zeroUsage),original.createdAt,original.createdAt,branchId);
      const baseline=store.sourceOriginal(original.id);
      store.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(sourceId,id,runId,parentRevision,baseline.text,baseline.hash,baseline.createdAt);
      for(const edit of store.db.prepare('SELECT * FROM source_edits WHERE source_id=? ORDER BY revision').all(original.id) as Row[])store.db.prepare('INSERT INTO source_edits VALUES(?,?,?,?,?)').run(sourceId,edit.revision,edit.text,edit.hash,edit.created_at);
      const copiedSource=store.source(sourceId);
      const oldBlocks=splitSource(original); const newBlocks=splitSource(copiedSource);
      const anchors=new Map(oldBlocks.map((block,index)=>[block.anchor,newBlocks[index].anchor]));
      // Rewrite identity fields, never prose, prompt text, protected literals or provider payloads.
      const artifact=(value:unknown,field=''):any=>{
        if(typeof value === 'string'){
          if(field==='sourceRevision')return sourceIds.get(value) ?? value;
          if(field==='chatId')return value===chatId ? id : value;
          if(field==='anchor'||field==='blockAnchor'||field==='anchors')return anchors.get(value) ?? value;
          if(field==='assetRef')return assetIds.get(value) ?? value;
          return value;
        }
        if(Array.isArray(value))return value.map(item=>artifact(item,field));
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,artifact(item,name)]));
        return value;
      };
      const completed=store.db.prepare("SELECT j.*,r.result,r.created_at AS result_created_at FROM jobs j JOIN job_results r ON r.job_id=j.id WHERE j.source_revision=? AND j.status='completed' ORDER BY j.created_at,j.id").all(original.id) as Row[];
      for(const job of completed){
        if(job.chat_id !== chatId)throw new HttpError(400,'Invalid completed fork job');
        if(job.source_hash!==original.hash)continue;
        if(job.kind==='translation'){if(latestTranslation(store,original.id)?.id!==job.id)continue;validateTranslationArtifact(store,store.job(job.id),original);}
        const jobId=randomUUID(); const oldInput=parse(job.input);
        const input=job.kind==='translation'&&oldInput?structuredClone(Object.fromEntries(['promptSelection','promptControlSelection','translationModelSelection','translationModelSnapshot'].filter(key=>Object.hasOwn(oldInput,key)).map(key=>[key,oldInput[key]]))):null;
        const resolved=store.product.resolveJobPrompt(snapshot,input);
        const result=artifact(parse(job.result));
        if(result.sourceRevision!==sourceId||result.sourceHash!==original.hash)throw new HttpError(400,'Invalid completed fork result');
        let plan:TranslationPlan | null=null;
        const chunks=store.product.chunks(job.id);
        if(job.plan!==null){
          const oldSnapshot=store.product.resolveJobPrompt(run.snapshot,input);
          validateTranslationPlan(original,sourceTimeContext(oldSnapshot,'translation'),parse(job.plan));
          const mapped=artifact(parse(job.plan)); mapped.context=createTranslationPlan(copiedSource,sourceTimeContext(resolved,'translation'),24000).context;
          plan=validateTranslationPlan(copiedSource,mapped.context,mapped);
          if(chunks.length!==plan.chunks.length||chunks.some(chunk=>chunk.status!=='completed'||!chunk.result))throw new HttpError(400,'Incomplete fork translation');
          const combined=aggregateTranslation(plan,chunks.map(chunk=>artifact(chunk.result) as TranslationResult));
          if(combined.status!=='completed'||!isDeepStrictEqual(combined.segments,result.segments))throw new HttpError(400,'Invalid fork translation coverage');
        }else if(chunks.length)throw new HttpError(400,'Fork translation plan missing');
        store.db.prepare("INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,generation,owner,input,error,created_at,updated_at,revision,plan,retry_chunk) VALUES(?,?,?,?,?,'completed',?,NULL,?,NULL,?,?,?,?,NULL)")
          .run(jobId,id,sourceId,original.hash,job.kind,job.generation,json(input),job.created_at,job.updated_at,job.revision,plan === null ? null : json(plan));
        store.db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(jobId,job.generation,json(result),job.result_created_at);
        for(const chunk of chunks)store.db.prepare("INSERT INTO job_chunks(job_id,id,status,attempt,input,result,error) VALUES(?,?,'completed',?,NULL,?,NULL)")
          .run(jobId,chunk.id,chunk.attempt,json(artifact(chunk.result)));
      }
    }
    const head=sourceIds.get(fromRevision)!;
    store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(head,id);
    store.db.prepare('UPDATE branches SET head_revision=? WHERE id=?').run(head,branchId);
    copyStoryFork(store,chatId,id,sourceIds,runIds);
    copyNativeFork(store,chatId,id,fromRevision,sourceIds);
    copyPackageFork(store,id,branchId,sourceIds,head);
    for(const copiedId of runIds.values()){
      const copied=store.run(copiedId);
      if(copied.snapshot.contextPlan)copied.snapshot.contextPlan.dependencyKey=contextDependencyKey(copied.snapshot);
      const snapshot=compileSnapshotPrompt({...copied.snapshot,promptCompilation:undefined});
      if(snapshot.contextPlan?.status==='ready')snapshot.contextPlan.estimatedInputTokens=measureMainContext(snapshot).estimatedInputTokens;
      store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(json(snapshot),copiedId);
    }
    store.event(id,'chat.forked',command);
    return store.chat(id);
  });
}
