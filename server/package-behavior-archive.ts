import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { behaviorActionAllowed, behaviorActionTriggers, behaviorRecord, evaluateBehaviorAction, parseBehaviorOutput, validateBehaviorValue, validatePackageBehavior, type PackageBehavior } from '../core/package-behavior.js';
import { evaluatePromptExpression } from '../core/prompt-program.js';
import { inspectRuntimeValue } from '../core/prompt-values.js';
import type { PackageExecutionState } from '../core/execution-context.js';
import type { RunSnapshot } from '../core/types.js';
import { assertBehaviorToolCapability } from '../core/package-behavior-tools.js';
import { behaviorPayloadHash, recordDraws, type BehaviorScope } from './package-behavior-store.js';
import { HttpError, type Store } from './store.js';
import { packageBehaviorRunTables, validateRunBehaviorArchive } from './package-behavior-run-archive.js';

export const packageBehaviorTables=['package_behavior_states','package_behavior_journal','package_behavior_heads','package_behavior_outputs',...packageBehaviorRunTables];
type Row=Record<string,any>;
function reject(message:string):never{throw new HttpError(400,`Invalid package behavior archive: ${message}`);}
function object(value:unknown,allowed:string[]):Row{const v=behaviorRecord(value);if(Object.keys(v).some(k=>!allowed.includes(k)))reject('unknown fields');return v;}
function text(value:unknown,max=200):asserts value is string{if(typeof value!=='string'||!value.length||value.length>max)reject('string');}
function revision(value:unknown,min=0):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<min)reject('revision');}
function digest(value:unknown):asserts value is string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))reject('hash');}
const same=(a:unknown,b:unknown,message:string)=>{if(!isDeepStrictEqual(a,b))reject(message);};
function definition(store:Store,scope:BehaviorScope):PackageBehavior {
  text(scope.chatId);text(scope.branchId);text(scope.attachmentInstanceId);text(scope.packageId);revision(scope.packageRevision,1);revision(scope.behaviorRevision,1);revision(scope.schemaVersion,1);
  store.chat(scope.chatId);store.product.branch(scope.chatId,scope.branchId);
  const content=store.product.get<any>('content',scope.packageId,scope.packageRevision);
  const b=validatePackageBehavior(content.package?.behavior);
  if(b.revision!==scope.behaviorRevision||b.schemaVersion!==scope.schemaVersion)reject('definition revision');
  if(!['bot','persona','module'].some(role=>scope.attachmentInstanceId===`${scope.packageId}:${role}`))reject('attachment identity');
  return b;
}
function scopeOf(value:unknown):BehaviorScope{return object(value,['chatId','branchId','attachmentInstanceId','packageId','packageRevision','behaviorRevision','schemaVersion']) as BehaviorScope;}
function sourceHashInChat(store:Store,chatId:string,hash:string|null){if(hash===null)return;digest(hash);if(!store.db.prepare('SELECT 1 FROM sources s LEFT JOIN source_edits e ON e.source_id=s.id WHERE s.chat_id=? AND (s.hash=? OR e.hash=?) LIMIT 1').get(chatId,hash,hash))reject('source hash scope');}
function recordedDrawShape(b:PackageBehavior,value:unknown){
  const draws=behaviorRecord(value);inspectRuntimeValue(draws);
  for(const [id,result] of Object.entries(draws)){
    const declarations=b.actions.flatMap(a=>a.draws??[]).filter(d=>d.id===id);
    const valid=declarations.some(d=>d.type==='integer'?Number.isSafeInteger(result)&&result>=d.min&&result<=d.max:d.type==='choice'?d.values.some(v=>isDeepStrictEqual(v,result)):Array.isArray(result)&&isDeepStrictEqual(result.map(behaviorPayloadHash).sort(),d.values.map(behaviorPayloadHash).sort()));
    if(!valid)reject('recorded draw shape');
  }
}
function executionState(store:Store,value:unknown,chatId:string,branchId:string,packages?:RunSnapshot['profile']):PackageExecutionState{
  const s=object(value,['instanceId','packageId','packageRevision','role','behaviorRevision','schemaVersion','stateRevision','state','draws']);
  if(!['bot','persona','module'].includes(s.role)||s.instanceId!==`${s.packageId}:${s.role}`)reject('execution identity');
  const b=definition(store,{chatId,branchId,attachmentInstanceId:s.instanceId,packageId:s.packageId,packageRevision:s.packageRevision,behaviorRevision:s.behaviorRevision,schemaVersion:s.schemaVersion});
  revision(s.stateRevision);validateBehaviorValue(b.stateSchema,s.state);recordedDrawShape(b,s.draws);
  if(packages){if(!packages.packageAttachments?.some(r=>r.id===s.packageId&&r.revision===s.packageRevision&&r.role===s.role))reject('snapshot attachment');const pkg=packages.packages?.find(p=>p.id===s.packageId&&p.revision===s.packageRevision);if(!pkg?.behavior||!isDeepStrictEqual(b,pkg.behavior))reject('frozen behavior definition');}
  return s as PackageExecutionState;
}
export function validatePackageBehaviorRunSnapshot(store:Store,snapshot:RunSnapshot):void{
  assertBehaviorToolCapability(snapshot);
  if(snapshot.executionClock!==undefined){const c=object(snapshot.executionClock,['iso','unix']);text(c.iso,100);revision(c.unix);const parsed=Date.parse(c.iso);if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==c.iso||Math.floor(parsed/1000)!==c.unix)reject('execution clock');}
  const expected=(snapshot.profile?.packageAttachments??[]).filter(r=>snapshot.profile?.packages?.some(p=>p.id===r.id&&p.revision===r.revision&&p.behavior)).map(r=>`${r.id}:${r.role}`);
  const expectsExecution=(snapshot.profile?.packageAttachments??[]).some(ref=>!(ref.role==='persona'&&snapshot.profile?.creative.personaReference===false)&&snapshot.profile?.packages?.find(pkg=>pkg.id===ref.id&&pkg.revision===ref.revision)?.behavior?.actions.some(action=>behaviorActionTriggers(action).some(trigger=>trigger==='before-turn'||trigger==='model')));
  if(expectsExecution!==(snapshot.behaviorExecution!==undefined))reject('execution contract');
  if(expected.length&&snapshot.packageStates===undefined)reject('missing frozen state');
  if(snapshot.packageStates!==undefined){
    if(!Array.isArray(snapshot.packageStates)||snapshot.packageStates.length>100)reject('snapshot states');
    const seen=new Set<string>();for(const state of snapshot.packageStates){const s=executionState(store,state,snapshot.chatId,snapshot.branchId??`main:${snapshot.chatId}`,snapshot.profile);if(seen.has(s.instanceId))reject('duplicate snapshot instance');seen.add(s.instanceId);}
    same([...seen].sort(),expected.sort(),'missing frozen state');
  }
  if(snapshot.behaviorExecution!==undefined){
    const e=object(snapshot.behaviorExecution,['version','opportunityId','baseStates','automaticResults']);if(e.version!==1)reject('execution version');digest(e.opportunityId);
    if(!Array.isArray(e.baseStates)||e.baseStates.length>100||!Array.isArray(e.automaticResults)||e.automaticResults.length>100)reject('execution lists');
    const ids=new Set<string>();for(const state of e.baseStates){const s=executionState(store,state,snapshot.chatId,snapshot.branchId??`main:${snapshot.chatId}`,snapshot.profile);if(ids.has(s.instanceId))reject('duplicate base state');ids.add(s.instanceId);}same([...ids].sort(),expected.sort(),'base state scope');
    for(const raw of e.automaticResults){const result=object(raw,['instanceId','actionId','result']);text(result.instanceId);text(result.actionId);inspectRuntimeValue(result.result);}
  }
}
export function validatePackageBehaviorArchive(store:Store):void{
  const db=store.db,rows=(table:string)=>db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const states=new Map<string,{row:Row;scope:BehaviorScope;behavior:PackageBehavior}>();const key=(chat:string,branch:string,instance:string)=>JSON.stringify([chat,branch,instance]);
  for(const row of rows('package_behavior_states')){
    const scope=scopeOf(JSON.parse(row.scope)),b=definition(store,scope);same([scope.chatId,scope.branchId,scope.attachmentInstanceId],[row.chat_id,row.branch_id,row.instance_id],'state row scope');
    revision(row.state_revision);digest(row.definition_hash);if(behaviorPayloadHash(b)!==row.definition_hash)reject('definition hash');validateBehaviorValue(b.stateSchema,JSON.parse(row.state));
    states.set(key(row.chat_id,row.branch_id,row.instance_id),{row,scope,behavior:b});
  }
  const latest=new Map<string,Row>();
  for(const row of rows('package_behavior_journal')){
    const owner=states.get(key(row.chat_id,row.branch_id,row.instance_id));if(!owner)reject('orphan journal');
    const {scope,behavior:b}=owner;const r=object(JSON.parse(row.result),['chatId','branchId','attachmentInstanceId','packageId','packageRevision','behaviorRevision','schemaVersion','stateRevision','state','beforeStateRevision','beforeState','provenance','idempotencyKey','sourceHash','draws','drawSeed','actionResult']);
    const payload=object(JSON.parse(row.payload),['scope','provenance','actionId','input','expectedStateRevision','expectedSourceHash','idempotencyKey','parserIds','text','baseStateRevision','sourceHash','hostRuntime']);
    const hostRuntime=payload.hostRuntime??{};behaviorRecord(hostRuntime);inspectRuntimeValue(hostRuntime);
    same(payload.scope,scope,'journal payload scope');same(Object.fromEntries(Object.keys(scope).map(k=>[k,r[k]])),scope,'journal result scope');
    text(row.idempotency_key);same([r.idempotencyKey,payload.idempotencyKey],[row.idempotency_key,row.idempotency_key],'journal key');digest(row.payload_hash);if(behaviorPayloadHash(payload)!==row.payload_hash)reject('journal payload hash');
    text(row.created_at,100);if(!Number.isFinite(Date.parse(row.created_at)))reject('journal timestamp');
    revision(r.beforeStateRevision);revision(r.stateRevision,1);if(r.stateRevision!==r.beforeStateRevision+1||r.stateRevision>owner.row.state_revision)reject('journal state revision');
    validateBehaviorValue(b.stateSchema,r.beforeState);validateBehaviorValue(b.stateSchema,r.state);sourceHashInChat(store,scope.chatId,r.sourceHash);
    same(payload.provenance,r.provenance,'journal provenance');behaviorRecord(r.draws);inspectRuntimeValue(r.draws);
    if(['ui-action','before-turn','model-tool'].includes(r.provenance)){
      if(payload.expectedStateRevision!==r.beforeStateRevision||payload.expectedSourceHash!==r.sourceHash)reject('action expectation');const action=b.actions.find(a=>a.id===payload.actionId);if(!action||!behaviorActionAllowed(action,r.beforeState,payload.input,hostRuntime))reject('action contract');
      if(!behaviorActionTriggers(action).includes(r.provenance==='ui-action'?'user':r.provenance==='before-turn'?'before-turn':'model'))reject('action trigger');
      if(action.draws?.length){digest(r.drawSeed);same(recordDraws(action.draws,r.drawSeed),r.draws,'recorded draws');}else if(r.drawSeed!==null||Object.keys(r.draws).length)reject('unexpected draws');
      const evaluated=evaluateBehaviorAction(b,action,r.beforeState,payload.input,r.draws,hostRuntime);
      same(evaluated.state,r.state,'action state');same(evaluated.result,r.actionResult,'action result');
      if(r.provenance!=='ui-action'){
        const runId=r.idempotencyKey.split(':')[1],run=store.run(runId),progressRow=db.prepare('SELECT body FROM package_behavior_runs WHERE run_id=?').get(runId) as Row|undefined;
        const entry=progressRow?(JSON.parse(progressRow.body).entries as Row[]).find(entry=>entry.instanceId===scope.attachmentInstanceId&&entry.actionId===payload.actionId):undefined;
        if(!entry||run.chatId!==scope.chatId||(run.snapshot.branchId??`main:${run.chatId}`)!==scope.branchId||run.status!=='completed'||!run.sourceRevision)reject('run journal owner');
        if(r.idempotencyKey!==`run:${runId}:${behaviorPayloadHash(JSON.stringify([entry.instanceId,entry.actionId]))}`)reject('run journal key');
        same([entry.trigger,entry.input,entry.before.stateRevision,entry.before.state,entry.after.stateRevision,entry.after.state,entry.draws,entry.drawSeed,entry.hostRuntime,entry.result],
          [r.provenance==='before-turn'?'before-turn':'model',payload.input,r.beforeStateRevision,r.beforeState,r.stateRevision,r.state,r.draws,r.drawSeed,hostRuntime,r.actionResult],'run journal receipt');
        same(r.sourceHash,store.sourceOriginal(run.sourceRevision).hash,'run journal source');
      }
    }else if(r.provenance==='explicit-reset'){
      if(Object.hasOwn(r,'actionResult'))reject('unexpected action result');
      if(payload.expectedStateRevision!==r.beforeStateRevision||payload.expectedSourceHash!==r.sourceHash||r.drawSeed!==null||Object.keys(r.draws).length)reject('reset contract');same(r.state,b.initialState,'reset state');
    }else if(r.provenance==='local-output-parser'){
      if(Object.hasOwn(r,'actionResult'))reject('unexpected action result');
      if(payload.baseStateRevision!==r.beforeStateRevision||payload.sourceHash!==r.sourceHash||r.drawSeed!==null||Object.keys(r.draws).length)reject('output expectation');
      text(payload.text,500_000);if(createHash('sha256').update(payload.text).digest('hex')!==r.sourceHash)reject('output source text');
      if(!Array.isArray(payload.parserIds)||!payload.parserIds.length||new Set(payload.parserIds).size!==payload.parserIds.length)reject('output parser IDs');
      let next=r.beforeState;const paths:string[]=[];
      for(const id of payload.parserIds){const parser=b.outputParsers.find(p=>p.id===id);if(!parser)reject('output parser');for(const field of parser.fields){const p=field.path.join('/');if(paths.some(q=>q===p||q.startsWith(p+'/')||p.startsWith(q+'/')))reject('output overlapping fields');paths.push(p);}
        if(parser.when!==undefined){const allowed=evaluatePromptExpression(parser.when,{}, {runtime:{...hostRuntime,state:r.beforeState,input:{},draws:{}}});if(typeof allowed!=='boolean')reject('output condition');if(!allowed)continue;}next=parseBehaviorOutput(b,parser,next,payload.text);
      }same(next,r.state,'output result');
    }else reject('journal provenance');
    const k=key(row.chat_id,row.branch_id,row.instance_id),previous=latest.get(k);if(previous&&previous.stateRevision===r.stateRevision)reject('duplicate journal revision');if(!previous||previous.stateRevision<r.stateRevision)latest.set(k,r);
  }
  for(const [k,r] of latest){const owner=states.get(k)!;if(owner.row.state_revision===r.stateRevision)same(JSON.parse(owner.row.state),r.state,'latest state journal');}
  for(const row of rows('package_behavior_heads')){
    const owner=states.get(key(row.chat_id,row.branch_id,row.instance_id));if(!owner)reject('orphan head');recordedDrawShape(owner.behavior,JSON.parse(row.draws));if(!['ready','stale','failed'].includes(row.status))reject('head status');if(row.error!==null)text(row.error,4000);
    const deps=JSON.parse(row.dependencies);if(!Array.isArray(deps)||deps.length>10_000)reject('head dependencies');const seen=new Set<string>();for(const dep of deps){const d=object(dep,['id','hash']);text(d.id);digest(d.hash);if(seen.has(d.id))reject('duplicate dependency');seen.add(d.id);const source=store.sourceAtHash(d.id,d.hash);if(source.chatId!==row.chat_id)reject('dependency source scope');}
  }
  for(const row of rows('package_behavior_outputs')){
    const source=store.source(row.source_id),run=store.run(source.runId),branch=run.snapshot.branchId??`main:${source.chatId}`;
    const out=object(JSON.parse(row.body),['before','after','status','error','sourceHash']);if(!['ready','failed'].includes(out.status))reject('output status');if(out.error!==null)text(out.error,4000);digest(out.sourceHash);store.sourceAtHash(source.id,out.sourceHash);
    const before=executionState(store,out.before,source.chatId,branch,run.snapshot.profile),after=executionState(store,out.after,source.chatId,branch,run.snapshot.profile);
    same(before,(run.snapshot.behaviorExecution?.baseStates??run.snapshot.packageStates)?.find(s=>s.instanceId===row.instance_id),'output frozen before state');
    if(row.instance_id!==before.instanceId||row.instance_id!==after.instanceId)reject('output instance');
    same([before.packageId,before.packageRevision,before.role,before.behaviorRevision,before.schemaVersion],[after.packageId,after.packageRevision,after.role,after.behaviorRevision,after.schemaVersion],'output definition');
    const progressRow=db.prepare('SELECT body FROM package_behavior_runs WHERE run_id=?').get(run.id) as Row|undefined;
    const progress=progressRow?JSON.parse(progressRow.body):undefined;
    const actionCount=progress?(progress.entries as {instanceId:string}[]).filter(entry=>entry.instanceId===row.instance_id).length:0;
    if(out.status==='failed'){
      const behavior=run.snapshot.profile?.packages?.find(pkg=>pkg.id===before.packageId&&pkg.revision===before.packageRevision)?.behavior;
      if(behavior?.mode==='annotation'&&!isDeepStrictEqual(before,after))same(after,progress?.states.find((state:PackageExecutionState)=>state.instanceId===row.instance_id),'failed annotation staged state');
      else same(before,after,'failed output mutation');
    }else if(after.stateRevision<before.stateRevision||after.stateRevision>before.stateRevision+actionCount+1)reject('output revision');
  }
  validateRunBehaviorArchive(store,(value,chatId,branchId,profile)=>executionState(store,value,chatId,branchId,profile));
}
