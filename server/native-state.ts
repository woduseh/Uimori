import type { Store } from './store.js';
import { nativeStateModule, validateNativeBotState, type NativeBotPackage, type NativeBotState } from '../core/native-bot.js';
import { validateStateModule } from '../core/state.js';
import type { StoryConfig } from '../core/story.js';

/** Called only inside the caller's short write transaction; never opens a nested transaction. */
export function saveNativeStateConfigInTransaction(store:Store,chatId:string,branchId:string,pkg:NativeBotPackage,input:NativeBotState,previousRevision?:number):number {
  const state=validateNativeBotState(pkg,input); const branch=store.product.branch(chatId,branchId);
  const old=previousRevision===undefined?store.story.configForBranch(chatId,branchId):store.story.config(chatId,previousRevision);
  const revision=Number((store.db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM story_configs WHERE chat_id=?').get(chatId) as {revision:number}).revision)+1;
  const source=branch.headRevision?store.source(branch.headRevision):null;
  const fields=structuredClone(pkg.stateModule.fields);
  for(const axis of ['affection','trust','independence'] as const) {const field=fields[axis];if(field?.type!=='number')throw new Error('NATIVE_MODULE');fields[axis]={...field,initial:state[axis]};}
  const module=validateStateModule({...pkg.stateModule,revision,fields,rules:nativeStateModule(state.volume).rules});
  const result:StoryConfig={...old,revision,module,activatedAt:source?{revision:source.id,hash:source.hash}:null};
  store.db.prepare('INSERT INTO story_configs VALUES(?,?,?)').run(chatId,revision,JSON.stringify(result));
  store.db.prepare('INSERT INTO native_state_config_owners VALUES(?,?,?)').run(chatId,revision,branchId);
  const at=new Date().toISOString();
  const jobs=store.db.prepare("SELECT id FROM story_jobs WHERE chat_id=? AND kind='state' AND status IN ('queued','running') AND COALESCE(json_extract(snapshot,'$.branchId'),'main:'||chat_id)=?").all(chatId,branchId) as {id:string}[];
  for(const job of jobs) {store.db.prepare("UPDATE story_jobs SET status='cancelled',generation=generation+1,owner=NULL,error='이 분기의 Native 상태 설정이 변경됐어요.',updated_at=? WHERE id=?").run(at,job.id);store.event(chatId,'story.job.cancelled',job.id);}
  const runs=store.db.prepare("SELECT id FROM runs WHERE chat_id=? AND status='waiting_for_state' AND COALESCE(json_extract(snapshot,'$.branchId'),'main:'||chat_id)=?").all(chatId,branchId) as {id:string}[];
  for(const run of runs) {store.db.prepare("UPDATE runs SET status='cancelled',error='이 분기의 Native 상태 설정이 변경됐어요. 새 설정으로 다시 요청해 주세요.',updated_at=? WHERE id=?").run(at,run.id);store.story.finishCommandInTransaction(run.id,'cancelled');store.event(chatId,'run.cancelled',run.id);}
  store.event(chatId,'story.config.updated',chatId); return revision;
}
