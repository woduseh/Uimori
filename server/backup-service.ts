import { createReadStream, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import type { BackupManifest, BackupSettings, BackupStatus } from '../core/backups.js';
import { APP_VERSION } from './app-version.js';
import { DATABASE_SCHEMA_VERSION } from './database-schema.js';
import { createDatabaseSnapshot } from './database-backup.js';
import { HttpError, fields, record } from './request-validation.js';
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

/** A daily wall time in Korea; no cron language or host timezone dependency. */
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
function errorCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENOSPC') return '저장 공간이 부족해요. 기존 백업은 유지했어요.';
  if (code === 'EACCES' || code === 'EPERM') return '백업 저장 위치에 쓸 권한이 없어요.';
  return '백업을 완성하지 못했어요. 기존 백업은 유지했어요. 저장 공간과 권한을 확인해 주세요.';
}

export class BackupService {
  readonly directory: string;
  private active: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private state: SavedState;
  constructor(
    private readonly store: Store,
    private readonly buildId: string,
    directory?: string,
    private readonly canRun: () => boolean = () => true
  ) {
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
        error: '이전 백업이 중단됐어요. 완성된 백업만 목록에 표시해요.',
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
  update(value: unknown): BackupSettings {
    const body = record(value);
    fields(body, ['expectedRevision', 'enabled', 'hour', 'minute', 'retain']);
    const current = this.settings();
    if (body.expectedRevision !== current.revision)
      throw new HttpError(409, 'BACKUP_SETTINGS_CHANGED');
    if (typeof body.enabled !== 'boolean')
      throw new HttpError(400, '백업 사용 여부를 확인해 주세요.');
    for (const [key, maximum, minimum] of [
      ['hour', 23, 0],
      ['minute', 59, 0],
      ['retain', 30, 1],
    ] as const) {
      if (
        !Number.isInteger(body[key]) ||
        Number(body[key]) < minimum ||
        Number(body[key]) > maximum
      )
        throw new HttpError(400, '백업 시간이나 보관 개수를 확인해 주세요.');
    }
    const changedSchedule =
      !current.enabled || current.hour !== body.hour || current.minute !== body.minute;
    const next: BackupSettings = {
      revision: current.revision + 1,
      enabled: body.enabled,
      hour: Number(body.hour),
      minute: Number(body.minute),
      retain: Number(body.retain),
      nextRunAt: body.enabled
        ? changedSchedule
          ? nextBackupAt(new Date(), Number(body.hour), Number(body.minute))
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
      throw new HttpError(503, '백업 목록을 읽지 못했어요. 저장 위치와 권한을 확인해 주세요.');
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
      } catch {
        /* Incomplete or unrelated directories are never advertised or deleted. */
      }
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
      throw new HttpError(404, '백업을 찾지 못했어요.');
    return createReadStream(join(this.directory, id, 'uimori.sqlite'));
  }
  start(scheduled = false, now = new Date()): void {
    if (this.closed || !this.canRun()) throw new HttpError(503, '백업을 시작할 수 없는 상태예요.');
    if (this.active) throw new HttpError(409, '이미 백업을 만들고 있어요.');
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
          error: '백업 상태를 기록하지 못했어요. 저장 공간을 확인해 주세요.',
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
      // Retention only follows a durable new success and only owns validated snapshot folders.
      try {
        for (const older of (await this.list()).slice(this.settings().retain)) {
          if (older.id !== id) await rm(join(this.directory, older.id), { recursive: true });
        }
      } catch {
        this.state.warning = '새 백업은 저장했지만 오래된 백업 일부를 정리하지 못했어요.';
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
        this.state.error = '예약 백업을 시작하지 못했어요.';
        this.state.status = 'failed';
      }
    }, 60_000);
    this.timer.unref();
    try {
      this.tick();
    } catch {
      this.state.error = '예약 백업을 시작하지 못했어요.';
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
export function backupRoutes(app: FastifyInstance, service: BackupService) {
  app.get('/api/backups', () => service.status());
  app.put('/api/backups/settings', (request) => service.update(request.body));
  app.post('/api/backups', async (request, reply) => {
    fields(record(request.body ?? {}), []);
    service.start();
    return reply.code(202).send({ status: 'running' });
  });
  app.get<{ Params: { id: string } }>('/api/backups/:id/download', async (request, reply) => {
    const stream = await service.download(request.params.id);
    return reply
      .type('application/vnd.sqlite3')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${request.params.id}.sqlite"`)
      .send(stream);
  });
}
