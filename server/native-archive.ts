import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateNativeBotPackage, validateNativeBotState, type NativeBotSnapshot } from '../core/native-bot.js';
import { freezeHiddenStory, validateHiddenConversion } from '../core/hidden-story-package.js';
import { validateProviderPrompt } from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import { HttpError, type Store } from './store.js';
import { fields, number, record, text } from './product-store.js';
import { validateContextPlan } from './context-planning.js';

type Row=Record<string,any>;
const reject=(message:string):never=>{throw new HttpError(400,`Invalid native archive: ${message}`);};
export function validateNativeVersion(row:Row):void{
  const body=record(JSON.parse(row.body));
  if(row.kind==='native-bot')validateNativeBotPackage(body);
  else if(row.kind==='hidden-story'){
    fields(body,['format','status','source','program','nonsexualProgram','controlMap','picks','requiredSlots','loreMapping','issues','id','revision','title','packageHash']);
    const conversion=validateHiddenConversion(body);
    if(createHash('sha256').update(JSON.stringify(conversion)).digest('hex')!==body.packageHash)reject('module hash mismatch');
  }else reject('version kind');
  if(body.id!==row.id||body.revision!==row.revision)reject('package identity');
  text(body.title,'package title',200);number(body.revision,'package revision');
}
function nativeSnapshot(store:Store,value:unknown,chatId:string,branchId?:string):NativeBotSnapshot{
  const b=record(value);fields(b,['package','revision','state','pending','branchId','sourceRevision','sourceHash','stateConfigRevision']);
  const p=validateNativeBotPackage(b.package);if(!isDeepStrictEqual(p,store.native.get(p.id,p.revision)))reject('package revision mismatch');
  number(b.revision,'native revision');validateNativeBotState(p,b.state);
  const branch=store.product.branch(chatId,text(b.branchId,'native branch',100));if(branchId&&branch.id!==branchId)reject('branch mismatch');
  if(b.sourceRevision!==null){const source=store.sourceAtHash(text(b.sourceRevision,'native source',100),text(b.sourceHash,'native hash',64));if(source.chatId!==chatId)reject('source scope');}
  else if(b.sourceHash!==null)reject('empty source hash');
  if(b.pending!==null){const pending=record(b.pending);fields(pending,['commandId','request','label']);text(pending.commandId,'native command',120);text(pending.request,'native request',10000);text(pending.label,'native label',1000);}
  if(b.stateConfigRevision!==undefined)store.story.config(chatId,number(b.stateConfigRevision,'native config revision'));
  return b as NativeBotSnapshot;
}
export function validateNativeRunSnapshot(store:Store,snapshot:RunSnapshot):void{
  validateContextPlan(snapshot);
  if(snapshot.nativeBot)nativeSnapshot(store,snapshot.nativeBot,snapshot.chatId,snapshot.branchId);
  if(snapshot.hiddenStory){
    const hidden=snapshot.hiddenStory;const pkg=store.product.get('hidden-story',hidden.module.id,hidden.module.revision);
    if(!isDeepStrictEqual(pkg,hidden.module))reject('frozen hidden module mismatch');
    const expected=freezeHiddenStory(hidden.module,{module:hidden.module,config:hidden.config,insertion:hidden.insertion},{seed:hidden.seed,userLabel:snapshot.profile?.contents.find(c=>c.kind==='persona')?.title??'User'});
    if(!isDeepStrictEqual(expected,hidden))reject('frozen hidden instructions mismatch');
  }
  if(snapshot.logicalHistory!==undefined&&!isDeepStrictEqual(snapshot.logicalHistory,captureLogicalHistory(store,snapshot)))reject('logical history mismatch');
  if(snapshot.promptCompilation){
    const p=snapshot.promptCompilation;validateProviderPrompt({compilerVersion:p.compilerVersion,messages:p.messages,cachePlan:p.cachePlan,values:p.values});
    const expected=compileSnapshotPrompt({...snapshot,promptCompilation:undefined});
    if(!isDeepStrictEqual(expected.promptCompilation,p))reject('compiled prompt mismatch');
  }else if(!snapshot.story?.waiting&&!['pending','failed'].includes(snapshot.contextPlan?.status??''))reject('compiled prompt missing');
}
export function validateNativeArchive(store:Store):void{
  for(const row of store.db.prepare('SELECT * FROM native_chat_settings').all() as Row[]){const value=nativeSnapshot(store,JSON.parse(row.body),row.chat_id,row.branch_id);if(value.revision!==row.revision)reject('settings revision');}
  for(const row of store.db.prepare('SELECT * FROM native_actions').all() as Row[]){text(row.id,'native action ID',120);text(row.request_key,'native action key',120);if(!/^[a-f0-9]{64}$/u.test(row.input_hash))reject('action hash');nativeSnapshot(store,JSON.parse(row.result),row.chat_id,row.branch_id);}
  for(const row of store.db.prepare('SELECT * FROM native_state_config_owners').all() as Row[]){store.product.branch(row.chat_id,row.branch_id);store.story.config(row.chat_id,number(row.config_revision,'native config owner'));}
}

