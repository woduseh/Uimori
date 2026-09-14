import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type App } from '../server/app.js';
import { maintenanceState, setMaintenance } from '../server/maintenance.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0).reverse()) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function boot(options: { maintenance?: boolean; directory?: string } = {}) {
  const directory =
    options.directory ?? (await mkdtemp(join(await realpath(tmpdir()), 'uimori-maintenance-')));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'maintenance-test',
    ...(options.maintenance ? { maintenance: true } : {}),
  });
  owned.push({ app, directory });
  await app.ready();
  return { app, directory };
}

test('a closed gate blocks new writes, keeps reads and cancellation, and survives a restart', async () => {
  const { app, directory } = await boot();
  const chat = createFixtureChat(app.store, 'Maintenance fixture', 'calm');
  const opened = await app.inject({ method: 'GET', url: '/api/maintenance' });
  expect(opened.json()).toMatchObject({ status: 'open', epoch: 0, forcedClosed: false });

  const closed = await app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'closed', reason: 'update' },
  });
  expect(closed.json()).toMatchObject({ status: 'closed', epoch: 1, reason: 'update' });

  const write = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Blocked while closed.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'maintenance-blocked',
    },
  });
  expect(write.statusCode).toBe(503);
  expect(write.json()).toEqual({ error: 'MAINTENANCE_CLOSED' });
  expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });

  const read = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}` });
  expect(read.statusCode).toBe(200);
  // Stopping already admitted work stays possible while the gate is closed.
  const cancel = await app.inject({ method: 'POST', url: '/api/runs/missing-run/cancel' });
  expect(cancel.statusCode).not.toBe(503);

  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );
  const reopened = await boot({ directory });
  expect(
    (await reopened.app.inject({ method: 'GET', url: '/api/maintenance' })).json()
  ).toMatchObject({ status: 'closed', epoch: 1 });
  const stillBlocked = await reopened.app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Still blocked.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'maintenance-blocked-2',
    },
  });
  expect(stillBlocked.statusCode).toBe(503);

  const reopenedGate = await reopened.app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'open' },
  });
  expect(reopenedGate.json()).toMatchObject({ status: 'open', epoch: 1 });
  expect(maintenanceState(reopened.app.store)).toMatchObject({ status: 'open', epoch: 1 });
  const accepted = await reopened.app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/runs`,
    payload: {
      request: 'Accepted after reopening.',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'maintenance-accepted',
    },
  });
  expect(accepted.statusCode).not.toBe(503);
});

test('repeating the same gate change keeps one epoch and a maintenance boot cannot be reopened', async () => {
  const { app, directory } = await boot();
  setMaintenance(app.store, { closed: true, reason: 'first' });
  setMaintenance(app.store, { closed: true, reason: 'second' });
  expect(maintenanceState(app.store)).toMatchObject({
    status: 'closed',
    epoch: 1,
    reason: 'first',
  });
  setMaintenance(app.store, { closed: false });
  setMaintenance(app.store, { closed: true });
  expect(maintenanceState(app.store)).toMatchObject({ status: 'closed', epoch: 2 });
  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );

  const candidate = await boot({ directory, maintenance: true });
  // A candidate boot proves migration and reads; its gate is not a user setting.
  setMaintenance(candidate.app.store, { closed: false });
  const status = await candidate.app.inject({ method: 'GET', url: '/api/maintenance' });
  expect(status.json()).toMatchObject({ status: 'closed', forcedClosed: true });
  const reopen = await candidate.app.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'open' },
  });
  expect(reopen.statusCode).toBe(409);
  expect(reopen.json()).toEqual({ error: 'MAINTENANCE_BOOT' });
});

test('an existing database gains the gate through its schema migration', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'uimori-maintenance-upgrade-'));
  const dbPath = join(directory, 'story.sqlite');
  const first = await createApp({ dbPath, buildId: 'maintenance-upgrade' });
  await first.ready();
  const chat = createFixtureChat(first.store, 'Upgrade fixture', 'calm');
  await first.close();
  // Reopen the same database the way an installed app upgrades in place.
  const database = new DatabaseSync(dbPath);
  database.exec('DROP TABLE maintenance');
  database.exec('DELETE FROM schema_migrations WHERE version=20');
  database.exec('PRAGMA user_version=19');
  database.close();

  const upgraded = await createApp({ dbPath, buildId: 'maintenance-upgrade' });
  owned.push({ app: upgraded, directory });
  await upgraded.ready();
  expect((await upgraded.inject({ method: 'GET', url: '/api/maintenance' })).json()).toMatchObject({
    status: 'open',
    epoch: 0,
  });
  const write = await upgraded.inject({
    method: 'POST',
    url: '/api/maintenance',
    payload: { status: 'closed' },
  });
  expect(write.json()).toMatchObject({ status: 'closed', epoch: 1 });
  expect(
    (
      await upgraded.inject({
        method: 'POST',
        url: `/api/chats/${chat.id}/runs`,
        payload: {
          request: 'Blocked after upgrade.',
          expectedRevision: null,
          expectedSettingsRevision: chat.settingsRevision,
          idempotencyKey: 'upgrade-blocked',
        },
      })
    ).statusCode
  ).toBe(503);
});
