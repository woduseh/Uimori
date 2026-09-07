import { createHash, randomUUID } from 'node:crypto';
import { compileSnapshotPrompt, captureLogicalHistory } from './prompt-snapshot.js';
import { freezeLoreContext } from './lore-context.js';
import { isDeepStrictEqual } from 'node:util';
import { HttpError, type Store, type Source, type Run } from './store.js';
import { fields, record, text, number } from './product-store.js';
import { initialState, reduceStateProposal, validateStateModule, type StateProposal } from '../core/state.js';
import { activationRebuildState, defaultStoryConfig, type StoryConfig, type StorySnapshot, type StoryState, type StoryJob, type StoryDetail, type SceneCommand } from '../core/story.js';
import type { RunSnapshot } from '../core/types.js';
import type { ModelPreset, Connection, ModelRef } from '../core/product.js';
import { StoryMemory } from './story-memory.js';
import { assertModelSelection } from './provider-selection.js';

type Row = Record<string, any>;
const parse = (value: any): any => value == null ? null : JSON.parse(String(value));
const json = JSON.stringify;
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
export const lineageHash = (history: RunSnapshot['history']) => digest(history.map(item => [item.revision, createHash('sha256').update(item.text).digest('hex')]));
export const storyDependencyKey = (kind:'state'|'memory',source:{id:string;hash:string},snapshot:RunSnapshot) => {
  const model = snapshot.story?.models[kind];
  return digest([kind,source.id,source.hash,lineageHash(snapshot.history),snapshot.story?.canonHash,kind==='state'?[snapshot.story?.config.module,snapshot.story?.state,snapshot.story?.config.stateModel]:snapshot.story?.config.memory.model,
    model ? [model.id,model.revision,model.connection.id,model.connection.revision] : null]);
};
export const storyTables = ['story_configs','story_jobs','story_states','story_memories','story_indexes','scene_commands'];

