import { createReadStream, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';
import type {
  BackupManifest,
  BackupSettings,
  BackupStatus,
  BackupStatusCode,
} from '../core/backups.js';
import { APP_VERSION } from './app-version.js';
import { DATABASE_SCHEMA_VERSION } from './database-schema.js';
import { createDatabaseSnapshot } from './database-backup.js';
import { personalWorkspaceEndpoints } from '#contracts';
import {
  nonBlank,
  personalWorkspaceOperations,
  type UpdateBackupSettings,
} from '#contracts/operations';
import { HttpError } from './request-validation.js';
import { AppError, assertRevision } from './app-errors.js';
import { registerEndpoint, registerRawRoute } from './endpoint.js';
import type { Store } from './store.js';

const SETTINGS = 'scheduled-backup-settings';
const STATE = 'scheduled-backup-state';
const ID = /^backup-\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
const defaults: BackupSettings = {
  revision: 0,
  enabled: false,
  hour: 3,
  minute: 0,
  retain: 7,
  nextRunAt: null,
};
type SavedState = Pick<BackupStatus, 'status' | 'lastSuccess' | 'error' | 'warning'>;

export function nextBackupAt(now: Date, hour: number, minute: number): string {
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let at = Date.UTC(
    korea.getUTCFullYear(),
    korea.getUTCMonth(),
    korea.getUTCDate(),
    hour - 9,
    minute
  );
  if (at <= now.getTime()) at += 24 * 60 * 60 * 1000;
  return new Date(at).toISOString();
}
async function syncDirectory(path: string) {
  // Windows does not support opening/fsync'ing directories like Unix does.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncFile(path: string) {
  // https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers#parameters (2026-11-20):
  // the handle passed to FlushFileBuffers must have the GENERIC_WRITE access right.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function verifySnapshot(
  path: string
): Promise<Pick<BackupManifest, 'schema' | 'bytes' | 'sha256'>> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new Promise((accept, reject) => {
    const worker = new Worker(new URL(`./backup-verify-worker.${extension}`, import.meta.url), {
      workerData: { path, maxSchema: DATABASE_SCHEMA_VERSION },
      execArgv: [],
    });
    let answered = false;
    worker.once('message', (value) => {
      answered = true;
      accept(value);
    });
    worker.once('error', () => reject(new Error('BACKUP_VERIFICATION_FAILED')));
    worker.once('exit', (code) => {
      if (!answered)
        reject(new Error(code ? 'BACKUP_VERIFICATION_FAILED' : 'BACKUP_VERIFICATION_INCOMPLETE'));
    });
  });
}
function errorCode(error: unknown): BackupStatusCode {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENOSPC') return 'BACKUP_DISK_FULL';
  if (code === 'EACCES' || code === 'EPERM') return 'BACKUP_PERMISSION_DENIED';
  return 'BACKUP_FAILED';
}

