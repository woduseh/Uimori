import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { imageDataHashes, planUnusedData, type UnusedDataPlan } from './unused-data-scan.js';
import type { Store } from './store.js';

export { imageDataHashes };

export function queueImageCleanup(db: DatabaseSync, candidates: Iterable<string>): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO image_cleanup_candidates(hash) SELECT hash FROM image_blobs WHERE hash=?'
  );
  for (const hash of candidates) insert.run(hash);
}

const cleanupPending = (db: DatabaseSync) =>
  !!(
    db.prepare('SELECT 1 FROM image_cleanup_candidates LIMIT 1').get() ||
    db.prepare("SELECT 1 FROM app_metadata WHERE key='image-cleanup-needed'").get()
  );

const workActive = (db: DatabaseSync) =>
  [
    'runs',
    'jobs',
    'context_jobs',
    'helper_tasks',
    'helper_artifact_jobs',
    'illustration_jobs',
    'attempts',
    'provider_connection_tests',
  ].some(
    (table) =>
      !!db.prepare(`SELECT 1 FROM ${table} WHERE status IN ('queued','running') LIMIT 1`).get()
  );

function applyUnusedDataPlan(db: DatabaseSync, plan: UnusedDataPlan): void {
  for (const { kind, id } of plan.hidden) {
    if (kind === 'asset') db.prepare('DELETE FROM assets WHERE id=?').run(id);
    else
      db.prepare(
        `DELETE FROM ${kind === 'connection' || kind === 'model' ? 'provider_settings' : 'versions'} WHERE kind=? AND id=?`
      ).run(kind, id);
    db.prepare('DELETE FROM resource_undo WHERE kind=? AND id=?').run(kind, id);
    db.prepare('DELETE FROM library_hidden WHERE kind=? AND id=?').run(kind, id);
  }
  db.prepare('DELETE FROM image_blobs WHERE hash IN (SELECT value FROM json_each(?))').run(
    JSON.stringify(plan.images)
  );
  db.exec('DELETE FROM image_cleanup_candidates');
  db.prepare("DELETE FROM app_metadata WHERE key='image-cleanup-needed'").run();
}

function cleanupReady(db: DatabaseSync): boolean {
  if (
    !db.prepare('SELECT 1 FROM image_cleanup_candidates LIMIT 1').get() &&
    !db.prepare('SELECT 1 FROM library_hidden LIMIT 1').get()
  ) {
    db.prepare("DELETE FROM app_metadata WHERE key='image-cleanup-needed'").run();
    return false;
  }
  db.prepare("INSERT OR REPLACE INTO app_metadata VALUES('image-cleanup-needed','1')").run();
  return !workActive(db);
}

export function pruneUnusedData(db: DatabaseSync, candidates: Iterable<string> | null = []): void {
  if (candidates === null)
    db.exec('INSERT OR IGNORE INTO image_cleanup_candidates SELECT hash FROM image_blobs');
  else queueImageCleanup(db, candidates);
  if (cleanupReady(db)) applyUnusedDataPlan(db, planUnusedData(db));
}

export function flushPendingImageCleanup(db: DatabaseSync): void {
  if (cleanupPending(db)) pruneUnusedData(db);
}

export class PendingImageCleanup {
  private running: Promise<void> | null = null;
  private worker?: Worker;
  private closed = false;
  private readonly store: Pick<Store, 'db' | 'path' | 'transaction'>;
  constructor(store: Pick<Store, 'db' | 'path' | 'transaction'>) {
    this.store = store;
  }
  private plan(): Promise<UnusedDataPlan> {
    return new Promise((resolve, reject) => {
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      const worker = new Worker(new URL(`./unused-data-scan.${extension}`, import.meta.url), {
        workerData: { unusedDataPath: this.store.path },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      this.worker = worker;
      worker.once('message', (message: { plan?: UnusedDataPlan }) =>
        message.plan ? resolve(message.plan) : reject(new Error('IMAGE_CLEANUP_SCAN_FAILED'))
      );
      worker.once('error', reject);
      worker.once('exit', () => {
        if (this.worker === worker) this.worker = undefined;
        reject(new Error('IMAGE_CLEANUP_SCAN_STOPPED'));
      });
    });
  }
  private changes(): number {
    return Number(this.store.db.prepare('SELECT total_changes() AS n').get()!.n);
  }
  flush(): Promise<void> {
    const db = this.store.db;
    if (this.running) return this.running;
    if (this.closed || db.isTransaction || !cleanupPending(db) || !cleanupReady(db))
      return Promise.resolve();
    const observed = this.changes();
    this.running = this.plan()
      .then((plan) => {
        if (this.closed) return;
        this.store.transaction(() => {
          if (this.changes() === observed) applyUnusedDataPlan(db, plan);
        });
      })
      .catch(() => {
        if (!this.closed) process.stderr.write('IMAGE_CLEANUP_DEFERRED\n');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  async close() {
    this.closed = true;
    await this.worker?.terminate();
    await this.running?.catch(() => {});
  }
}
