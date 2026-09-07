import { executionContext, packageInstanceId, type PackageExecutionState } from '../core/execution-context.js';
import type { RuntimeValue } from '../core/prompt-program.js';
import { validatePackageBehavior } from '../core/package-behavior.js';
import type { ContentPackage, PackageAttachment } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import type { BehaviorScope, BehaviorState } from './package-behavior-store.js';
import { HttpError, type Store, type Run, type Source } from './store.js';
import { captureLogicalHistory } from './prompt-snapshot.js';
import { HiddenStoryStore } from './hidden-story.js';
import { commitRunBehaviorInstance, completedRunBehaviorView, copyForkRunBehaviors } from './package-behavior-run.js';

type Row = Record<string, any>;
type Definition = { ref: PackageAttachment; pkg: ContentPackage; scope: BehaviorScope };
export function initBehaviorHost(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS package_behavior_heads(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,dependencies TEXT NOT NULL,status TEXT NOT NULL,error TEXT,draws TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id));
    CREATE TABLE IF NOT EXISTS package_behavior_outputs(source_id TEXT NOT NULL,instance_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_id,instance_id));`);
}
function definitions(store: Store, chatId: string, branchId: string, snapshot?: RunSnapshot): Definition[] {
  const profile = snapshot?.profile ?? store.product.snapshot(chatId);
  return (profile?.packageAttachments ?? []).flatMap(ref => {
    const pkg = profile?.packages?.find(p => p.id === ref.id && p.revision === ref.revision);
    if (!pkg?.behavior) return [];
    validatePackageBehavior(pkg.behavior);
    return [{ref,pkg,scope:{chatId,branchId,attachmentInstanceId:packageInstanceId(ref),packageId:ref.id,packageRevision:ref.revision,behaviorRevision:pkg.behavior.revision,schemaVersion:pkg.behavior.schemaVersion}}];
  });
}
function dependencies(store: Store, chatId: string, branchId: string) {
  return store.history(store.product.branch(chatId,branchId).headRevision).map(s=>({id:s.revision,hash:store.source(s.revision).hash}));
}
function setHead(store: Store, scope: BehaviorScope, status: string, error: string | null, draws:Record<string,RuntimeValue> = {}) {
  store.db.prepare('INSERT INTO package_behavior_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id,branch_id,instance_id) DO UPDATE SET dependencies=excluded.dependencies,status=excluded.status,error=excluded.error,draws=excluded.draws').run(scope.chatId,scope.branchId,scope.attachmentInstanceId,JSON.stringify(dependencies(store,scope.chatId,scope.branchId)),status,error,JSON.stringify(draws));
}
function status(store: Store, scope: BehaviorScope): {status:'ready'|'stale';error:string|null} {
  const row=store.db.prepare('SELECT * FROM package_behavior_heads WHERE chat_id=? AND branch_id=? AND instance_id=?').get(scope.chatId,scope.branchId,scope.attachmentInstanceId) as Row|undefined;
  if (!row) return {status:'ready',error:null};
  if (row.status !== 'ready') return {status:'stale',error:row.error ?? 'BEHAVIOR_STATE_STALE'};
  for (const dep of JSON.parse(row.dependencies) as {id:string;hash:string}[]) if (store.source(dep.id).hash!==dep.hash) return {status:'stale',error:'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED'};
  return {status:'ready',error:null};
}
function frozenState(store: Store, d: Definition, state: BehaviorState): PackageExecutionState {
  const journal=store.behavior.journal(d.scope); const lastDraw=[...journal].reverse().find(r=>r.provenance==='explicit-reset'||Object.keys(r.draws).length);
  const head=store.db.prepare('SELECT draws FROM package_behavior_heads WHERE chat_id=? AND branch_id=? AND instance_id=?').get(d.scope.chatId,d.scope.branchId,d.scope.attachmentInstanceId) as Row|undefined;
  return {instanceId:d.scope.attachmentInstanceId,packageId:d.ref.id,packageRevision:d.ref.revision,role:d.ref.role,behaviorRevision:d.scope.behaviorRevision,schemaVersion:d.scope.schemaVersion,stateRevision:state.stateRevision,state:state.state,draws:lastDraw?.draws??(head?JSON.parse(head.draws):{})};
}
/** GET and previews are projections. They never initialize rows, roll dice, or repair state. */
export function behaviorDetail(store: Store, chatId: string, requestedBranch?: string) {
  store.chat(chatId); const branch=store.product.branch(chatId,requestedBranch);
  const pending=!!store.db.prepare("SELECT 1 FROM runs WHERE branch_id=? AND status IN ('queued','running','waiting_for_state')").get(branch.id);
  return {sourceHash:branch.headRevision?store.source(branch.headRevision).hash:null,instances:definitions(store,chatId,branch.id).map(d=>{
    let state: BehaviorState; let availability:{status:'ready'|'stale';error:string|null};
    try {state=store.behavior.read(d.scope,d.pkg.behavior!);availability=status(store,d.scope);} catch(error) {state={...d.scope,stateRevision:0,state:d.pkg.behavior!.initialState};availability={status:'stale',error:error instanceof Error?error.message:String(error)};}
    const last=store.db.prepare("SELECT payload,result FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND json_type(result,'$.actionResult') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(chatId,branch.id,d.scope.attachmentInstanceId) as Row|undefined;
    const receipt=last?JSON.parse(last.result):undefined;
    const lastAction=last?{actionId:JSON.parse(last.payload).actionId as string,result:receipt.actionResult as RuntimeValue,stateRevision:receipt.stateRevision as number,trigger:(receipt.provenance==='ui-action'?'user':receipt.provenance==='before-turn'?'before-turn':'model') as 'user'|'before-turn'|'model'}:undefined;
    return {instanceId:d.scope.attachmentInstanceId,packageId:d.ref.id,packageRevision:d.ref.revision,role:d.ref.role,title:d.pkg.title,behavior:d.pkg.behavior!,stateRevision:state.stateRevision,state:state.state,status:pending?'pending' as const:availability.status,error:availability.error,...(lastAction?{lastAction}:{})};
  })};
}
export function freezePackageStates(store: Store, snapshot: RunSnapshot, initialize: boolean): RunSnapshot {
  const branchId=snapshot.branchId??`main:${snapshot.chatId}`;
  const states=definitions(store,snapshot.chatId,branchId,snapshot).map(d=>{
    const availability=status(store,d.scope);
    if (availability.status!=='ready' && d.pkg.behavior!.mode!=='annotation') throw new HttpError(409,availability.error!);
    const state=initialize?store.behavior.ensureInTransaction(d.scope,d.pkg.behavior!):store.behavior.read(d.scope,d.pkg.behavior!);
    return frozenState(store,d,state);
  });
  return states.length?{...snapshot,packageStates:states}:snapshot;
}
export function performBehaviorAction(store: Store, chatId: string, branchId: string | undefined, instanceId: string, command: any, reset=false) {
  return store.transaction(()=>{
    const branch=store.product.branch(chatId,branchId),d=definitions(store,chatId,branch.id).find(d=>d.scope.attachmentInstanceId===instanceId);
    if(!d)throw new HttpError(404,'PACKAGE_BEHAVIOR_NOT_ATTACHED');
    if(store.db.prepare("SELECT 1 FROM runs WHERE branch_id=? AND status IN ('queued','running','waiting_for_state')").get(branch.id))throw new HttpError(409,'BEHAVIOR_RUN_ACTIVE');
    const availability=status(store,d.scope);if(!reset&&availability.status!=='ready')throw new HttpError(409,availability.error!);
    const beforeRevision=store.behavior.read(d.scope,d.pkg.behavior!).stateRevision;
    if(reset)store.behavior.resetInTransaction(d.scope,d.pkg.behavior!,command);
    else {
      const chat=store.chat(chatId),profile=store.product.snapshot(chatId),iso=new Date().toISOString();
      let view:RunSnapshot={chatId,parentRevision:branch.headRevision,branchId:branch.id,settingsRevision:chat.settingsRevision,settings:chat.settings,request:'',history:store.history(branch.headRevision),resources:store.product.resources(chatId,profile),profile,executionClock:{iso,unix:Math.floor(Date.parse(iso)/1000)}};
      view.hiddenStory=new HiddenStoryStore(store.product).freeze(profile?.hiddenStory,{seed:`action:${command.idempotencyKey}`,userLabel:profile?.contents.find(c=>c.kind==='persona')?.title??'User'});
      view.logicalHistory=captureLogicalHistory(store,view);view=freezePackageStates(store,view,false);
      store.behavior.executeInTransaction(d.scope,d.pkg.behavior!,command,executionContext(view,'main',d.ref));
    }
    const afterState=store.behavior.read(d.scope,d.pkg.behavior!);
    if(afterState.stateRevision!==beforeRevision){setHead(store,d.scope,'ready',null,frozenState(store,d,afterState).draws);store.event(chatId,reset?'package.state.reset':'package.action',instanceId);}
    return behaviorDetail(store,chatId,branch.id);
  });
}
/** Actions and authoritative outputs share one transaction boundary across packages.
 * Annotation parsing is a separate overlay; its failure preserves already validated action facts. */
export function completePackageOutputs(store: Store, run: Run, source: Source) {
  const branchId=run.snapshot.branchId??`main:${run.chatId}`;
  const defs=definitions(store,run.chatId,branchId,run.snapshot).map(d=>({d,before:(run.snapshot.behaviorExecution?.baseStates??run.snapshot.packageStates)?.find(s=>s.instanceId===d.scope.attachmentInstanceId)})).filter((item):item is {d:Definition;before:PackageExecutionState}=>!!item.before);
  if(!defs.length)return;
  const projected=completedRunBehaviorView(store,run);
  const parse=(d:Definition,before:PackageExecutionState)=>{
    const expected=projected.packageStates?.find(s=>s.instanceId===d.scope.attachmentInstanceId)?.stateRevision??before.stateRevision;
    if(d.pkg.behavior!.outputParsers.length)store.behavior.applyOutputsInTransaction(d.scope,d.pkg.behavior!,{parserIds:d.pkg.behavior!.outputParsers.map(p=>p.id),text:source.text,baseStateRevision:expected,sourceHash:source.hash,idempotencyKey:`source:${source.id}:${source.hash}`},executionContext(projected,'main',d.ref));
  };
  let groupFailure:string|null=null;
  store.db.exec('SAVEPOINT package_outputs');
  try {
    if(run.snapshot.history.some(item=>store.source(item.revision).hash!==(item.contentHash??store.sourceOriginal(item.revision).hash)))throw new HttpError(409,'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED');
    for(const {d} of defs)commitRunBehaviorInstance(store,run,d.scope.attachmentInstanceId,source.hash);
    for(const {d,before} of defs)if(d.pkg.behavior!.mode!=='annotation')parse(d,before);
    store.db.exec('RELEASE package_outputs');
  } catch(error) {store.db.exec('ROLLBACK TO package_outputs; RELEASE package_outputs');groupFailure=error instanceof Error?error.message:String(error);}
  for(const {d,before} of defs){
    let failure=groupFailure;
    if(!groupFailure&&d.pkg.behavior!.mode==='annotation'){
      store.db.exec('SAVEPOINT package_annotation');
      try {parse(d,before);store.db.exec('RELEASE package_annotation');}
      catch(error){store.db.exec('ROLLBACK TO package_annotation; RELEASE package_annotation');failure=error instanceof Error?error.message:String(error);}
    }
    const after=groupFailure?structuredClone(before):frozenState(store,d,store.behavior.read(d.scope,d.pkg.behavior!));
    store.db.prepare('INSERT INTO package_behavior_outputs VALUES(?,?,?)').run(source.id,d.scope.attachmentInstanceId,JSON.stringify({before,after,status:failure?'failed':'ready',error:failure,sourceHash:source.hash}));
    setHead(store,d.scope,failure?'failed':'ready',failure,after.draws);
    store.event(run.chatId,failure?'package.output.failed':'package.output.completed',source.id);
  }
}

/** Copy source-bound projections into a new chat. The selected boundary supplies its current state. */
export function copyPackageFork(store: Store, chatId: string, branchId: string, sourceIds: Map<string,string>, selectedSourceId: string) {
  for(const [oldId,newId] of sourceIds){
    for(const row of store.db.prepare('SELECT instance_id,body FROM package_behavior_outputs WHERE source_id=?').all(oldId) as Row[])store.db.prepare('INSERT INTO package_behavior_outputs VALUES(?,?,?)').run(newId,row.instance_id,row.body);
  }
  copyForkRunBehaviors(store,chatId,branchId,sourceIds);
  branchPackageStates(store,chatId,branchId,selectedSourceId);
}
/** Restore the state at a source boundary, including its failure status, without applying current-branch actions. */
export function branchPackageStates(store: Store, chatId: string, branchId: string, sourceId: string | null, candidate?: RunSnapshot) {
  const defs=definitions(store,chatId,branchId,candidate);
  for(const d of defs) {
    store.behavior.ensureInTransaction(d.scope,d.pkg.behavior!);
    let saved=(candidate?.behaviorExecution?.baseStates??candidate?.packageStates)?.find(s=>s.instanceId===d.scope.attachmentInstanceId);let failure:string|null=null;
    if(!saved&&sourceId){const row=store.db.prepare('SELECT body FROM package_behavior_outputs WHERE source_id=? AND instance_id=?').get(sourceId,d.scope.attachmentInstanceId) as Row|undefined;if(row){const result=JSON.parse(row.body);saved=result.after;failure=result.error;if(store.source(sourceId).hash!==result.sourceHash)failure='BEHAVIOR_SOURCE_DEPENDENCY_CHANGED';}}
    const basis=candidate??(sourceId?store.run(store.source(sourceId).runId).snapshot:undefined);
    if(saved&&basis?.history.some(item=>store.source(item.revision).hash!==(item.contentHash??store.sourceOriginal(item.revision).hash)))failure='BEHAVIOR_SOURCE_DEPENDENCY_CHANGED';
    if(saved){
      if(saved.packageRevision!==d.ref.revision||saved.behaviorRevision!==d.scope.behaviorRevision||saved.schemaVersion!==d.scope.schemaVersion)throw new HttpError(409,'BEHAVIOR_MIGRATION_REQUIRED');
      store.behavior.ensureInTransaction(d.scope,d.pkg.behavior!);
      store.db.prepare('UPDATE package_behavior_states SET state_revision=?,state=? WHERE chat_id=? AND branch_id=? AND instance_id=?').run(saved.stateRevision,JSON.stringify(saved.state),chatId,branchId,d.scope.attachmentInstanceId);
    }
    setHead(store,d.scope,failure?'failed':'ready',failure,saved?.draws??{});
  }
}
