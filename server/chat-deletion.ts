import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { fields, number, record, text } from './product-store.js';
import { HttpError, type Store } from './store.js';

type Row = Record<string, any>;
const chatTables = ['resources','profiles','assets','events','chat_organization','story_configs','story_jobs','story_states','story_memories','story_indexes','scene_commands','native_chat_settings','native_actions','native_state_config_owners','package_behavior_states','package_behavior_journal','package_behavior_heads','package_behavior_opportunities','attempts','jobs','sources','runs','branches'];
const references = (value: unknown, ids: Set<string>): boolean => typeof value === 'string' ? ids.has(value) : Array.isArray(value) ? value.some(item=>references(item,ids)) : !!value && typeof value==='object' && Object.values(value).some(item=>references(item,ids));

/** Capture a reviewed selection. Branch revisions also change when new story text commits. */
export function chatDeletionImpact(store: Store, chatId: string) {
  const chat=store.chat(chatId);
  const expectedEventSequence=Number((store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE chat_id=?').get(chatId) as Row).seq);
  return {request:{expectedSettingsRevision:chat.settingsRevision,expectedOrganizationRevision:chat.organizationRevision??1,expectedProfileRevision:store.product.profile(chatId).revision,expectedEventSequence,expectedBranches:store.product.branches(chatId).map(branch=>({id:branch.id,revision:branch.revision}))},description:'채팅의 모든 분기, 원문, 번역, 상태·기억, 이미지와 실행 기록을 영구 삭제해요. 별도로 포크한 채팅과 공통 자료는 유지돼요.'};
}

function assertIdle(store: Store, chatId: string) {
  for(const table of ['runs','jobs','story_jobs'])if(store.db.prepare(`SELECT 1 FROM ${table} WHERE chat_id=? AND status IN ('queued','running','waiting_for_state') LIMIT 1`).get(chatId))throw new HttpError(409,'진행 중인 생성 또는 보조 작업을 취소하거나 완료한 뒤 삭제해 주세요.');
  if(store.db.prepare("SELECT 1 FROM attempts WHERE chat_id=? AND status='running' LIMIT 1").get(chatId))throw new HttpError(409,'공급자 요청이 아직 종료되지 않았어요. 요청 종료 후 삭제해 주세요.');
}

function removeIds(store: Store, table: string, column: string, ids: string[]) {
  const statement=store.db.prepare(`DELETE FROM ${table} WHERE ${column}=?`);
  for(const id of ids)statement.run(id);
}

function removeRunArtifacts(store: Store, runIds: string[], sourceIds: string[], jobIds: string[]) {
  for(const table of ['model_inputs','tool_events','package_behavior_runs'])removeIds(store,table,'run_id',runIds);
  for(const table of ['source_edits','package_behavior_outputs'])removeIds(store,table,'source_id',sourceIds);
  for(const table of ['job_chunks','job_results'])removeIds(store,table,'job_id',jobIds);
}

export function deleteChat(store: Store, chatId: string, value: unknown) {
  const body=record(value);fields(body,['expectedSettingsRevision','expectedOrganizationRevision','expectedProfileRevision','expectedEventSequence','expectedBranches']);
  for(const key of ['expectedSettingsRevision','expectedOrganizationRevision','expectedProfileRevision'])number(body[key],key);
  number(body.expectedEventSequence,'event sequence',0,Number.MAX_SAFE_INTEGER);
  if(!Array.isArray(body.expectedBranches))throw new HttpError(400,'삭제할 분기 목록이 필요해요.');
  for(const value of body.expectedBranches){const item=record(value);fields(item,['id','revision']);text(item.id,'branch ID',100);number(item.revision,'branch revision');}
  return store.transaction(()=>{
    if(!isDeepStrictEqual(body,chatDeletionImpact(store,chatId).request))throw new HttpError(409,'채팅이 변경됐어요. 최신 내용을 확인한 뒤 다시 삭제해 주세요.');
    assertIdle(store,chatId);
    store.db.exec('PRAGMA defer_foreign_keys=ON');
    const ids=(table:string)=>(store.db.prepare(`SELECT id FROM ${table} WHERE chat_id=?`).all(chatId) as Row[]).map(row=>String(row.id));
    removeRunArtifacts(store,ids('runs'),ids('sources'),ids('jobs'));
    for(const table of chatTables)store.db.prepare(`DELETE FROM ${table} WHERE chat_id=?`).run(chatId);
    store.db.prepare('DELETE FROM chats WHERE id=?').run(chatId);
    return {deleted:true};
  });
}

/** Delete branch-owned history only when no surviving branch depends on it. */
export function deleteBranch(store: Store, chatId: string, branchId: string, value: unknown) {
  const body=record(value);fields(body,['expectedRevision']);const expected=number(body.expectedRevision,'branch revision');
  return store.transaction(()=>{
    const branch=store.product.branch(chatId,branchId);
    if(branch.revision!==expected)throw new HttpError(409,'분기가 변경됐어요. 최신 내용을 확인한 뒤 다시 삭제해 주세요.');
    if(branch.default)throw new HttpError(409,'기본 분기는 개별 삭제할 수 없어요. 채팅 삭제를 이용해 주세요.');
    assertIdle(store,chatId);
    const runIds=(store.db.prepare('SELECT id FROM runs WHERE chat_id=? AND branch_id=?').all(chatId,branchId) as Row[]).map(row=>String(row.id));
    const runSet=new Set(runIds);
    const sourceIds=(store.db.prepare('SELECT id,run_id FROM sources WHERE chat_id=?').all(chatId) as Row[]).filter(row=>runSet.has(row.run_id)).map(row=>String(row.id));
    const sourceSet=new Set(sourceIds), dependencies=new Set([branchId,...sourceIds,...runIds]);
    const conflict=()=>{throw new HttpError(409,'다른 분기가 이 분기의 원문 또는 상태를 참조하고 있어요. 참조하는 분기를 먼저 삭제해 주세요.');};
    const ownedConfigs=(store.db.prepare('SELECT config_revision FROM native_state_config_owners WHERE chat_id=? AND branch_id=?').all(chatId,branchId) as Row[]).map(row=>Number(row.config_revision));
    for(const row of store.db.prepare('SELECT revision,body FROM story_configs WHERE chat_id=?').all(chatId) as Row[])if(!ownedConfigs.includes(row.revision)&&references(JSON.parse(row.body),dependencies))conflict();
    for(const other of store.product.branches(chatId))if(other.id!==branchId&&other.headRevision&&sourceSet.has(other.headRevision))conflict();
    for(const row of store.db.prepare('SELECT * FROM runs WHERE chat_id=?').all(chatId) as Row[])if(!runSet.has(row.id)&&(sourceSet.has(row.parent_revision)||references(JSON.parse(row.snapshot),dependencies)||ownedConfigs.includes(JSON.parse(row.snapshot).story?.config?.revision)))conflict();
    for(const row of store.db.prepare('SELECT * FROM sources WHERE chat_id=?').all(chatId) as Row[])if(!sourceSet.has(row.id)&&sourceSet.has(row.parent_revision))conflict();
    for(const table of ['native_chat_settings','native_actions','package_behavior_heads','package_behavior_opportunities'])for(const row of store.db.prepare(`SELECT * FROM ${table} WHERE chat_id=? AND branch_id<>?`).all(chatId,branchId) as Row[])for(const column of ['body','result','dependencies'])if(row[column]&&(references(JSON.parse(row[column]),dependencies)||ownedConfigs.includes(JSON.parse(row[column]).stateConfigRevision)))conflict();
    const storyJobs=store.db.prepare('SELECT * FROM story_jobs WHERE chat_id=?').all(chatId) as Row[];
    for(const row of storyJobs)if(!sourceSet.has(row.source_revision)&&(references(JSON.parse(row.snapshot),dependencies)||ownedConfigs.includes(row.config_revision)))conflict();
    const storyJobIds=storyJobs.filter(row=>sourceSet.has(row.source_revision)).map(row=>String(row.id));
    const storyJobSet=new Set(storyJobIds);
    const memories=store.db.prepare('SELECT * FROM story_memories WHERE chat_id=?').all(chatId) as Row[];
    const memoryIds=memories.filter(row=>storyJobSet.has(row.job_id)||references(JSON.parse(row.entry),dependencies)).map(row=>String(row.id));
    if(memories.some(row=>!memoryIds.includes(row.id)&&memoryIds.includes(row.replaces_id)))conflict();
    const states=store.db.prepare('SELECT * FROM story_states WHERE chat_id=?').all(chatId) as Row[];
    const stateIds=states.filter(row=>storyJobSet.has(row.job_id)).map(row=>String(row.id));
    for(const id of [...storyJobIds,...memoryIds,...stateIds])dependencies.add(id);
    for(const row of store.db.prepare('SELECT * FROM runs WHERE chat_id=?').all(chatId) as Row[])if(!runSet.has(row.id)&&references(JSON.parse(row.snapshot),dependencies))conflict();
    for(const row of storyJobs)if(!storyJobSet.has(row.id))for(const key of ['snapshot','inputs','result','tool_events'])if(row[key]&&references(JSON.parse(row[key]),dependencies))conflict();
    for(const row of states)if(!stateIds.includes(row.id)&&(dependencies.has(row.parent_state_id)||references(JSON.parse(row.body),dependencies)))conflict();
    for(const row of memories)if(!memoryIds.includes(row.id)&&references(JSON.parse(row.entry),dependencies))conflict();
    const jobIds=(store.db.prepare('SELECT id,source_revision FROM jobs WHERE chat_id=?').all(chatId) as Row[]).filter(row=>sourceSet.has(row.source_revision)).map(row=>String(row.id));
    store.db.exec('PRAGMA defer_foreign_keys=ON');
    removeRunArtifacts(store,runIds,sourceIds,jobIds);
    removeIds(store,'story_memories','id',memoryIds);
    for(const table of ['story_states','story_indexes'])removeIds(store,table,'job_id',storyJobIds);
    removeIds(store,'attempts','story_job_id',storyJobIds);removeIds(store,'story_jobs','id',storyJobIds);
    removeIds(store,'attempts','job_id',jobIds);removeIds(store,'attempts','run_id',runIds);
    removeIds(store,'jobs','id',jobIds);
    for(const table of ['scene_commands','native_chat_settings','native_actions','native_state_config_owners','package_behavior_states','package_behavior_journal','package_behavior_heads','package_behavior_opportunities'])store.db.prepare(`DELETE FROM ${table} WHERE chat_id=? AND branch_id=?`).run(chatId,branchId);
    for(const revision of ownedConfigs)store.db.prepare('DELETE FROM story_configs WHERE chat_id=? AND revision=?').run(chatId,revision);
    removeIds(store,'sources','id',sourceIds);removeIds(store,'runs','id',runIds);
    store.db.prepare('DELETE FROM branches WHERE id=? AND chat_id=?').run(branchId,chatId);
    store.event(chatId,'branch.deleted',branchId);
    return {deleted:true};
  });
}

function assertUnreferencedStoryEntry(store:Store,chatId:string,id:string) {
  const ids=new Set([id]);
  for(const table of ['runs','story_jobs'])for(const row of store.db.prepare(`SELECT snapshot FROM ${table} WHERE chat_id=?`).all(chatId) as Row[])if(references(JSON.parse(row.snapshot),ids))throw new HttpError(409,'저장된 실행 기록에서 사용하는 항목이에요. 해당 분기 또는 채팅과 함께 삭제해 주세요.');
}

export function deleteMemory(store:Store,chatId:string,memoryId:string,value:unknown) {
  fields(record(value),[]);
  return store.transaction(()=>{
    store.chat(chatId);const row=store.db.prepare('SELECT * FROM story_memories WHERE chat_id=? AND id=?').get(chatId,memoryId) as Row|undefined;
    if(!row)throw new HttpError(404,'기억 항목을 찾을 수 없어요.');assertIdle(store,chatId);
    if(row.job_id!==null)throw new HttpError(409,'자동 추출된 기억은 원문·실행 결과와 함께 보존해요. 해당 분기 또는 채팅과 함께 삭제해 주세요.');
    if(row.replaces_id!==null||row.retired_at!==null||store.db.prepare('SELECT 1 FROM story_memories WHERE replaces_id=?').get(memoryId))throw new HttpError(409,'정사 수정 이력에 연결된 항목이에요. 해당 분기 또는 채팅과 함께 삭제해 주세요.');
    assertUnreferencedStoryEntry(store,chatId,memoryId);
    store.db.prepare('DELETE FROM story_memories WHERE id=? AND chat_id=?').run(memoryId,chatId);
    store.story.memory.refreshValidityInTransaction(chatId);store.event(chatId,'story.memory.deleted',memoryId);return {deleted:true};
  });
}

export function deleteSceneCommand(store:Store,id:string,value:unknown) {
  fields(record(value),[]);
  return store.transaction(()=>{
    const command=store.story.command(id);assertIdle(store,command.chatId);
    if(command.runId||command.sourceRevision)throw new HttpError(409,'실행 기록에 연결된 새 장면 요청이에요. 해당 분기 또는 채팅과 함께 삭제해 주세요.');
    assertUnreferencedStoryEntry(store,command.chatId,id);
    store.db.prepare('DELETE FROM scene_commands WHERE id=?').run(id);store.event(command.chatId,'scene.command.deleted',id);return {deleted:true,chatId:command.chatId};
  });
}

export function chatDeletionRoutes(app: FastifyInstance, store: Store, publish: (chatId:string)=>void, onChatDeleted?: (chatId:string)=>void) {
  app.get<{Params:{id:string}}>('/api/chats/:id/deletion-impact',async request=>chatDeletionImpact(store,request.params.id));
  app.delete<{Params:{id:string}}>('/api/chats/:id',async request=>{const result=deleteChat(store,request.params.id,request.body);onChatDeleted?.(request.params.id);return result;});
  app.delete<{Params:{id:string;branchId:string}}>('/api/chats/:id/branches/:branchId',async request=>{const result=deleteBranch(store,request.params.id,request.params.branchId,request.body);publish(request.params.id);return result;});
  app.delete<{Params:{id:string;memoryId:string}}>('/api/chats/:id/story/memory/:memoryId',async request=>{const result=deleteMemory(store,request.params.id,request.params.memoryId,request.body??{});publish(request.params.id);return result;});
  app.delete<{Params:{id:string}}>('/api/scene-commands/:id',async request=>{const result=deleteSceneCommand(store,request.params.id,request.body??{});publish(result.chatId);return result;});
}
