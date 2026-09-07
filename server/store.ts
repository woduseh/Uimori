import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import type { Controls } from './controls.js';
import { editSource, editTranslation, requestTranslation, latestTranslation, validateTranslationArtifact } from './source-editing.js';
import { ProductStore } from './product-store.js';
import { StoryStore } from './story-store.js';
import { splitSource, BUILTIN_ASSETS } from '../core/auxiliary.js';
import type { Settings, Chat as BaseChat, Run as BaseRun, Source as BaseSource, Job as BaseJob, Resource, RunSnapshot, Usage, ModelInput, ToolEvent } from '../core/types.js';

export type Chat = BaseChat & { createdAt: string };
export type Run = BaseRun & { createdAt: string; updatedAt: string };
export type Source = BaseSource & { createdAt: string };
export type Job = BaseJob & { generation: number; input: unknown; createdAt: string; updatedAt: string };
type Row = Record<string, any>;
const json = (value: unknown) => JSON.stringify(value);
const parse = (value: any) => value === null ? null : JSON.parse(String(value));
const now = () => new Date().toISOString();
export class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }

/** One server owns this file DB. No transaction spans provider or browser I/O. */
export class Store {
  readonly db: DatabaseSync;
  readonly product: ProductStore;
  readonly story: StoryStore;
  private readonly ownership: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
    // A separate empty SQLite file is an OS-released lifetime mutex. Story-data
    // writes use the short transactions below; they never wait on provider I/O.
    this.ownership = new DatabaseSync(`${this.path}.owner.sqlite`);
    try { this.ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { this.ownership.close(); throw new Error('Database already has a running server owner'); }
    try { this.db = new DatabaseSync(this.path); }
    catch (error) { this.ownership.close(); throw error; }
    try {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    const version = this.db.prepare('PRAGMA user_version').get() as Row;
    if (Number(version.user_version) > 4) throw new Error('Unsupported database schema version');
    if (Number(version.user_version) === 0) this.db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, head_revision TEXT, settings_revision INTEGER NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), parent_revision TEXT, status TEXT NOT NULL, request TEXT NOT NULL, snapshot TEXT NOT NULL, request_key TEXT NOT NULL, command TEXT NOT NULL, source_revision TEXT, error TEXT, usage TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id,request_key));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_chat ON runs(chat_id) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), parent_revision TEXT REFERENCES sources(id), text TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('translation','status')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, input TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_revision,kind));
      CREATE TABLE IF NOT EXISTS job_results (job_id TEXT PRIMARY KEY REFERENCES jobs(id), generation INTEGER NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL, entity_id TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_events ON events(chat_id,seq);
      PRAGMA user_version=1;
      COMMIT;
    `);
    this.product = new ProductStore(this);
    this.product.migrate(Number(version.user_version));
    this.story = new StoryStore(this);
    this.story.migrate();
    } catch (error) { this.db.close(); this.ownership.close(); throw error; }
  }
  close() { this.db.close(); this.ownership.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(chatId: string, kind: string, entityId: string) {
    this.db.prepare('INSERT INTO events(chat_id,kind,entity_id,at) VALUES(?,?,?,?)').run(chatId, kind, entityId, now());
  }
  events(chatId: string, after: number) {
    return this.db.prepare('SELECT seq,chat_id AS chatId,kind,entity_id AS entityId,at FROM events WHERE chat_id=? AND seq>? ORDER BY seq').all(chatId, after);
  }
  private mapChat(row: Row): Chat { return { id: row.id, title: row.title, headRevision: row.head_revision, settingsRevision: row.settings_revision, settings: parse(row.settings), createdAt: row.created_at }; }
  chat(id: string): Chat {
    const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Chat not found');
    return this.mapChat(row);
  }
  chats(): Chat[] { return (this.db.prepare('SELECT * FROM chats ORDER BY created_at,id').all() as Row[]).map(row => this.mapChat(row)); }
  createChat(title: string, preset: Settings['preset'] = 'calm', resources: (id: string) => Resource[] = () => []): Chat {
    const id = randomUUID();
    const settings: Settings = { preset, mode: 'direct', translation: true, status: true, maxCalls: 8 };
    this.transaction(() => {
      this.db.prepare('INSERT INTO chats VALUES(?,?,NULL,1,?,?)').run(id, title, json(settings), now());
      this.db.prepare('INSERT INTO branches VALUES(?,?,?,NULL,1,1)').run(`main:${id}`,id,'기본 분기');
      for (const resource of resources(id)) this.db.prepare('INSERT INTO resources VALUES(?,?,?)').run(resource.id, id, json(resource));
    });
    return this.chat(id);
  }
  resources(chatId: string): Resource[] { return (this.db.prepare('SELECT body FROM resources WHERE chat_id=? ORDER BY id').all(chatId) as Row[]).map(row => parse(row.body)); }
  history(head: string | null): RunSnapshot['history'] {
    const history: RunSnapshot['history'] = [];
    const seen = new Set<string>();
    while (head) { if (seen.has(head)) throw new HttpError(400,'Source ancestry cycle'); seen.add(head); const source = this.source(head); history.unshift({ revision: source.id, text: source.text, ...(source.hash !== this.sourceOriginal(source.id).hash ? {contentHash:source.hash} : {}) }); head = source.parentRevision; }
    return history;
  }
  settings(id: string, expected: number, settings: Settings): Chat {
    return this.transaction(() => {
      this.chat(id);
      const changed = this.db.prepare('UPDATE chats SET settings=?, settings_revision=settings_revision+1 WHERE id=? AND settings_revision=?').run(json(settings), id, expected);
      if (Number(changed.changes) !== 1) throw new HttpError(409, 'Settings revision conflict');
      this.event(id, 'settings.updated', id);
      return this.chat(id);
    });
  }
  createRun(chatId: string, command: { request: string; expectedRevision: string | null; expectedSettingsRevision: number; idempotencyKey: string; branchId?: string; expectedProfileRevision?: number; sceneCommandId?: string }, snapshot: (chat: Chat) => RunSnapshot): { run: Run; created: boolean } {
    return this.transaction(() => {
      const canonical = json({ request: command.request, expectedRevision: command.expectedRevision, expectedSettingsRevision: command.expectedSettingsRevision, branchId: command.branchId ?? `main:${chatId}`, expectedProfileRevision: command.expectedProfileRevision, ...(command.sceneCommandId ? {sceneCommandId:command.sceneCommandId} : {}) });
      const prior = this.db.prepare('SELECT id,command FROM runs WHERE chat_id=? AND request_key=?').get(chatId, command.idempotencyKey) as Row | undefined;
      if (prior) {
        if (prior.command !== canonical) throw new HttpError(409, 'Idempotency key reused with different command');
        return { run: this.run(prior.id), created: false };
      }
      const chat = this.chat(chatId);
      const branch = this.product.branch(chatId,command.branchId);
      if (branch.headRevision !== command.expectedRevision) throw new HttpError(409, 'Source revision conflict');
      if (chat.settingsRevision !== command.expectedSettingsRevision) throw new HttpError(409, 'Settings revision conflict');
      if (command.expectedProfileRevision !== undefined && this.product.profile(chatId).revision !== command.expectedProfileRevision) throw new HttpError(409,'Profile revision conflict');
      if (this.db.prepare("SELECT id FROM runs WHERE branch_id=? AND status IN ('queued','running','waiting_for_state')").get(branch.id)) throw new HttpError(409, 'A run already owns this head');
      const id = randomUUID(); const time = now();
      const frozen = this.story.prepareRunInTransaction({...snapshot({...chat,headRevision:branch.headRevision}),branchId:branch.id});
      const status = frozen.story?.waiting ? 'waiting_for_state' : 'queued';
      this.db.prepare('INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, chatId, command.expectedRevision, status, command.request, json(frozen), command.idempotencyKey, canonical, time, time,branch.id);
      if (command.sceneCommandId) this.story.bindCommandInTransaction(command.sceneCommandId,id);
      this.event(chatId, `run.${status}`, id);
      return { run: this.run(id), created: true };
    });
  }
  candidate(runId: string, key: string, title: string): {run: Run; created: boolean} {
    return this.transaction(() => {
      const original = this.run(runId);
      if (['queued','running','waiting_for_state'].includes(original.status)) throw new HttpError(409,'Original run is still active');
      const canonical = json({candidateOf:runId,title});
      const prior = this.db.prepare('SELECT id,command FROM runs WHERE chat_id=? AND request_key=?').get(original.chatId,key) as Row | undefined;
      if (prior) { if (prior.command !== canonical) throw new HttpError(409,'Idempotency key reused with different command'); return {run:this.run(prior.id),created:false}; }
      const branch = this.product.createBranch(original.chatId,{title,fromRevision:original.parentRevision});
      const snapshot: RunSnapshot = {...structuredClone(original.snapshot),branchId:branch.id,candidateOf:original.id}; const id = randomUUID(); const time = now();
      this.db.prepare("INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id) VALUES(?,?,?,'queued',?,?,?,?,?,?,?)").run(id,original.chatId,original.parentRevision,original.request,json(snapshot),key,canonical,time,time,branch.id);
      this.event(original.chatId,'run.queued',id); return {run:this.run(id),created:true};
    });
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Run not found');
    const calls = this.db.prepare('SELECT count(*) AS count FROM model_inputs WHERE run_id=?').get(id) as Row;
    return { id: row.id, chatId: row.chat_id, parentRevision: row.parent_revision, settingsRevision: parse(row.snapshot).settingsRevision, status: row.status, request: row.request, snapshot: parse(row.snapshot), sourceRevision: row.source_revision, error: row.error, usage: parse(row.usage) ?? { modelCalls: calls.count, inputTokens: null, outputTokens: null, costUsd: null }, createdAt: row.created_at, updatedAt: row.updated_at,
      partialText: row.partial_text ?? '',issue: row.issue,inputs: (this.db.prepare('SELECT input FROM model_inputs WHERE run_id=? ORDER BY seq').all(id) as Row[]).map(r => parse(r.input)),
      toolEvents: (this.db.prepare('SELECT event FROM tool_events WHERE run_id=? ORDER BY seq').all(id) as Row[]).map(r => parse(r.event)) };
  }
  startRun(id: string) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.status !== 'queued') return false;
      this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").run(now(), id);
      this.event(run.chatId, 'run.running', id); return true;
    });
  }
  input(id: string, input: ModelInput) { this.db.prepare('INSERT INTO model_inputs(run_id,input) VALUES(?,?)').run(id, json(input)); }
  tool(id: string, event: ToolEvent) { this.db.prepare('INSERT INTO tool_events(run_id,event) VALUES(?,?)').run(id, json(event)); }
  finishRun(id: string, status: 'failed' | 'cancelled' | 'interrupted' | 'refused' | 'partial', error: string, partialText = '', usage?: Usage) {
    return this.transaction(() => {
      const run = this.run(id);
      if (!['queued', 'running', 'waiting_for_state'].includes(run.status)) return run;
      this.db.prepare('UPDATE runs SET status=?,error=?,partial_text=?,usage=COALESCE(?,usage),updated_at=? WHERE id=?').run(status, error, partialText, usage ? json(usage) : null, now(), id);
      this.story.finishCommandInTransaction(id,status==='cancelled'?'cancelled':'failed');
      this.event(run.chatId, `run.${status}`, id); return this.run(id);
    });
  }
  settleCancelledUsage(id: string, usage: Usage): Run {
    return this.transaction(() => {
      const run = this.run(id);
      // A cancel endpoint may finish the run before the in-flight attempt returns.
      // Fill that missing aggregate once without changing status, source, or prior usage.
      const changed = this.db.prepare("UPDATE runs SET usage=?,updated_at=? WHERE id=? AND status='cancelled' AND usage IS NULL").run(json(usage), now(), id);
      if (changed.changes) this.event(run.chatId, 'run.usage', id);
      return this.run(id);
    });
  }
  completeRun(id: string, text: string, usage: Usage, settings: Settings, controls?: Controls): Source {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.status !== 'running') throw new HttpError(409, 'Run no longer owns completion');
      const branch = this.product.branch(run.chatId,run.snapshot.branchId);
      if (branch.headRevision !== run.parentRevision) throw new HttpError(409, 'Source revision changed');
      const source: Source = { id: randomUUID(), runId: id, chatId: run.chatId, parentRevision: run.parentRevision, text, hash: createHash('sha256').update(text).digest('hex'), createdAt: now() };
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(source.id, source.chatId, id, source.parentRevision, source.text, source.hash, source.createdAt);
      this.db.prepare("UPDATE runs SET status='completed',source_revision=?,usage=?,updated_at=? WHERE id=?").run(source.id, json(usage), now(), id);
      controls?.fail('source-transaction');
      this.db.prepare('UPDATE branches SET head_revision=?,revision=revision+1 WHERE id=?').run(source.id,branch.id);
      if (branch.default) this.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(source.id, source.chatId);
      for (const kind of ['status','image'] as const) {
        if (!(kind === 'image' ? run.snapshot.profile?.image : settings[kind])) continue;
        const jobId = randomUUID(); const time = now();
        this.db.prepare("INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(jobId, source.chatId, source.id, source.hash, kind, time, time);
        this.event(source.chatId, 'job.queued', jobId);
      }
      this.story.reserveSourceInTransaction(source,run);
      this.event(source.chatId, 'source.ready', source.id);
      this.event(source.chatId, 'run.completed', id);
      return source;
    });
  }
  sourceOriginal(id:string):Source {
    const row=this.db.prepare('SELECT id,chat_id AS chatId,run_id AS runId,parent_revision AS parentRevision,text,hash,created_at AS createdAt FROM sources WHERE id=?').get(id) as Source|undefined;
    if(!row)throw new HttpError(404,'Source not found');const translation=this.db.prepare("SELECT revision FROM jobs WHERE source_revision=? AND kind='translation' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1").get(id) as Row|undefined;return {...row,editRevision:0,translationRevision:translation?.revision??0,blocks:splitSource(row)};
  }
  source(id:string):Source {
    const original=this.sourceOriginal(id);const edit=this.db.prepare('SELECT text,hash,revision FROM source_edits WHERE source_id=? ORDER BY revision DESC LIMIT 1').get(id) as Row|undefined;
    if(!edit)return original;const source={...original,text:edit.text,hash:edit.hash,editRevision:edit.revision};return {...source,blocks:splitSource(source)};
  }
  sourceAtHash(id:string,hash:string):Source {
    const original=this.sourceOriginal(id);if(original.hash===hash)return original;
    const edit=this.db.prepare('SELECT text,hash,revision FROM source_edits WHERE source_id=? AND hash=? ORDER BY revision DESC LIMIT 1').get(id,hash) as Row|undefined;
    if(!edit)throw new HttpError(400,'Unknown source content hash');const source={...original,text:edit.text,hash:edit.hash,editRevision:edit.revision};return {...source,blocks:splitSource(source)};
  }
  validateHistory(history:RunSnapshot['history'],head:string|null):boolean {
    if(!Array.isArray(history))return false;const ids=this.history(head).map(item=>item.revision);
    if(ids.length!==history.length)return false;
    return history.every((item,index)=>{if(!item||item.revision!==ids[index]||Object.keys(item).some(k=>!['revision','text','contentHash'].includes(k)))return false;const source=item.contentHash===undefined?this.sourceOriginal(item.revision):this.sourceAtHash(item.revision,item.contentHash);return item.text===source.text;});
  }
  editSource(id:string,value:{text:string;expectedRevision:number}):Source{return editSource(this,id,value);}
  editTranslation(id:string,value:{text:string;expectedRevision:number;expectedSourceHash:string}):Job{return editTranslation(this,id,value);}
  requestTranslation(id:string):Job{return requestTranslation(this,id);}
  job(id: string): Job {
    const row = this.db.prepare('SELECT j.*,r.result FROM jobs j LEFT JOIN job_results r ON r.job_id=j.id WHERE j.id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Job not found');
    return { id: row.id, chatId: row.chat_id, sourceRevision: row.source_revision, sourceHash: row.source_hash, kind: row.kind, status: row.status, attempt: row.generation, generation: row.generation, input: parse(row.input), result: parse(row.result ?? null), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,revision:row.revision,chunks:this.product.chunks(id) };
  }
  queuedJobs(): string[] { return (this.db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id").all() as Row[]).map(row => row.id); }
  claimJob(id: string, owner: string, input: unknown, plan?: {chunks:{id:string}[]}): Job | null {
    return this.transaction(() => {
      const priorInput = this.job(id).input;
      const translationModelSelection = priorInput && typeof priorInput === 'object' && Object.hasOwn(priorInput,'translationModelSelection') ? {translationModelSelection:(priorInput as {translationModelSelection:unknown}).translationModelSelection} : {};
      const promptSelection = priorInput && typeof priorInput === 'object' && Object.hasOwn(priorInput,'promptSelection') ? {promptSelection:(priorInput as {promptSelection:unknown}).promptSelection} : {};
      const claimedInput = input && typeof input === 'object' && !Array.isArray(input) ? {...input,...promptSelection,...translationModelSelection} : input;
      const changed = this.db.prepare("UPDATE jobs SET status='running',generation=generation+1,owner=?,input=?,error=NULL,updated_at=? WHERE id=? AND status='queued'").run(owner, json(claimedInput), now(), id);
      if (!changed.changes) return null;
      if (plan) { this.product.plan(id,plan); for (const chunk of plan.chunks) this.db.prepare("INSERT OR IGNORE INTO job_chunks(job_id,id,status,attempt) VALUES(?,?,'queued',0)").run(id,chunk.id); }
      const job = this.job(id); this.event(job.chatId, 'job.running', id); return job;
    });
  }
  completeJob(id: string, generation: number, owner: string, result: unknown, controls?: Controls): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
      if (!row || row.status !== 'running' || row.generation !== generation || row.owner !== owner) return false;
      const source = this.source(row.source_revision);
      if (source.hash !== row.source_hash || source.chatId !== row.chat_id) throw new Error('Job source dependency changed');
      this.db.prepare('INSERT INTO job_results VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET generation=excluded.generation,result=excluded.result,created_at=excluded.created_at').run(id, generation, json(result), now());
      controls?.fail('job-transaction');
      this.db.prepare("UPDATE jobs SET status='completed',updated_at=? WHERE id=?").run(now(), id);
      this.event(row.chat_id, 'job.completed', id); return true;
    });
  }
  failJob(id: string, generation: number, owner: string, error: string) {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running' AND generation=? AND owner=?").run(error, now(), id, generation, owner);
      if (changed.changes) this.event(this.job(id).chatId, 'job.failed', id);
    });
  }
  retryJob(id: string, chunkId?: string): Job {
    return this.transaction(() => {
      const job = this.job(id);
      if (chunkId && !job.chunks?.some(c => c.id === chunkId && c.status !== 'completed')) throw new HttpError(409,'Chunk is not retryable');
      if (['failed','partial','interrupted','cancelled'].includes(job.status)) {
        this.db.prepare("UPDATE jobs SET status='queued',error=NULL,retry_chunk=?,updated_at=? WHERE id=?").run(chunkId ?? null,now(), id);
        this.event(job.chatId, 'job.queued', id);
      }
      return this.job(id);
    });
  }
  cancelJob(id: string): Job { return this.transaction(() => { const job = this.job(id); if (['queued','running'].includes(job.status)) { this.db.prepare("UPDATE jobs SET status='cancelled',error='Job cancelled',updated_at=? WHERE id=?").run(now(),id); this.event(job.chatId,'job.cancelled',id); } return this.job(id); }); }
  retranslate(id:string):Job{return requestTranslation(this,id,true);}
  finishAuxiliary(id: string, generation: number, owner: string, value: {status:string;result:unknown;error:string|null}, controls?: Controls) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE id=? AND generation=? AND owner=? AND status='running'").get(id,generation,owner) as Row | undefined;
      if (!row) return false;
      const source = this.source(row.source_revision); if (source.hash !== row.source_hash || source.chatId !== row.chat_id) throw new Error('Job source dependency changed');
      if (value.result) { this.db.prepare('INSERT INTO job_results VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET generation=excluded.generation,result=excluded.result,created_at=excluded.created_at').run(id,generation,json(value.result),now()); controls?.fail('job-transaction'); }
      this.db.prepare('UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?').run(value.status,value.error,now(),id); this.event(row.chat_id,`job.${value.status}`,id); return true;
    });
  }
  ownsJob(id: string, generation: number, owner: string) { return !!this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND generation=? AND owner=? AND status='running'").get(id,generation,owner); }
  recover() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running')").all() as Row[]) {
        const run = this.run(row.id);
        this.db.prepare("UPDATE runs SET status='interrupted',error='Server stopped; generation was not automatically replayed',updated_at=? WHERE id=?").run(now(), run.id);
        this.story.finishCommandInTransaction(run.id,'failed');
        this.event(run.chatId, 'run.interrupted', run.id);
      }
      for (const row of this.db.prepare("SELECT id,source_revision,kind FROM jobs WHERE status='running'").all() as Row[]) {
        const source = this.sourceAtHash(row.source_revision,this.job(row.id).sourceHash); const snapshot = this.product.resolveJobPrompt(this.run(source.runId).snapshot,this.job(row.id).input);
        const live = !!snapshot.profile?.models[row.kind as 'translation'|'status'|'image'];
        this.db.prepare('UPDATE jobs SET status=?,owner=NULL,error=?,updated_at=? WHERE id=?').run(live ? 'interrupted':'queued',live ? 'Provider outcome uncertain; explicit retry required':null,now(),row.id);
      }
      this.db.prepare("UPDATE attempts SET status='interrupted',error='Provider outcome uncertain; not replayed' WHERE status='running'").run();
    });
  }
  detail(id: string) {
    const chat = this.chat(id);
    return { chat,
      runs: (this.db.prepare('SELECT id FROM runs WHERE chat_id=? ORDER BY created_at,id').all(id) as Row[]).map(row => this.run(row.id)),
      sources: (this.db.prepare('SELECT id FROM sources WHERE chat_id=? ORDER BY created_at,id').all(id) as Row[]).map(row => this.source(row.id)),
      jobs: (this.db.prepare('SELECT id FROM jobs WHERE chat_id=? ORDER BY created_at,id').all(id) as Row[]).map(row => this.job(row.id)).filter(job=>{const source=this.source(job.sourceRevision);if(job.sourceHash!==source.hash)return false;if(job.kind!=='translation')return true;if(latestTranslation(this,source.id)?.id!==job.id)return false;if(job.status==='completed'){try{validateTranslationArtifact(this,job,source);}catch{return false;}}return true;}),profile:this.product.profile(id),branches:this.product.branches(id),attempts:this.product.attempts(id),assets:[...this.product.assets(id),...BUILTIN_ASSETS.map(a => ({id:a.ref,chatId:id,revision:a.revision,title:a.alt,mime:'image/svg+xml',hash:a.hash,description:a.caption,actor:a.actorId ?? '',outfit:a.clothing ?? '',location:a.location ?? '',allowedUse:a.uses.length === 2 ? 'both' as const : a.uses[0],url:a.url}))] };
  }
}
