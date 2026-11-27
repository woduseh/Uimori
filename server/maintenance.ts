import { MAINTENANCE_CLOSED, type MaintenanceStatus, selfHostEndpoints } from '#contracts';
import { selfHostOperations } from '#contracts/operations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerEndpoint } from './endpoint.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export type MaintenanceState = Omit<MaintenanceStatus, 'forcedClosed'>;
type Row = Record<string, unknown> & { status: MaintenanceState['status'] };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALWAYS_ADMITTED = new Set([
  '/api/session',
  '/api/diagnostics/report',
  '/api/test/control',
  '/api/runs/:id/cancel',
  '/api/runs/:id/skip-state-wait',
  '/api/runs/:id/skip-package-preparation',
  '/api/runs/:id/skip-package-after-response',
  '/api/jobs/:id/cancel',
  '/api/illustrations/:id/cancel',
  '/api/helper/tasks/:id/cancel',
]);

export function initMaintenance(store: Store) {
  if (!store.db.prepare('SELECT 1 FROM maintenance WHERE id=1').get())
    store.db
      .prepare('INSERT INTO maintenance VALUES(1,0,?,NULL,?)')
      .run('open', new Date().toISOString());
}

export function maintenanceState(store: Store): MaintenanceState {
  const row = store.db.prepare('SELECT * FROM maintenance WHERE id=1').get() as Row;
  return {
    status: row.status,
    epoch: Number(row.epoch),
    ...(typeof row.reason === 'string' && row.reason ? { reason: row.reason } : {}),
    updatedAt: String(row.updated_at),
  };
}

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

export function maintenanceStatus(store: Store, forcedClosed: boolean): MaintenanceStatus {
  const current = maintenanceState(store);
  return {
    ...(forcedClosed && current.status === 'open'
      ? { ...current, status: 'closed' as const, reason: 'MAINTENANCE_BOOT' }
      : current),
    forcedClosed,
  };
}

export const admissionOpen = (store: Store, forcedClosed: boolean): boolean =>
  !forcedClosed && maintenanceState(store).status === 'open';

export function maintenanceRoutes(
  app: FastifyInstance,
  store: Store,
  options: { forcedClosed: boolean; activeWork: () => number; onOpen?: () => void }
) {
  const state = () => maintenanceStatus(store, options.forcedClosed);
  const writes = new Set<FastifyRequest>();
  const activeWork = () => options.activeWork() + writes.size;
  app.addHook('onRequest', async (request) => {
    if (
      !MUTATING.has(request.method) ||
      request.routeOptions.config.admission === 'always' ||
      ALWAYS_ADMITTED.has(request.routeOptions.url ?? '')
    )
      return;
    if (!admissionOpen(store, options.forcedClosed)) throw new HttpError(503, MAINTENANCE_CLOSED);
    writes.add(request);
  });
  app.addHook('onResponse', async (request) => {
    writes.delete(request);
  });
  app.addHook('onError', async (request) => {
    writes.delete(request);
  });
  registerEndpoint(
    app,
    selfHostEndpoints.readMaintenance,
    selfHostOperations.readMaintenance,
    () => ({ ...state(), activeWork: activeWork() })
  );
  registerEndpoint(
    app,
    selfHostEndpoints.setMaintenance,
    selfHostOperations.setMaintenance,
    (input) => {
      const { status, reason } = input;
      if (status === 'open' && options.forcedClosed) throw new HttpError(409, 'MAINTENANCE_BOOT');
      const wasClosed = state().status === 'closed';
      const next = setMaintenance(store, {
        closed: status === 'closed',
        ...(reason === undefined ? {} : { reason }),
      });
      if (wasClosed && next.status === 'open') options.onOpen?.();
      return { ...state(), ...next, activeWork: activeWork() };
    }
  );
}