/** Durable state and memory are separate from the single-slot reading translation. */
export class StoryStore {
  readonly memory: StoryMemory;
  constructor(readonly store: Store) { this.memory = new StoryMemory(store); }
  get db() { return this.store.db; }
  /** Joins Store's single transaction for the current empty database baseline. */
  initFresh() {
    this.db.exec(`
      CREATE TABLE story_configs(chat_id TEXT NOT NULL REFERENCES chats(id),revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(chat_id,revision));
      CREATE TABLE story_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),source_revision TEXT NOT NULL REFERENCES sources(id),source_hash TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('state','memory')),config_revision INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,status TEXT NOT NULL,snapshot TEXT NOT NULL,result TEXT,error TEXT,mock INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,dependency_key TEXT NOT NULL UNIQUE,inputs TEXT NOT NULL DEFAULT '[]',tool_events TEXT NOT NULL DEFAULT '[]',FOREIGN KEY(chat_id,config_revision) REFERENCES story_configs(chat_id,revision));
      CREATE INDEX story_jobs_queue ON story_jobs(status,created_at);
      CREATE TABLE story_states(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES story_jobs(id),chat_id TEXT NOT NULL REFERENCES chats(id),source_revision TEXT NOT NULL REFERENCES sources(id),source_hash TEXT NOT NULL,module_revision INTEGER NOT NULL,parent_state_id TEXT,body TEXT NOT NULL);
      CREATE INDEX story_states_source ON story_states(chat_id,source_revision,module_revision);
      CREATE TABLE story_memories(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),job_id TEXT REFERENCES story_jobs(id),entry TEXT NOT NULL,retired_at TEXT,replaces_id TEXT REFERENCES story_memories(id));
      CREATE TABLE story_indexes(chat_id TEXT NOT NULL REFERENCES chats(id),source_revision TEXT NOT NULL REFERENCES sources(id),source_hash TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES story_jobs(id),PRIMARY KEY(chat_id,source_revision,source_hash));
      CREATE TABLE scene_commands(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,label TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT REFERENCES runs(id),source_revision TEXT REFERENCES sources(id),UNIQUE(chat_id,request_key));
    `);
  }
  config(chatId: string, revision?: number): StoryConfig {
    this.store.chat(chatId);
    const row = (revision === undefined ? this.db.prepare('SELECT body FROM story_configs WHERE chat_id=? ORDER BY revision DESC LIMIT 1').get(chatId) : this.db.prepare('SELECT body FROM story_configs WHERE chat_id=? AND revision=?').get(chatId,revision)) as Row | undefined;
    if (!row && revision) throw new HttpError(400,'Story configuration revision missing');
    return row ? parse(row.body) : defaultStoryConfig();
  }
  private nativeSettings(chatId:string,branchId:string): Row|null {
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_chat_settings'").get())return null;
    const row=this.db.prepare('SELECT body FROM native_chat_settings WHERE chat_id=? AND branch_id=?').get(chatId,branchId) as Row|undefined;
    return row?parse(row.body):null;
  }
  configForBranch(chatId:string,branchId?:string):StoryConfig {
    const branch=this.store.product.branch(chatId,branchId);const native=this.nativeSettings(chatId,branch.id);
    if(native?.stateConfigRevision!==undefined)return this.config(chatId,native.stateConfigRevision);
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_state_config_owners'").get())return this.config(chatId);
    const row=this.db.prepare('SELECT c.body FROM story_configs c WHERE c.chat_id=? AND NOT EXISTS(SELECT 1 FROM native_state_config_owners o WHERE o.chat_id=c.chat_id AND o.config_revision=c.revision) ORDER BY c.revision DESC LIMIT 1').get(chatId) as Row|undefined;
    return row?parse(row.body):defaultStoryConfig();
  }
  private model(value: unknown): ModelRef | null {
    if (value === null) return null;
    const body = record(value); fields(body,['id']);
    const ref = {id:text(body.id,'model',100)};
    this.store.product.get<ModelPreset>('model',ref.id); return ref;
  }
  saveConfig(chatId: string, value: unknown): StoryConfig {
    const body = record(value); fields(body,['expectedRevision','module','stateModel','memory','branchId','resetState']);
    if (body.resetState !== undefined && typeof body.resetState !== 'boolean') throw new HttpError(400,'Invalid state reset');
    const memory = record(body.memory); fields(memory,['enabled','model','recentCount','maxPacketChars']);
    if (typeof memory.enabled !== 'boolean') throw new HttpError(400,'Invalid memory setting');
    const stateModel = this.model(body.stateModel); const memoryModel = this.model(memory.model);
    return this.store.transaction(() => {
      const branch = this.store.product.branch(chatId,body.branchId===undefined?undefined:text(body.branchId,'branch',100));
      const native=this.nativeSettings(chatId,branch.id);
      const old = this.configForBranch(chatId,branch.id); if (old.revision !== number(body.expectedRevision,'story revision',0)) throw new HttpError(409,'Story settings revision conflict');
      assertModelSelection(this.store.product,stateModel,old.stateModel); assertModelSelection(this.store.product,memoryModel,old.memory.model);
      let module: StoryConfig['module'] = null;
      if (body.module !== null) { try { module = validateStateModule({...record(body.module),revision:old.module?.revision ?? 1}); } catch { throw new HttpError(400,'Invalid state module'); } }
      const changed = body.resetState === true || !isDeepStrictEqual(module && {...module,revision:0},old.module && {...old.module,revision:0});
      const revision = Number((this.db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM story_configs WHERE chat_id=?').get(chatId) as Row).revision)+1;
      if (module && changed) module.revision = revision;
      const head = branch.headRevision ? this.store.source(branch.headRevision) : null;
      const result: StoryConfig = {revision,module,stateModel,memory:{enabled:memory.enabled,model:memoryModel,recentCount:number(memory.recentCount,'recent source count',1,100),maxPacketChars:number(memory.maxPacketChars,'memory packet limit',1000,2_000_000)},activatedAt:changed ? head ? {revision:head.id,hash:head.hash} : null : old.activatedAt};
      this.db.prepare('INSERT INTO story_configs VALUES(?,?,?)').run(chatId,revision,json(result));
      if(native) {
        this.db.prepare('INSERT INTO native_state_config_owners VALUES(?,?,?)').run(chatId,revision,branch.id);
        const updated={...native,revision:native.revision+1,stateConfigRevision:revision};
        this.db.prepare('UPDATE native_chat_settings SET revision=?,body=? WHERE chat_id=? AND branch_id=?').run(updated.revision,json(updated),chatId,branch.id);
      }
      const inScope=(snapshot:string)=>{const target=parse(snapshot).branchId??`main:${chatId}`;return native?target===branch.id:!this.nativeSettings(chatId,target)?.stateConfigRevision;};
      for(const row of this.db.prepare("SELECT id,kind,snapshot FROM story_jobs WHERE chat_id=? AND status IN ('queued','running')").all(chatId) as Row[]) {
        if(!inScope(row.snapshot))continue;
        if(row.kind==='state'?changed:!result.memory.enabled){this.db.prepare("UPDATE story_jobs SET status='cancelled',generation=generation+1,owner=NULL,error='보조 설정이 변경되어 작업을 중단했어요.',updated_at=? WHERE id=?").run(now(),row.id);this.store.event(chatId,'story.job.cancelled',row.id);}
      }
      // Already running requests keep their immutable settings. Waiting requests need a new explicit request after a rules change.
      if (changed) {
        const waiting = (this.db.prepare("SELECT id,snapshot FROM runs WHERE chat_id=? AND status='waiting_for_state'").all(chatId) as Row[]).filter(row=>inScope(row.snapshot));
        for (const row of waiting) { this.db.prepare("UPDATE runs SET status='cancelled',error='상태 모듈이 변경됐어요. 새 설정으로 다시 요청해 주세요.',updated_at=? WHERE id=?").run(now(),row.id); this.finishCommandInTransaction(row.id,'cancelled'); this.store.event(chatId,'run.cancelled',row.id); }
      }
      this.store.event(chatId,'story.config.updated',chatId); return result;
    });
  }
  private models(config: StoryConfig): StorySnapshot['models'] {
    const result: StorySnapshot['models'] = {};
    for (const [kind,ref] of [['state',config.stateModel],['memory',config.memory.model]] as const) if (ref) {
      const model = this.store.product.get<ModelPreset>('model',ref.id);
      result[kind] = {...model,connection:this.store.product.get<Connection>('connection',model.connectionId)};
    }
    return result;
  }
  private initial(chatId: string, config: StoryConfig): StoryState | null {
    return config.module ? {id:`initial:${chatId}:${config.module.revision}`,sourceRevision:config.activatedAt?.revision ?? null,sourceHash:config.activatedAt?.hash ?? null,moduleRevision:config.module.revision,values:initialState(config.module),canonical:config.module.mode!=='annotation'} : null;
  }
  stateAt(chatId: string, head: string | null, config = this.configForBranch(chatId)): StoryState | null {
    if (!config.module) return null;
    if (head === null && config.activatedAt === null) return this.initial(chatId,config);
    if(head===null)return null;
    const source = head ? this.store.source(head) : null;
    if (source?.chatId !== chatId) throw new HttpError(400,'State source outside story');
    if (head === config.activatedAt?.revision && source?.hash === config.activatedAt.hash) return this.initial(chatId,config);
    const rows = this.db.prepare('SELECT s.body,s.job_id FROM story_states s JOIN story_jobs j ON j.id=s.job_id WHERE s.chat_id=? AND s.source_revision=? AND s.module_revision=? ORDER BY j.created_at DESC,j.id DESC').all(chatId,head,config.module.revision) as Row[];
    const valid = rows.find(row => this.job(row.job_id).status==='completed'&&this.valid(this.job(row.job_id),false));
    return valid ? parse(valid.body) : null;
  }
  prepare(snapshot: RunSnapshot): StorySnapshot | undefined {
    const config = this.configForBranch(snapshot.chatId,snapshot.branchId);
    const scope = {chatId:snapshot.chatId,history:snapshot.history};
    const authored = this.memory.entries(scope).some(entry => entry.kind==='author-canon');
    if (!config.module && !config.memory.enabled && !authored) return undefined;
    const state = this.stateAt(snapshot.chatId,snapshot.parentRevision,config);
    const memory = config.memory.enabled || authored ? this.memory.plan(scope,config.memory) : null;
    if (memory && !memory.plan.ready && !snapshot.profile?.models.main) throw new HttpError(409,'필수 작가 설정과 원문 문맥이 한도를 넘었어요. 기억 작업을 복구하거나 한도를 조정해 주세요.');
    return {config,state,waiting:config.module?.mode==='authoritative' && state===null,lineageHash:lineageHash(snapshot.history),canonHash:this.memory.canonHash(scope),memory,models:this.models(config)};
  }
  prepareRunInTransaction(snapshot: RunSnapshot): RunSnapshot { const story = this.prepare(snapshot); return story ? {...snapshot,story} : snapshot; }
  private sourceHistory(job: StoryJob, snapshot = this.bundle(job.id).snapshot) {
    const source = this.store.sourceAtHash(job.sourceRevision,job.sourceHash);
    return [...snapshot.history,{revision:source.id,text:source.text,contentHash:source.hash}];
  }
  private valid(job: StoryJob, currentModule = true): boolean {
    try {
      const {snapshot} = this.bundle(job.id);
      const story = snapshot.story;
      if (!story || this.store.source(job.sourceRevision).hash !== job.sourceHash) return false;
      if (lineageHash(this.store.history(job.sourceRevision)) !== lineageHash(this.sourceHistory(job,snapshot))) return false;
      if (this.memory.canonHash({chatId:job.chatId,history:snapshot.history}) !== story.canonHash) return false;
      if (job.kind==='state' && currentModule && this.configForBranch(job.chatId,snapshot.branchId).module?.revision !== story.config.module?.revision) return false;
      // Parent state is an immutable ID, never a mutable latest-state pointer.
      if (job.kind==='state' && story.state && !story.state.id.startsWith('initial:')) {
        const parent = this.db.prepare('SELECT body,job_id FROM story_states WHERE id=? AND chat_id=?').get(story.state.id,job.chatId) as Row | undefined;
        if (!parent || this.job(parent.job_id).status!=='completed' || !isDeepStrictEqual(parse(parent.body),story.state)) return false;
      }
      return true;
    } catch { return false; }
  }
  reserveSourceInTransaction(source: Source, run: Run) {
    this.finishCommandInTransaction(run.id,'consumed',source.id);
    const story = run.snapshot.story; if (!story) return;
    for (const kind of ['state','memory'] as const) {
      if (kind==='state' ? !story.config.module : !story.config.memory.enabled) continue;
      this.scheduleInTransaction(kind,source,run.snapshot);
    }
  }
  private scheduleInTransaction(kind:'state'|'memory',source:Source,snapshot:RunSnapshot):StoryJob {
    const key=storyDependencyKey(kind,source,snapshot);const prior=this.db.prepare('SELECT id FROM story_jobs WHERE dependency_key=?').get(key) as Row|undefined;
    if(prior)return this.job(prior.id);
    const id=randomUUID();const time=now();
    this.db.prepare("INSERT INTO story_jobs(id,chat_id,source_revision,source_hash,kind,config_revision,status,snapshot,mock,created_at,updated_at,dependency_key) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)").run(id,source.chatId,source.id,source.hash,kind,snapshot.story!.config.revision,json(snapshot),snapshot.story!.models[kind]?0:1,time,time,key);
    this.store.event(source.chatId,'story.job.queued',id);return this.job(id);
  }
  rebuildSource(id:string,kind:'state'|'memory',branchId?:string):StoryJob {
    return this.store.transaction(()=>{
      const source=this.store.source(id); const original=this.store.run(source.runId).snapshot;
      const branch=this.store.product.branch(source.chatId,branchId??original.branchId);
      if(branchId!==undefined&&!this.store.history(branch.headRevision).some(item=>item.revision===source.id))throw new HttpError(409,'Source is outside the selected branch');
      const config=this.configForBranch(source.chatId,branch.id);
      if(kind==='state'?!config.module:!config.memory.enabled)throw new HttpError(409,'해당 보조 기능이 꺼져 있어요.');
      const history=this.store.history(source.parentRevision);const scope={chatId:source.chatId,history};
      let state=kind==='state'?this.stateAt(source.chatId,source.parentRevision,config):null;
      if(kind==='state' && !state) state=activationRebuildState(source.chatId,config,source,history);
      if(kind==='state' && !state)throw new HttpError(409,'이전 원문의 상태를 먼저 복구해 주세요. 상태 시작점 이전 장면은 현재 장면에서 새 기준을 적용해야 해요.');
      const snapshot:RunSnapshot={...structuredClone(original),branchId:branch.id,history,story:{config,state,waiting:false,lineageHash:lineageHash(history),canonHash:this.memory.canonHash(scope),memory:this.memory.plan(scope,config.memory),models:this.models(config)}};
      snapshot.logicalHistory=captureLogicalHistory(this.store,snapshot);
      return this.scheduleInTransaction(kind,source,snapshot);
    });
  }
  indexHistory(chatId:string,branchId?:string):StoryJob[] {
    const branch=this.store.product.branch(chatId,branchId);
    return this.store.history(branch.headRevision).map(item=>this.rebuildSource(item.revision,'memory',branch.id));
  }
  job(id: string): StoryJob {
    const row = this.db.prepare('SELECT * FROM story_jobs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404,'Story job not found');
    return {id:row.id,chatId:row.chat_id,sourceRevision:row.source_revision,sourceHash:row.source_hash,kind:row.kind,configRevision:row.config_revision,generation:row.generation,owner:row.owner,status:row.status,error:row.error,mock:!!row.mock,result:parse(row.result),createdAt:row.created_at,updatedAt:row.updated_at,inputs:parse(row.inputs)??[],toolEvents:parse(row.tool_events)??[]};
  }
  bundle(id: string): {job:StoryJob;snapshot:RunSnapshot;source:Source} {
    const job = this.job(id); const row = this.db.prepare('SELECT snapshot FROM story_jobs WHERE id=?').get(id) as Row;
    return {job,snapshot:parse(row.snapshot),source:this.store.sourceAtHash(job.sourceRevision,job.sourceHash)};
  }
  queued() { return (this.db.prepare("SELECT id FROM story_jobs WHERE status='queued' ORDER BY created_at,id").all() as Row[]).map(row=>row.id); }
  diagnostic(id:string,generation:number,owner:string,kind:'inputs'|'tool_events',value:unknown) {
    const row=this.db.prepare(`SELECT ${kind} AS entries FROM story_jobs WHERE id=? AND generation=? AND owner=? AND status='running'`).get(id,generation,owner) as Row|undefined;
    if(row)this.db.prepare(`UPDATE story_jobs SET ${kind}=? WHERE id=?`).run(json([...(parse(row.entries)??[]),value]),id);
  }
  claim(id: string, owner: string): StoryJob | null {
    return this.store.transaction(() => {
      const job = this.job(id); if (job.status!=='queued') return null;
      if (!this.valid(job)) { this.db.prepare("UPDATE story_jobs SET status='stale',error='원문·규칙·작가 설정이 변경됐어요.',updated_at=? WHERE id=?").run(now(),id); this.store.event(job.chatId,'story.job.stale',id); return null; }
      const {snapshot,source}=this.bundle(id);
      if(job.kind==='state' && !snapshot.story!.state){
        // Continuity can generate prose immediately; its reducer still depends on the preceding state.
        const state=this.stateAt(job.chatId,source.parentRevision,snapshot.story!.config);
        if(!state)return null;
        const resolved={...snapshot,story:{...snapshot.story!,state,waiting:false}};
        const key=storyDependencyKey('state',source,resolved);
        const prior=this.db.prepare('SELECT id FROM story_jobs WHERE dependency_key=? AND id<>?').get(key,id) as Row|undefined;
        if(prior){this.db.prepare("UPDATE story_jobs SET status='cancelled',error='같은 의존성의 작업이 이미 있어요.',updated_at=? WHERE id=?").run(now(),id);this.store.event(job.chatId,'story.job.cancelled',id);return null;}
        this.db.prepare('UPDATE story_jobs SET snapshot=?,dependency_key=? WHERE id=?').run(json(resolved),key,id);
      }
      this.db.prepare("UPDATE story_jobs SET status='running',generation=generation+1,owner=?,error=NULL,updated_at=? WHERE id=?").run(owner,now(),id);
      this.store.event(job.chatId,'story.job.running',id); return this.job(id);
    });
  }
  finish(id: string, generation: number, owner: string, outcome: {status:'completed'|'failed'|'interrupted';result:unknown;error:string|null;mock:boolean}): StoryJob {
    return this.store.transaction(() => {
      const job = this.job(id); if (job.status!=='running' || job.owner!==owner || job.generation!==generation) return job;
      if (!this.valid(job)) { this.db.prepare("UPDATE story_jobs SET status='stale',result=?,error='원문·규칙·작가 설정이 변경됐어요.',owner=NULL,updated_at=? WHERE id=?").run(json(outcome.result),now(),id); this.store.event(job.chatId,'story.job.stale',id); return this.job(id); }
      const {snapshot,source} = this.bundle(id); const story = snapshot.story!;
      if (outcome.status==='completed') {
        if (job.kind==='state') {
          const module = story.config.module!;
          if(!story.state)throw new HttpError(409,'이전 상태가 확정되지 않았어요.');
          const previous = story.state.values;
          const result = reduceStateProposal(module,previous,outcome.result as StateProposal,{revision:source.id,hash:source.hash,text:source.text});
          const state: StoryState = {id:randomUUID(),sourceRevision:source.id,sourceHash:source.hash,moduleRevision:module.revision,...result};
          this.db.prepare('INSERT INTO story_states VALUES(?,?,?,?,?,?,?,?)').run(state.id,id,job.chatId,source.id,source.hash,module.revision,story.state?.id??null,json(state));
        } else {
          const result = record(outcome.result); fields(result,['entries']);
          if (!Array.isArray(result.entries)) throw new HttpError(400,'Invalid memory result');
          outcome = {...outcome,result:{entries:this.memory.completeInTransaction(id,job.chatId,source,this.sourceHistory(job,snapshot),result.entries)}};
        }
      }
      this.db.prepare('UPDATE story_jobs SET status=?,result=?,error=?,mock=?,owner=NULL,updated_at=? WHERE id=?').run(outcome.status,json(outcome.result),outcome.error,outcome.mock?1:0,now(),id);
      this.store.event(job.chatId,`story.job.${outcome.status}`,id); return this.job(id);
    });
  }
  retry(id: string): StoryJob {
    return this.store.transaction(() => {
      const job = this.job(id);
      if (['queued','running','completed'].includes(job.status)) return job;
      if (!this.valid(job)) throw new HttpError(409,'원문 또는 규칙이 변경된 작업이에요. 현재 원문에서 새 기억·상태 작업을 요청해 주세요.');
      this.db.prepare("UPDATE story_jobs SET status='queued',owner=NULL,error=NULL,updated_at=? WHERE id=?").run(now(),id);
      this.store.event(job.chatId,'story.job.queued',id); return this.job(id);
    });
  }
  cancel(id: string): StoryJob {
    return this.store.transaction(() => {
      const job=this.job(id); if (!['queued','running'].includes(job.status)) return job;
      this.db.prepare("UPDATE story_jobs SET status='cancelled',generation=generation+1,owner=NULL,error='작업을 취소했어요.',updated_at=? WHERE id=?").run(now(),id);
      this.store.event(job.chatId,'story.job.cancelled',id); return this.job(id);
    });
  }
  recover() {
    this.store.transaction(() => {
      for (const row of this.db.prepare("SELECT id,chat_id FROM story_jobs WHERE status='running'").all() as Row[]) {
        this.db.prepare("UPDATE story_jobs SET status='interrupted',generation=generation+1,owner=NULL,error='서버가 중단됐어요. 실행 여부가 불확실하여 자동 재시도하지 않아요.',updated_at=? WHERE id=?").run(now(),row.id);
        this.store.event(row.chat_id,'story.job.interrupted',row.id);
      }
    });
  }
  resumeWaiting(): string[] {
    return this.store.transaction(() => {
      const ready: string[]=[];
      for (const row of this.db.prepare("SELECT id FROM runs WHERE status='waiting_for_state' ORDER BY created_at,id").all() as Row[]) {
        const run = this.store.run(row.id); const story = run.snapshot.story!;
        const branch = this.store.product.branch(run.chatId,run.snapshot.branchId);
        if (branch.headRevision!==run.parentRevision || lineageHash(this.store.history(run.parentRevision))!==story.lineageHash || this.memory.canonHash({chatId:run.chatId,history:run.snapshot.history})!==story.canonHash) {
          this.db.prepare("UPDATE runs SET status='failed',error='대기 중 원문 또는 작가 설정이 변경됐어요. 새 요청이 필요해요.',updated_at=? WHERE id=?").run(now(),run.id); this.finishCommandInTransaction(run.id,'failed'); this.store.event(run.chatId,'run.failed',run.id); continue;
        }
        const state = this.stateAt(run.chatId,run.parentRevision,story.config); if (!state) continue;
        const snapshot = compileSnapshotPrompt(freezeLoreContext(this.store,{...run.snapshot,story:{...story,state,waiting:false}}));
        this.db.prepare("UPDATE runs SET status='queued',snapshot=?,updated_at=? WHERE id=? AND status='waiting_for_state'").run(json(snapshot),now(),run.id);
        this.store.event(run.chatId,'run.queued',run.id); ready.push(run.id);
      }
      return ready;
    });
  }
  onSourceEditedInTransaction(sourceId: string) {
    const source = this.store.source(sourceId);
    for (const row of this.db.prepare("SELECT id FROM story_jobs WHERE chat_id=? AND status IN ('queued','running','completed')").all(source.chatId) as Row[]) {
      const job = this.job(row.id); if (this.valid(job,false)) continue;
      this.db.prepare("UPDATE story_jobs SET status='stale',generation=generation+1,owner=NULL,error='원문 의존성이 변경됐어요.',updated_at=? WHERE id=?").run(now(),job.id);
      this.store.event(source.chatId,'story.job.stale',job.id);
    }
  }
  sourceDetail(id: string) {
    const source=this.store.source(id); const jobs=(this.db.prepare('SELECT id FROM story_jobs WHERE source_revision=? ORDER BY created_at,id').all(id) as Row[]).map(row=>this.job(row.id));
    const row = this.db.prepare('SELECT body,job_id FROM story_states WHERE source_revision=? ORDER BY rowid DESC LIMIT 1').get(id) as Row | undefined;
    const state:StoryState|null=row?parse(row.body):null;
    const status = row ? this.job(row.job_id).status==='completed'&&this.valid(this.job(row.job_id),false) ? 'ready' : 'stale' : jobs.some(job=>job.kind==='state') ? 'pending' : 'disabled';
    return {state,status,jobs};
  }
  detail(chatId: string, branchId?: string): StoryDetail {
    const branch=this.store.product.branch(chatId,branchId); const scope=this.memory.scope(chatId,branch.headRevision); const config=this.configForBranch(chatId,branch.id); const state=this.stateAt(chatId,branch.headRevision,config);
    const jobs=(this.db.prepare('SELECT id FROM story_jobs WHERE chat_id=? ORDER BY created_at,id').all(chatId) as Row[]).map(row=>this.job(row.id));
    return {config,state,stateStatus:!config.module?'disabled':state?'ready':jobs.some(job=>job.sourceRevision===branch.headRevision && job.status==='stale')?'stale':'pending',jobs,memory:this.memory.entries(scope),checkpoint:this.memory.checkpoint(scope),commands:this.commands(chatId,branch.id)};
  }
  commands(chatId: string, branchId: string): SceneCommand[] {
    return (this.db.prepare('SELECT id FROM scene_commands WHERE chat_id=? AND branch_id=? ORDER BY rowid').all(chatId,branchId) as Row[]).map(row=>this.command(row.id));
  }
  command(id:string):SceneCommand {
    const row=this.db.prepare('SELECT * FROM scene_commands WHERE id=?').get(id) as Row|undefined; if(!row)throw new HttpError(404,'Scene command not found');
    return {id:row.id,chatId:row.chat_id,branchId:row.branch_id,label:row.label,request:row.request,status:row.status,runId:row.run_id,sourceRevision:row.source_revision};
  }
  createCommand(chatId:string,value:unknown):SceneCommand {
    const body=record(value); fields(body,['label','request','branchId','idempotencyKey']); const key=text(body.idempotencyKey,'command key',120); const label=text(body.label,'command label',120); const request=text(body.request,'scene request',4000);
    const branch=this.store.product.branch(chatId,body.branchId===undefined?undefined:text(body.branchId,'branch',100));
    return this.store.transaction(()=>{
      const prior=this.db.prepare('SELECT id FROM scene_commands WHERE chat_id=? AND request_key=?').get(chatId,key) as Row|undefined;
      if(prior){const saved=this.command(prior.id);if(saved.label!==label||saved.request!==request||saved.branchId!==branch.id)throw new HttpError(409,'Command key reused');return saved;}
      const id=randomUUID();this.db.prepare("INSERT INTO scene_commands VALUES(?,?,?,?,?,?,'pending',NULL,NULL)").run(id,chatId,branch.id,key,label,request);this.store.event(chatId,'scene.command.created',id);return this.command(id);
    });
  }
  bindCommandInTransaction(commandId:string,runId:string) {
    const command=this.command(commandId);const run=this.store.run(runId);
    if(command.chatId!==run.chatId||command.branchId!==run.snapshot.branchId||command.request!==run.request||command.status==='consumed'||command.runId&&['queued','running','waiting_for_state'].includes(this.store.run(command.runId).status))throw new HttpError(409,'Scene command is unavailable');
    this.db.prepare("UPDATE scene_commands SET run_id=?,status='pending' WHERE id=?").run(runId,commandId);
  }
  finishCommandInTransaction(runId:string,status:'consumed'|'failed'|'cancelled',sourceId?:string) {
    this.db.prepare('UPDATE scene_commands SET status=?,source_revision=? WHERE run_id=? AND status=\'pending\'').run(status,sourceId??null,runId);
  }
  cancelCommand(id:string):SceneCommand {
    const command=this.command(id);if(command.runId&&['queued','running','waiting_for_state'].includes(this.store.run(command.runId).status))throw new HttpError(409,'진행 중인 원문 생성을 먼저 취소해 주세요.');
    if(command.status!=='consumed')this.db.prepare("UPDATE scene_commands SET status='cancelled' WHERE id=?").run(id);return this.command(id);
  }
}