export class BackupService {
  readonly directory: string;
  private active: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private state: SavedState;
  get isActive(): boolean {
    return this.active !== null;
  }
  private readonly store: Store;
  private readonly buildId: string;
  private readonly canRun: () => boolean;
  constructor(
    store: Store,
    buildId: string,
    directory?: string,
    canRun: () => boolean = () => true
  ) {
    this.store = store;
    this.buildId = buildId;
    this.canRun = canRun;
    this.directory = resolve(directory ?? join(dirname(store.path), 'backups'));
    this.state = this.load<SavedState>(STATE) ?? {
      status: 'idle',
      lastSuccess: null,
      error: null,
      warning: null,
    };
    if (this.state.status === 'running') {
      this.state = {
        ...this.state,
        status: 'failed',
        error: 'BACKUP_INTERRUPTED',
      };
    }
  }
  private load<T>(key: string): T | null {
    const row = this.store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key);
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }
  private save(key: string, value: unknown) {
    this.store.db
      .prepare(
        'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, JSON.stringify(value));
  }
  settings(): BackupSettings {
    return this.load<BackupSettings>(SETTINGS) ?? { ...defaults };
  }
  update({
    expectedRevision,
    enabled,
    hour,
    minute,
    retain,
  }: UpdateBackupSettings): BackupSettings {
    const current = this.settings();
    assertRevision(current.revision, expectedRevision);
    const changedSchedule = !current.enabled || current.hour !== hour || current.minute !== minute;
    const next: BackupSettings = {
      revision: current.revision + 1,
      enabled,
      hour,
      minute,
      retain,
      nextRunAt: enabled
        ? changedSchedule
          ? nextBackupAt(new Date(), hour, minute)
          : current.nextRunAt
        : null,
    };
    this.save(SETTINGS, next);
    return next;
  }
  async list(): Promise<BackupManifest[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AppError(503, 'BACKUP_LIST_UNAVAILABLE');
    }
    const result: BackupManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      try {
        const root = join(this.directory, entry.name);
        const manifestFile = join(root, 'manifest.json');
        const info = await lstat(manifestFile);
        if (!info.isFile() || info.size > 8192) continue;
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as BackupManifest;
        const data = await lstat(join(root, 'uimori.sqlite'));
        if (
          manifest.format === 'uimori-snapshot-v1' &&
          manifest.id === entry.name &&
          data.isFile() &&
          data.size === manifest.bytes &&
          /^[a-f0-9]{64}$/.test(manifest.sha256) &&
          Number.isFinite(Date.parse(manifest.createdAt))
        )
          result.push(manifest);
      } catch {}
    }
    return result.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );
  }
  async status(): Promise<BackupStatus> {
    return {
      ...this.state,
      status: this.active ? 'running' : this.state.status,
      settings: this.settings(),
      backups: await this.list(),
    };
  }
  async download(id: string) {
    if (!ID.test(id) || !(await this.list()).some((entry) => entry.id === id))
      throw new HttpError(404, 'Backup not found');
    return createReadStream(join(this.directory, id, 'uimori.sqlite'));
  }
  start(scheduled = false, now = new Date()): void {
    if (this.closed || !this.canRun()) throw new AppError(503, 'BACKUP_UNAVAILABLE');
    if (this.active) throw new AppError(409, 'BACKUP_RUNNING');
    if (scheduled) {
      const settings = this.settings();
      this.save(SETTINGS, {
        ...settings,
        nextRunAt: nextBackupAt(now, settings.hour, settings.minute),
      });
    }
    this.state = { ...this.state, status: 'running', error: null, warning: null };
    this.save(STATE, this.state);
    this.active = this.create()
      .catch(() => {
        this.state = {
          ...this.state,
          status: 'failed',
          error: 'BACKUP_STATE_UNRECORDED',
        };
      })
      .finally(() => {
        this.active = null;
      });
  }
  private async create(): Promise<void> {
    const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
    const id = `backup-${stamp}-${randomUUID()}`;
    const staging = join(this.directory, `.partial-${id}`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const space = await statfs(this.directory, { bigint: true });
      const pages = BigInt(Number(this.store.db.prepare('PRAGMA page_count').get()!.page_count));
      const pageSize = BigInt(Number(this.store.db.prepare('PRAGMA page_size').get()!.page_size));
      if (space.bavail * space.bsize < pages * pageSize + 16n * 1024n * 1024n) {
        throw Object.assign(new Error('Insufficient backup space'), { code: 'ENOSPC' });
      }
      await mkdir(staging, { mode: 0o700 });
      const path = join(staging, 'uimori.sqlite');
      await createDatabaseSnapshot(this.store, path);
      await chmod(path, 0o600);
      await syncFile(path);
      const verified = await verifySnapshot(path);
      const manifest: BackupManifest = {
        format: 'uimori-snapshot-v1',
        id,
        createdAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        buildId: this.buildId,
        ...verified,
      };
      const handle = await open(join(staging, 'manifest.json'), 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(staging);
      await rename(staging, join(this.directory, id));
      await syncDirectory(this.directory);
      this.state = { status: 'idle', lastSuccess: manifest, error: null, warning: null };
      this.save(STATE, this.state);
      try {
        for (const older of (await this.list()).slice(this.settings().retain)) {
          if (older.id !== id) await rm(join(this.directory, older.id), { recursive: true });
        }
      } catch {
        this.state.warning = 'BACKUP_PRUNE_INCOMPLETE';
      }
      this.save(STATE, this.state);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      this.state = { ...this.state, status: 'failed', error: errorCode(error) };
      this.save(STATE, this.state);
    }
  }
  tick(now = new Date()) {
    const settings = this.settings();
    if (
      !this.closed &&
      !this.active &&
      this.canRun() &&
      settings.enabled &&
      settings.nextRunAt &&
      settings.nextRunAt <= now.toISOString()
    )
      this.start(true, now);
  }
  listen() {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        this.state.error = 'BACKUP_SCHEDULE_FAILED';
        this.state.status = 'failed';
      }
    }, 60_000);
    this.timer.unref();
    try {
      this.tick();
    } catch {
      this.state.error = 'BACKUP_SCHEDULE_FAILED';
      this.state.status = 'failed';
    }
  }
  async settle() {
    await this.active;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.settle();
  }
}
const backupDownloadInput = z.strictObject({ id: nonBlank(100) });

export function backupRoutes(app: FastifyInstance, service: BackupService) {
  registerEndpoint(
    app,
    personalWorkspaceEndpoints.readBackups,
    personalWorkspaceOperations.readBackups,
    () => service.status()
  );
  registerEndpoint(
    app,
    personalWorkspaceEndpoints.updateBackupSettings,
    personalWorkspaceOperations.updateBackupSettings,
    (input) => service.update(input)
  );
  registerEndpoint(
    app,
    personalWorkspaceEndpoints.startBackup,
    personalWorkspaceOperations.startBackup,
    () => {
      service.start();
      return { status: 'running' as const };
    }
  );
  registerRawRoute(
    app,
    {
      method: 'GET',
      url: '/api/backups/:id/download',
      cache: 'no-store',
      input: backupDownloadInput,
    },
    async ({ id }, _request, reply) => {
      const stream = await service.download(id);
      return reply
        .type('application/vnd.sqlite3')
        .header('Content-Disposition', `attachment; filename="${id}.sqlite"`)
        .send(stream);
    }
  );
}
