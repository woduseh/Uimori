import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { memoryHash, planMemoryContext, validateMemoryEntry, visibleMemoryEntries, type MemoryCheckpoint, type MemoryEntry, type MemoryHistoryItem, type MemoryScope } from '../core/memory.js';
import type { StoryConfig } from '../core/story.js';
import { HttpError, type Store } from './store.js';
import { hiddenMemoryEntryAllowed } from '../core/hidden-context.js';

type Row = Record<string, any>;
const reject = (message: string): never => { throw new HttpError(400, `Memory: ${message}`); };
const normalizedHistory = (items: readonly MemoryHistoryItem[]) => items.map(item => ({ revision: item.revision, text: item.text, contentHash: item.contentHash ?? memoryHash(item.text) }));

/** Persistence only; schema migration and job transaction ownership belong to StoryStore. */
export class StoryMemory {
  readonly db;
  constructor(readonly store: Store) { this.db = store.db; }

  scope(chatId: string, headRevision: string | null): MemoryScope {
    this.store.chat(chatId);
    const history = this.store.history(headRevision);
    for (const item of history) if (this.store.source(item.revision).chatId !== chatId) reject('source outside chat');
    return { chatId, history };
  }

  private verifyScope(scope: MemoryScope) {
    const actual = this.scope(scope.chatId, scope.history.at(-1)?.revision ?? null);
    if (!isDeepStrictEqual(normalizedHistory(actual.history), normalizedHistory(scope.history))) reject('source ancestry or content changed');
  }

  private visibleRows(scope: MemoryScope, rows: Row[]): MemoryEntry[] {
    const visible = visibleMemoryEntries(scope, rows.map(row => JSON.parse(row.entry)));
    const visibleIds = new Set(visible.map(entry => entry.id));
    // Retirement metadata preserves the audit trail; a replacement supersedes only in its own ancestry.
    const replaced = new Set(rows.filter(row => row.replaces_id && visibleIds.has(JSON.parse(row.entry).id)).map(row => row.replaces_id));
    return visible.filter(entry => !replaced.has(entry.id));
  }

  /** Author declarations have no extractor dependency; keep this separate to avoid freshness recursion. */
  private authoredEntries(scope: MemoryScope): MemoryEntry[] {
    const rows = this.db.prepare('SELECT entry,replaces_id FROM story_memories WHERE chat_id=? AND job_id IS NULL ORDER BY rowid').all(scope.chatId) as Row[];
    return this.visibleRows(scope, rows).filter(entry => entry.kind === 'author-canon');
  }

  private currentJob(job: Row): boolean {
    try {
      if (job.kind !== 'memory' || typeof job.snapshot !== 'string') return false;
      const snapshot = JSON.parse(job.snapshot);
      if (snapshot.chatId !== job.chat_id || !Array.isArray(snapshot.history) || typeof snapshot.story?.canonHash !== 'string') return false;
      const source = this.store.source(job.source_revision);
      if (source.chatId !== job.chat_id || source.hash !== job.source_hash || source.parentRevision !== snapshot.parentRevision) return false;
      const scope = this.scope(job.chat_id, source.parentRevision);
      if (!isDeepStrictEqual(normalizedHistory(scope.history), normalizedHistory(snapshot.history))) return false;
      return this.canonHash(scope) === snapshot.story.canonHash;
    } catch { return false; }
  }

  entries(scope: MemoryScope): MemoryEntry[] {
    this.verifyScope(scope);
    const rows = this.db.prepare("SELECT m.entry,m.replaces_id,m.job_id,j.chat_id,j.source_revision,j.source_hash,j.kind,j.snapshot FROM story_memories m LEFT JOIN story_jobs j ON j.id=m.job_id WHERE m.chat_id=? AND (m.job_id IS NULL OR j.status='completed') ORDER BY m.rowid").all(scope.chatId) as Row[];
    return this.visibleRows(scope, rows.filter(row => row.job_id === null || this.currentJob(row)));
  }

  checkpoint(scope: MemoryScope): MemoryCheckpoint {
    this.verifyScope(scope);
    const hashes = new Map(scope.history.map(item => [item.revision, memoryHash(item.text)]));
    const rows = this.db.prepare("SELECT i.source_revision AS revision,i.source_hash AS hash,j.* FROM story_indexes i JOIN story_jobs j ON j.id=i.job_id WHERE i.chat_id=? AND j.chat_id=i.chat_id AND j.source_revision=i.source_revision AND j.source_hash=i.source_hash AND j.kind='memory' AND j.status='completed' ORDER BY i.rowid").all(scope.chatId) as Row[];
    return { chatId: scope.chatId, indexed: rows.filter(row => hashes.get(row.revision) === row.hash && this.currentJob(row)).map(row => ({ revision: row.revision, hash: row.hash })) };
  }

  plan(scope: MemoryScope, config: StoryConfig['memory']) {
    const entries = this.entries(scope); const checkpoint = this.checkpoint(scope);
    return { entries, checkpoint, plan: planMemoryContext({ scope, entries, checkpoint, recentCount: config.recentCount, maxPacketChars: config.maxPacketChars }) };
  }

