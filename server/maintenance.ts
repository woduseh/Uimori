import type { FastifyInstance } from 'fastify';
import { fields, record, text, HttpError } from './request-validation.js';
import type { Store } from './store.js';

export type MaintenanceState = {
  /** `closed` blocks new user writes and new external work while reads stay available. */
  status: 'open' | 'closed';
  /** Increments once per maintenance period, so a resumed worker can tell periods apart. */
  epoch: number;
  reason?: string;
  updatedAt: string;
};
type Row = Record<string, unknown>;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Control, sign-in, local diagnostics and stopping already-admitted work stay available. */
const ALWAYS_ADMITTED = new Set([
  '/api/maintenance',
  '/api/session',
  '/api/diagnostics/report',
  '/api/test/control',
  '/api/runs/:id/cancel',
  '/api/runs/:id/skip-state-wait',
  '/api/runs/:id/skip-package-preparation',
  '/api/runs/:id/skip-package-after-response',
  '/api/chats/:id/extension-operations/:operationId/cancel',
  '/api/jobs/:id/cancel',
  '/api/illustrations/:id/cancel',
  '/api/story-jobs/:id/cancel',
  '/api/scene-commands/:id/cancel',
  '/api/helper/tasks/:id/cancel',
]);

/** The schema migration owns the table; a boot only seeds the single row it expects. */
export function initMaintenance(store: Store) {
  if (!store.db.prepare('SELECT 1 FROM maintenance WHERE id=1').get())
    store.db
      .prepare('INSERT INTO maintenance VALUES(1,0,?,NULL,?)')
      .run('open', new Date().toISOString());
}

export function maintenanceState(store: Store): MaintenanceState {
  const row = store.db.prepare('SELECT * FROM maintenance WHERE id=1').get() as Row | undefined;
  if (!row) return { status: 'open', epoch: 0, updatedAt: new Date(0).toISOString() };
  return {
    status: row.status === 'closed' ? 'closed' : 'open',
    epoch: Number(row.epoch),
    ...(typeof row.reason === 'string' && row.reason ? { reason: row.reason } : {}),
    updatedAt: String(row.updated_at),
  };
}

/** A closed gate survives restarts: an interrupted update never reopens writes on its own. */
export function setMaintenance(
  store: Store,
  next: { closed: boolean; reason?: string }
): MaintenanceState {
  return store.transaction(() => {
    const current = maintenanceState(store);
    if (next.closed === (current.status === 'closed')) return current;
    const epoch = next.closed ? current.epoch + 1 : current.epoch;
    store.db
      .prepare('UPDATE maintenance SET epoch=?,status=?,reason=?,updated_at=? WHERE id=1')
      .run(
        epoch,
        next.closed ? 'closed' : 'open',
        next.closed ? (next.reason ?? null) : null,
        new Date().toISOString()
      );
    return maintenanceState(store);
  });
}

export type MaintenanceStatus = MaintenanceState & { forcedClosed: boolean };
/** The public shape every surface reads: the gate plus whether a boot flag forced it. */
export function maintenanceStatus(store: Store, forcedClosed: boolean): MaintenanceStatus {
  const current = maintenanceState(store);
  return {
    ...(forcedClosed && current.status === 'open'
      ? { ...current, status: 'closed' as const, reason: 'MAINTENANCE_BOOT' }
      : current),
    forcedClosed,
  };
}

/** One admission answer for HTTP writes, worker claims and new external work. */
export const admissionOpen = (store: Store, forcedClosed: boolean): boolean =>
  !forcedClosed && maintenanceState(store).status === 'open';

export function maintenanceRoutes(
  app: FastifyInstance,
  store: Store,
  options: { forcedClosed: boolean; activeWork: () => number }
) {
  const state = () => maintenanceStatus(store, options.forcedClosed);
  app.addHook('onRequest', async (request) => {
    if (
      MUTATING.has(request.method) &&
      !ALWAYS_ADMITTED.has(request.routeOptions.url ?? '') &&
      !admissionOpen(store, options.forcedClosed)
    )
      throw new HttpError(503, 'MAINTENANCE_CLOSED');
  });
  app.get('/api/maintenance', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send({ ...state(), activeWork: options.activeWork() })
  );
  app.post('/api/maintenance', async (request) => {
    const body = record(request.body);
    fields(body, ['status', 'reason']);
    const status = text(body.status, 'status', 20);
    if (status !== 'open' && status !== 'closed') throw new HttpError(400, 'MAINTENANCE_STATUS');
    if (status === 'open' && options.forcedClosed) throw new HttpError(409, 'MAINTENANCE_BOOT');
    const reason = body.reason === undefined ? undefined : text(body.reason, 'reason', 200);
    const next = setMaintenance(store, {
      closed: status === 'closed',
      ...(reason === undefined ? {} : { reason }),
    });
    return { ...state(), ...next, activeWork: options.activeWork() };
  });
}
