import { pushAllowed } from '../core/push.js';
import { createHash, randomUUID } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import type { FastifyInstance } from 'fastify';
import type { PushInfo, PushPreferences, PushEnvelope, PushDeviceError } from '../core/push.js';
import { personalWorkspaceEndpoints } from '#contracts';
import {
  personalWorkspaceOperations,
  type SubscribePush,
  type UnsubscribePush,
  type UpdatePush,
} from '#contracts/operations';
import {
  sendWebPush,
  validatePushSubscription,
  type PushSender,
  type VapidKeys,
} from './push-transport.js';
import { HttpError } from './request-validation.js';
import { AppError, assertRevision } from './app-errors.js';
import { registerEndpoint } from './endpoint.js';
import type { Store } from './store.js';

type Options = {
  origin?: string;
  sessionHash: (cookie?: string) => string | null;
  canSend: () => boolean;
  sender?: PushSender;
  now?: () => number;
};
const KEYS = 'push-vapid-keys';

export class PushService {
  private closed = false;
  private pending: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, AbortController>();
  private readonly sender: PushSender;
  private readonly now: () => number;
  private readonly store: Store;
  private readonly options: Options;
  constructor(store: Store, options: Options) {
    this.store = store;
    this.options = options;
    this.sender = options.sender ?? sendWebPush;
    this.now = options.now ?? Date.now;
  }
  private keys(): VapidKeys | null {
    const row = this.store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(KEYS);
    return row ? (JSON.parse(String(row.value)) as VapidKeys) : null;
  }
  private authority(cookie?: string): string {
    if (!this.options.origin?.startsWith('https://'))
      throw new HttpError(409, 'Push requires an HTTPS origin');
    const session = this.options.sessionHash(cookie);
    if (!session) throw new HttpError(401, 'Push requires a signed-in session');
    return session;
  }
  private device(clientId: string, session: string) {
    return this.store.db
      .prepare('SELECT * FROM push_subscriptions WHERE client_id=? AND session_hash=? AND origin=?')
      .get(clientId, session, this.options.origin!);
  }
  info(id: string, cookie?: string): PushInfo {
    const session = this.options.sessionHash(cookie);
    const available = !!this.options.origin?.startsWith('https://') && !!session;
    const device = available ? this.device(id, session!) : undefined;
    return {
      available,
      publicKey: available ? (this.keys()?.publicKey ?? null) : null,
      device: device
        ? {
            revision: Number(device.revision),
            preferences: JSON.parse(String(device.preferences)),
            lastError: device.last_error == null ? null : String(device.last_error),
          }
        : null,
    };
  }
  prepare(clientId: string, cookie?: string): PushInfo {
    this.authority(cookie);
    if (!this.keys())
      this.store.db
        .prepare('INSERT INTO app_metadata(key,value) VALUES(?,?)')
        .run(KEYS, JSON.stringify(generateVAPIDKeys()));
    return this.info(clientId, cookie);
  }
  subscribe(
    {
      clientId: id,
      expectedRevision,
      subscription: requested,
      preferences: choices,
    }: SubscribePush,
    cookie?: string
  ): PushInfo {
    const session = this.authority(cookie);
    if (!this.keys()) throw new HttpError(409, 'Push keys are not prepared');
    const subscription = validatePushSubscription(requested);
    this.store.transaction(() => {
      const current = this.device(id, session);
      assertRevision(current ? Number(current.revision) : 0, expectedRevision);
      const now = new Date(this.now()).toISOString();
      const previous = this.store.db
        .prepare('SELECT id FROM push_subscriptions WHERE endpoint=?')
        .get(subscription.endpoint);
      for (const old of [current, previous]) {
        if (!old) continue;
        this.active.get(String(old.id))?.abort();
        this.store.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(old.id);
      }
      this.store.db
        .prepare(`INSERT INTO push_subscriptions(id,client_id,session_hash,endpoint,keys,preferences,origin,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(
          randomUUID(),
          id,
          session,
          subscription.endpoint,
          JSON.stringify(subscription.keys),
          JSON.stringify(choices),
          this.options.origin!,
          expectedRevision + 1,
          now,
          now
        );
    });
    return this.info(id, cookie);
  }
  update(
    { clientId: id, expectedRevision, preferences: choices }: UpdatePush,
    cookie?: string
  ): PushInfo {
    const session = this.authority(cookie);
    const current = this.device(id, session);
    if (!current) throw new AppError(409, 'REVISION_CONFLICT');
    assertRevision(Number(current.revision), expectedRevision);
    this.store.db
      .prepare(
        'UPDATE push_subscriptions SET preferences=?,revision=revision+1,updated_at=? WHERE id=?'
      )
      .run(JSON.stringify(choices), new Date(this.now()).toISOString(), current.id);
    return this.info(id, cookie);
  }
  unsubscribe({ clientId: id, expectedRevision }: UnsubscribePush, cookie?: string): PushInfo {
    const session = this.authority(cookie);
    const current = this.device(id, session);
    if (current) assertRevision(Number(current.revision), expectedRevision);
    if (current) {
      this.active.get(String(current.id))?.abort();
      this.store.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(current.id);
    }
    return this.info(id, cookie);
  }
  test(clientId: string, cookie?: string) {
    const session = this.authority(cookie);
    const current = this.device(clientId, session);
    if (!current) throw new AppError(409, 'REVISION_CONFLICT');
    const now = new Date(this.now()).toISOString();
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM push_outbox WHERE subscription_id=? AND kind='test' AND created_at>? LIMIT 1"
        )
        .get(current.id, new Date(this.now() - 30_000).toISOString())
    )
      throw new AppError(429, 'PUSH_TEST_RATE_LIMITED');
    this.store.db
      .prepare(
        `INSERT INTO push_outbox(subscription_id,event_key,kind,next_at,expires_at,created_at) VALUES(?,?,'test',?,?,?)`
      )
      .run(
        current.id,
        `test:${randomUUID()}`,
        now,
        new Date(this.now() + 120_000).toISOString(),
        now
      );
    return { status: 'queued' as const };
  }
  revokeInactive() {
    for (const [id, controller] of this.active) {
      if (
        !this.store.db
          .prepare(
            'SELECT 1 FROM push_subscriptions p JOIN access_sessions s ON s.token_hash=p.session_hash WHERE p.id=?'
          )
          .get(id)
      )
        controller.abort();
    }
  }
  private async deliver(): Promise<void> {
    if (!this.options.canSend() || this.closed) return;
    const db = this.store.db,
      now = new Date(this.now()).toISOString();
    db.prepare(
      "UPDATE push_outbox SET status='expired' WHERE status IN ('pending','sending') AND expires_at<=?"
    ).run(now);
    db.prepare(
      "DELETE FROM push_outbox WHERE status NOT IN ('pending','sending') AND created_at<?"
    ).run(new Date(this.now() - 7 * 86400_000).toISOString());
    const keys = this.keys();
    if (!keys) return;
    const due = db
      .prepare(
        "SELECT id FROM push_outbox WHERE status='pending' AND next_at<=? AND expires_at>? ORDER BY id LIMIT 4"
      )
      .all(now, now);
    for (const item of due) {
      if (this.closed || !this.options.canSend()) break;
      const row = db
        .prepare(`SELECT o.*,p.endpoint,p.keys,p.preferences,p.origin FROM push_outbox o JOIN push_subscriptions p ON p.id=o.subscription_id
        JOIN access_sessions s ON s.token_hash=p.session_hash WHERE o.id=? AND o.status='pending'`)
        .get(item.id);
      if (!row) continue;
      const choices = JSON.parse(String(row.preferences)) as PushPreferences;
      if (
        row.origin !== this.options.origin ||
        !pushAllowed(String(row.kind), String(row.event_key), choices)
      ) {
        db.prepare("UPDATE push_outbox SET status='cancelled' WHERE id=?").run(row.id);
        continue;
      }
      const claimed = db
        .prepare(
          "UPDATE push_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'"
        )
        .run(row.id);
      if (!claimed.changes) continue;
      const title =
        choices.showTitle && row.chat_id
          ? db.prepare('SELECT title FROM chats WHERE id=?').get(row.chat_id)?.title
          : undefined;
      const envelope: PushEnvelope = {
        version: 1,
        kind: row.kind as PushEnvelope['kind'],
        tag: `uimori-${createHash('sha256').update(String(row.event_key)).digest('hex').slice(0, 24)}`,
        chatId: row.chat_id == null ? null : String(row.chat_id),
        sourceId: row.source_id == null ? null : String(row.source_id),
        representation: row.representation === 'translation' ? 'translation' : 'original',
        ...(typeof title === 'string' ? { title: title.slice(0, 120) } : {}),
      };
      const controller = new AbortController();
      this.active.set(String(row.subscription_id), controller);
      let status = 0,
        retryAfter = 0;
      try {
        const result = await this.sender(
          { endpoint: String(row.endpoint), keys: JSON.parse(String(row.keys)) },
          envelope,
          keys,
          this.options.origin!,
          Math.max(1, (Date.parse(String(row.expires_at)) - this.now()) / 1000),
          AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
        );
        status = result.status;
        retryAfter = result.retryAfterSeconds ?? 0;
      } catch {
      } finally {
        this.active.delete(String(row.subscription_id));
      }
      if (status >= 200 && status < 300) {
        db.prepare("UPDATE push_outbox SET status='sent' WHERE id=?").run(row.id);
        db.prepare('UPDATE push_subscriptions SET last_error=NULL WHERE id=?').run(
          row.subscription_id
        );
      } else if (status === 404 || status === 410)
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.subscription_id);
      else {
        const attempts = Number(row.attempts) + 1;
        const retryable =
          (status === 0 || status === 429 || status >= 500) && attempts < 3 && !this.closed;
        const wait = Math.max(retryAfter, attempts === 1 ? 30 : 120);
        const next = new Date(this.now() + Math.min(wait, 600) * 1000).toISOString();
        const retry = retryable && next < String(row.expires_at);
        db.prepare('UPDATE push_outbox SET status=?,next_at=? WHERE id=?').run(
          retry ? 'pending' : this.closed ? 'pending' : 'failed',
          next,
          row.id
        );
        db.prepare('UPDATE push_subscriptions SET last_error=? WHERE id=?').run(
          (retry ? 'PUSH_RETRYING' : 'PUSH_DELIVERY_FAILED') satisfies PushDeviceError,
          row.subscription_id
        );
      }
    }
  }
  tick(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve();
    this.pending = this.deliver().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  listen() {
    if (!this.options.origin) return;
    this.store.db
      .prepare('DELETE FROM push_subscriptions WHERE origin!=?')
      .run(this.options.origin);
    this.store.db.prepare("UPDATE push_outbox SET status='pending' WHERE status='sending'").run();
    const tick = () => {
      void this.tick().catch(() => {});
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
    await this.pending?.catch(() => {});
  }
}
export function pushRoutes(app: FastifyInstance, service: PushService) {
  const endpoints = personalWorkspaceEndpoints;
  const operations = personalWorkspaceOperations;
  registerEndpoint(app, endpoints.readPush, operations.readPush, ({ clientId }, request) =>
    service.info(clientId, request.headers.cookie)
  );
  registerEndpoint(app, endpoints.preparePush, operations.preparePush, ({ clientId }, request) =>
    service.prepare(clientId, request.headers.cookie)
  );
  registerEndpoint(app, endpoints.subscribePush, operations.subscribePush, (input, request) =>
    service.subscribe(input, request.headers.cookie)
  );
  registerEndpoint(app, endpoints.updatePush, operations.updatePush, (input, request) =>
    service.update(input, request.headers.cookie)
  );
  registerEndpoint(app, endpoints.unsubscribePush, operations.unsubscribePush, (input, request) =>
    service.unsubscribe(input, request.headers.cookie)
  );
  registerEndpoint(app, endpoints.testPush, operations.testPush, ({ clientId }, request) =>
    service.test(clientId, request.headers.cookie)
  );
}