/** Remap identities only. Original text, role order, random choices and provenance hashes stay fixed. */
export function mapNativeForkSnapshot(snapshot:RunSnapshot,newChatId:string,branchId:string,sources:Map<string,string>,runs:Map<string,string>):void{
  const source=(id:string|undefined)=>id?sources.get(id)??reject('fork source dependency'):undefined;
  const run=(id:string|undefined)=>id?runs.get(id)??reject('fork run dependency'):undefined;
  if(snapshot.logicalHistory)snapshot.logicalHistory=snapshot.logicalHistory.map(item=>({...item,id:item.sourceRevision?`${item.role==='user'?'request':'source'}:${source(item.sourceRevision)}`:item.id,...(item.sourceRevision?{sourceRevision:source(item.sourceRevision)}:{}),...(item.runId?{runId:run(item.runId)}:{})}));
  if(snapshot.contextPlan){snapshot.contextPlan.compacted=snapshot.contextPlan.compacted.map(ref=>({...ref,revision:source(ref.revision)!}));snapshot.contextPlan.recentSourceRevisions=snapshot.contextPlan.recentSourceRevisions.map(id=>source(id)!);}
  if(snapshot.nativeBot)snapshot.nativeBot={...snapshot.nativeBot,branchId,sourceRevision:source(snapshot.nativeBot.sourceRevision??undefined)??null,pending:null};
  if(snapshot.promptCompilation){
    const ids=new Map<string,string>();
    for(const message of snapshot.promptCompilation.messages){if(message.provenance.origin==='history'&&message.provenance.sourceRevision){const p=message.provenance;const mapped=source(p.sourceRevision);const id=`${p.blockId}:${message.role==='user'?'request':'source'}:${mapped}`;ids.set(message.id,id);message.id=id;p.sourceRevision=mapped;if(p.runId)p.runId=run(p.runId);}}
    for(const anchor of snapshot.promptCompilation.cachePlan)anchor.afterMessageId=ids.get(anchor.afterMessageId)??anchor.afterMessageId;
    for(const trace of snapshot.promptCompilation.trace)trace.messageIds=trace.messageIds.map(id=>ids.get(id)??id);
  }
}

export function copyNativeFork(store:Store,oldChatId:string,newChatId:string,fromRevision:string,sources:Map<string,string>):void{
  const selected=store.run(store.source(fromRevision).runId).snapshot.nativeBot;
  if(!selected)return;
  const branchId=`main:${newChatId}`;
  // Keep all historical config owner markers, including overwritten native pointers.
  for(const row of store.db.prepare('SELECT * FROM native_state_config_owners WHERE chat_id=?').all(oldChatId) as Row[]){
    if(store.db.prepare('SELECT 1 FROM story_configs WHERE chat_id=? AND revision=?').get(newChatId,row.config_revision))store.db.prepare('INSERT INTO native_state_config_owners VALUES(?,?,?)').run(newChatId,row.config_revision,branchId);
  }
  const mappedSource=sources.get(fromRevision)!;const source=store.source(mappedSource);
  const copy:NativeBotSnapshot={...structuredClone(selected),revision:1,branchId,sourceRevision:mappedSource,sourceHash:source.hash,pending:null};
  if(copy.stateConfigRevision!==undefined&&!store.db.prepare('SELECT 1 FROM story_configs WHERE chat_id=? AND revision=?').get(newChatId,copy.stateConfigRevision))reject('fork native configuration unavailable');
  store.db.prepare('INSERT INTO native_chat_settings VALUES(?,?,?,?)').run(newChatId,branchId,copy.revision,JSON.stringify(copy));
}