  canonHash(scope: MemoryScope): string {
    this.verifyScope(scope);
    const canon = this.authoredEntries(scope).sort((a, b) => a.id.localeCompare(b.id));
    return memoryHash(JSON.stringify(canon));
  }

  /** Called inside the host's short source/canon mutation transaction; never rewrites stored snapshots. */
  refreshValidityInTransaction(chatId: string): string[] {
    this.store.chat(chatId);
    const jobs = this.db.prepare("SELECT * FROM story_jobs WHERE chat_id=? AND kind='memory' AND status IN ('queued','running','completed')").all(chatId) as Row[];
    const stale: string[] = [];
    for (const job of jobs) {
      if (this.currentJob(job)) continue;
      this.db.prepare("UPDATE story_jobs SET status='stale',generation=generation+1,owner=NULL,error='Memory source ancestry or authored canon changed',updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
      this.store.event(chatId, 'story.job.stale', job.id); stale.push(job.id);
    }
    return stale;
  }

  completeInTransaction(jobId: string, chatId: string, source: { id: string; hash: string; text: string }, history: MemoryHistoryItem[], entries: unknown[]): MemoryEntry[] {
    const job = this.db.prepare('SELECT * FROM story_jobs WHERE id=?').get(jobId) as Row | undefined;
    if (!job || job.chat_id !== chatId || job.source_revision !== source.id || job.source_hash !== source.hash || job.kind !== 'memory' || job.status !== 'running') reject('job ownership or source mismatch');
    if (!this.currentJob(job!)) reject('job semantic dependencies changed');
    const actual = this.store.source(source.id);
    if (actual.chatId !== chatId || actual.hash !== source.hash || actual.text !== source.text || memoryHash(source.text) !== source.hash) reject('source content changed');
    const scope: MemoryScope = { chatId, history };
    if (history.at(-1)?.revision !== source.id) reject('history must end at job source');
    this.verifyScope(scope);
    if (!Array.isArray(entries) || entries.length > 1000) reject('invalid entries');
    // Validate everything before the first insert. Never let extractor-provided IDs select existing rows.
    const validated = entries.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('invalid entry');
      const entry = validateMemoryEntry({ ...raw, id: randomUUID() }, scope);
      if (entry.kind === 'author-canon') reject('extractor cannot author canon');
      if (entry.atRevision !== source.id || entry.atHash !== source.hash) reject('entry must anchor to job source');
      const snapshot=JSON.parse(job!.snapshot);
      if(!hiddenMemoryEntryAllowed({...snapshot,history},entry))reject('entry evidence is excluded from this request');
      return entry;
    });
    const prior = this.db.prepare('SELECT i.job_id,j.* FROM story_indexes i JOIN story_jobs j ON j.id=i.job_id WHERE i.chat_id=? AND i.source_revision=? AND i.source_hash=?').get(chatId, source.id, source.hash) as Row | undefined;
    if (prior && (prior.job_id === jobId || (!['stale', 'failed', 'interrupted'].includes(prior.status) && this.currentJob(prior)))) reject('source already indexed');
    for (const entry of validated) this.db.prepare('INSERT INTO story_memories(id,chat_id,job_id,entry,retired_at,replaces_id) VALUES(?,?,?,?,NULL,NULL)').run(entry.id, chatId, jobId, JSON.stringify(entry));
    this.db.prepare('INSERT INTO story_indexes(chat_id,source_revision,source_hash,job_id) VALUES(?,?,?,?) ON CONFLICT(chat_id,source_revision,source_hash) DO UPDATE SET job_id=excluded.job_id').run(chatId, source.id, source.hash, jobId);
    return validated;
  }

  authored(chatId: string, input: { text: string; author: string; branchId?: string }, replacesId?: string): MemoryEntry {
    return this.store.transaction(() => {
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['text', 'author', 'branchId'].includes(key)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000 || typeof input.author !== 'string' || !input.author.trim() || input.author.length > 200) reject('invalid authored declaration');
      const branch = this.store.product.branch(chatId, input.branchId);
      const scope = this.scope(chatId, branch.headRevision);
      if (replacesId !== undefined) {
        const prior = this.entries(scope).find(entry => entry.id === replacesId);
        if (!prior || prior.kind !== 'author-canon') reject('replacement declaration outside current scope');
      }
      const anchor = scope.history.at(-1);
      const entry = validateMemoryEntry({ id: randomUUID(), chatId, kind: 'author-canon', atRevision: anchor?.revision ?? null, atHash: anchor ? memoryHash(anchor.text) : null, text: input.text, declaration: { author: input.author, text: input.text } }, scope);
      if (replacesId !== undefined) this.db.prepare('UPDATE story_memories SET retired_at=? WHERE id=? AND chat_id=? AND retired_at IS NULL').run(new Date().toISOString(), replacesId, chatId);
      this.db.prepare('INSERT INTO story_memories(id,chat_id,job_id,entry,retired_at,replaces_id) VALUES(?,?,NULL,?,NULL,?)').run(entry.id, chatId, JSON.stringify(entry), replacesId ?? null);
      this.refreshValidityInTransaction(chatId);
      this.store.event(chatId, 'story.memory.updated', entry.id);
      return entry;
    });
  }
}
