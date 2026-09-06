import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import type { Controls } from './controls.js';
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
    if (Number(version.user_version) > 1) throw new Error('Unsupported database schema version');
    this.db.exec(`
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
    } catch (error) { this.db.close(); this.ownership.close(); throw error; }
  }
  close() { this.db.close(); this.ownership.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(chatId: string, kind: string, entityId: string) {
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
      for (const resource of resources(id)) this.db.prepare('INSERT INTO resources VALUES(?,?,?)').run(resource.id, id, json(resource));
    });
    return this.chat(id);
  }
  resources(chatId: string): Resource[] { return (this.db.prepare('SELECT body FROM resources WHERE chat_id=? ORDER BY id').all(chatId) as Row[]).map(row => parse(row.body)); }
  history(head: string | null): RunSnapshot['history'] {
    const history: RunSnapshot['history'] = [];
    while (head) { const source = this.source(head); history.unshift({ revision: source.id, text: source.text }); head = source.parentRevision; }
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
  createRun(chatId: string, command: { request: string; expectedRevision: string | null; expectedSettingsRevision: number; idempotencyKey: string }, snapshot: (chat: Chat) => RunSnapshot): { run: Run; created: boolean } {
    return this.transaction(() => {
      const canonical = json({ request: command.request, expectedRevision: command.expectedRevision, expectedSettingsRevision: command.expectedSettingsRevision });
      const prior = this.db.prepare('SELECT id,command FROM runs WHERE chat_id=? AND request_key=?').get(chatId, command.idempotencyKey) as Row | undefined;
      if (prior) {
        if (prior.command !== canonical) throw new HttpError(409, 'Idempotency key reused with different command');
        return { run: this.run(prior.id), created: false };
      }
      const chat = this.chat(chatId);
      if (chat.headRevision !== command.expectedRevision) throw new HttpError(409, 'Source revision conflict');
      if (chat.settingsRevision !== command.expectedSettingsRevision) throw new HttpError(409, 'Settings revision conflict');
      if (this.db.prepare("SELECT id FROM runs WHERE chat_id=? AND status IN ('queued','running')").get(chatId)) throw new HttpError(409, 'A run already owns this head');
      const id = randomUUID(); const time = now();
      this.db.prepare('INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at) VALUES(?,?,?,\'queued\',?,?,?,?,?,?)').run(id, chatId, command.expectedRevision, command.request, json(snapshot(chat)), command.idempotencyKey, canonical, time, time);
      this.event(chatId, 'run.queued', id);
      return { run: this.run(id), created: true };
    });
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Run not found');
    const calls = this.db.prepare('SELECT count(*) AS count FROM model_inputs WHERE run_id=?').get(id) as Row;
    return { id: row.id, chatId: row.chat_id, parentRevision: row.parent_revision, settingsRevision: parse(row.snapshot).settingsRevision, status: row.status, request: row.request, snapshot: parse(row.snapshot), sourceRevision: row.source_revision, error: row.error, usage: parse(row.usage) ?? { modelCalls: calls.count, inputTokens: null, outputTokens: null, costUsd: null }, createdAt: row.created_at, updatedAt: row.updated_at,
      inputs: (this.db.prepare('SELECT input FROM model_inputs WHERE run_id=? ORDER BY seq').all(id) as Row[]).map(r => parse(r.input)),
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
  finishRun(id: string, status: 'failed' | 'cancelled' | 'interrupted', error: string) {
    return this.transaction(() => {
      const run = this.run(id);
      if (!['queued', 'running'].includes(run.status)) return run;
      this.db.prepare('UPDATE runs SET status=?,error=?,updated_at=? WHERE id=?').run(status, error, now(), id);
      this.event(run.chatId, `run.${status}`, id); return this.run(id);
    });
  }
  completeRun(id: string, text: string, usage: Usage, settings: Settings, controls?: Controls): Source {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.status !== 'running') throw new HttpError(409, 'Run no longer owns completion');
      if (this.chat(run.chatId).headRevision !== run.parentRevision) throw new HttpError(409, 'Source revision changed');
      const source: Source = { id: randomUUID(), runId: id, chatId: run.chatId, parentRevision: run.parentRevision, text, hash: createHash('sha256').update(text).digest('hex'), createdAt: now() };
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(source.id, source.chatId, id, source.parentRevision, source.text, source.hash, source.createdAt);
      this.db.prepare("UPDATE runs SET status='completed',source_revision=?,usage=?,updated_at=? WHERE id=?").run(source.id, json(usage), now(), id);
      controls?.fail('source-transaction');
      this.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(source.id, source.chatId);
      for (const kind of ['translation', 'status'] as const) {
        if (!settings[kind]) continue;
        const jobId = randomUUID(); const time = now();
        this.db.prepare("INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(jobId, source.chatId, source.id, source.hash, kind, time, time);
        this.event(source.chatId, 'job.queued', jobId);
      }
      this.event(source.chatId, 'source.ready', source.id);
      this.event(source.chatId, 'run.completed', id);
      return source;
    });
  }
  source(id: string): Source {
    const row = this.db.prepare('SELECT id,chat_id AS chatId,run_id AS runId,parent_revision AS parentRevision,text,hash,created_at AS createdAt FROM sources WHERE id=?').get(id) as Source | undefined;
    if (!row) throw new HttpError(404, 'Source not found'); return row;
  }
  job(id: string): Job {
    const row = this.db.prepare('SELECT j.*,r.result FROM jobs j LEFT JOIN job_results r ON r.job_id=j.id WHERE j.id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Job not found');
    return { id: row.id, chatId: row.chat_id, sourceRevision: row.source_revision, sourceHash: row.source_hash, kind: row.kind, status: row.status, attempt: row.generation, generation: row.generation, input: parse(row.input), result: parse(row.result ?? null), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  queuedJobs(): string[] { return (this.db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id").all() as Row[]).map(row => row.id); }
  claimJob(id: string, owner: string, input: unknown): Job | null {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET status='running',generation=generation+1,owner=?,input=?,error=NULL,updated_at=? WHERE id=? AND status='queued'").run(owner, json(input), now(), id);
      if (!changed.changes) return null;
      const job = this.job(id); this.event(job.chatId, 'job.running', id); return job;
    });
  }
  completeJob(id: string, generation: number, owner: string, result: unknown, controls?: Controls): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
      if (!row || row.status !== 'running' || row.generation !== generation || row.owner !== owner) return false;
      const source = this.source(row.source_revision);
      if (source.hash !== row.source_hash || source.chatId !== row.chat_id) throw new Error('Job source dependency changed');
      this.db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(id, generation, json(result), now());
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
  retryJob(id: string): Job {
    return this.transaction(() => {
      const job = this.job(id);
      if (job.status === 'failed') {
        this.db.prepare("UPDATE jobs SET status='queued',error=NULL,updated_at=? WHERE id=?").run(now(), id);
        this.event(job.chatId, 'job.queued', id);
      }
      return this.job(id);
    });
  }
  recover() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running')").all() as Row[]) {
        const run = this.run(row.id);
        this.db.prepare("UPDATE runs SET status='interrupted',error='Server stopped; generation was not automatically replayed',updated_at=? WHERE id=?").run(now(), run.id);
        this.event(run.chatId, 'run.interrupted', run.id);
      }
      // These are local deterministic mock jobs. Real paid requests need a distinct uncertain state.
      this.db.prepare("UPDATE jobs SET status='queued',owner=NULL,updated_at=? WHERE status='running'").run(now());
    });
  }
  detail(id: string) {
    const chat = this.chat(id);
    return { chat,
      runs: (this.db.prepare('SELECT id FROM runs WHERE chat_id=? ORDER BY created_at,id').all(id) as Row[]).map(row => this.run(row.id)),
      sources: (this.db.prepare('SELECT id FROM sources WHERE chat_id=? ORDER BY created_at,id').all(id) as Row[]).map(row => this.source(row.id)),
      jobs: (this.db.prepare('SELECT id FROM jobs WHERE chat_id=? ORDER BY created_at,id').all(id) as Row[]).map(row => this.job(row.id)) };
  }
}
