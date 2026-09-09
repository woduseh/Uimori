import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
import type { Illustration, IllustrationSettings } from '../core/illustration.js';
import { injectWithFixtureBot } from './fixtures/chat.js';
import { comfyUIFixture, FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { PNG_BASE64 } from './fixtures/illustration.js';

const owned: { directory: string; app?: App; close?: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.close?.();
    await item.app?.close();
    const target = resolve(item.directory),
      within = relative(realpathSync(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-illustration-api-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'uimori-illustration-api-'));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  const app = await createApp({
    dbPath: join(directory, 'test.sqlite'),
    buildId: 'illustration-api',
    testMode: true,
  });
  item.app = app;
  const api = async <T = any>(
    url: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = body === undefined ? 'GET' : 'POST',
    status = 200
  ): Promise<T> => {
    const response = await injectWithFixtureBot(app, {
      method,
      url,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    });
    expect(response.statusCode, `${method} ${url} → ${response.body}`).toBe(status);
    return response.json();
  };
  const chat = await api<Chat>('/api/chats', { title: 'Illustrated chat' });
  await api(
    `/api/chats/${chat.id}/settings`,
    { ...chat.settings, status: false, expectedSettingsRevision: chat.settingsRevision },
    'PATCH'
  );
  const respond = async (request = `Scene ${randomUUID()}`) => {
    const before = await api<ChatDetail>(`/api/chats/${chat.id}`);
    const run = await api<Run>(`/api/chats/${chat.id}/runs`, {
      request,
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    });
    const done = await until(
      () => api<ChatDetail>(`/api/chats/${chat.id}`),
      (detail) => detail.runs.find((item) => item.id === run.id)?.status === 'completed'
    );
    return done.sources.find((source) => source.runId === run.id)!;
  };
  const illustrations = () => api<Illustration[]>(`/api/chats/${chat.id}/illustrations`);
  const settle = (id: string) =>
    until(illustrations, (items) => {
      const item = items.find((entry) => entry.id === id);
      return !!item && !['queued', 'running'].includes(item.status);
    }).then((items) => items.find((entry) => entry.id === id)!);
  const settings = async (patch: Partial<Omit<IllustrationSettings, 'revision'>>) => {
    const current = await api<IllustrationSettings>('/api/illustration-settings');
    const { revision, ...body } = current;
    return api<IllustrationSettings>(
      '/api/illustration-settings',
      { expectedRevision: revision, ...body, ...patch },
      'PUT'
    );
  };
  return { app, api, chat, respond, illustrations, settle, settings, item };
}
async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 10_000
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting: ${JSON.stringify(value).slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('illustration API in test mode with the synthetic generator', () => {
  test('manual requests run independently, attach to the response, persist bytes and respect the per-response limit', async () => {
    const { api, chat, respond, settle, settings, illustrations, app } = await setup();
    const source = await respond();
    expect(await api('/api/illustration-settings')).toMatchObject({
      revision: 1,
      generator: 'none',
    });
    await api(`/api/sources/${source.id}/illustrations`, {}, 'POST', 409).then((body) =>
      expect(body.error).toBe('ILLUSTRATION_GENERATOR_UNCONFIGURED')
    );
    const saved = await settings({ generator: 'fixture', maxPerSource: 1, maxAutoRetries: 0 });
    expect(saved.revision).toBe(2);
    await api(
      '/api/illustration-settings',
      { expectedRevision: 1, ...saved, revision: undefined },
      'PUT',
      409
    );
    const queued = await api<Illustration>(`/api/sources/${source.id}/illustrations`, {
      expectedSourceHash: source.hash,
    });
    expect(queued).toMatchObject({
      status: 'queued',
      origin: 'manual',
      generator: 'fixture',
      sourceRevision: source.id,
    });
    await api(`/api/sources/${source.id}/illustrations`, {}, 'POST', 409).then((body) =>
      expect(['ILLUSTRATION_ACTIVE', 'ILLUSTRATION_LIMIT_REACHED']).toContain(body.error)
    );
    const done = await settle(queued.id);
    expect(done.status).toBe('completed');
    expect(done.images).toHaveLength(1);
    const image = await app.inject({ url: done.images[0].url });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(Buffer.from(image.rawPayload).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
    const reader = await api<ReaderDetail>(`/api/chats/${chat.id}/reader`);
    expect(reader.illustrations?.map((item) => item.id)).toEqual([done.id]);
    expect(
      reader.reader.activity?.some(
        (item) => item.kind === 'illustration' && item.status === 'completed'
      )
    ).toBe(true);
    await api(`/api/sources/${source.id}/illustrations`, {}, 'POST', 409).then((body) =>
      expect(body.error).toBe('ILLUSTRATION_LIMIT_REACHED')
    );
    await api(
      `/api/sources/${source.id}/illustrations`,
      { expectedSourceHash: 'f'.repeat(64) },
      'POST',
      409
    ).then((body) => expect(body.error).toBe('ILLUSTRATION_SOURCE_CHANGED'));
    const detail = await api<Illustration & { input: unknown }>(`/api/illustrations/${done.id}`);
    expect(detail.input).toMatchObject({ generator: 'fixture', maxAutoRetries: 0 });
    await api(`/api/illustrations/${done.id}`, undefined, 'DELETE');
    expect(await illustrations()).toEqual([]);
    await api(`/api/illustration-images/${done.images[0].id}`, undefined, 'GET', 404);
    const again = await api<Illustration>(`/api/sources/${source.id}/illustrations`, {});
    expect((await settle(again.id)).status).toBe('completed');
    const kinds = (app.store.events(chat.id, 0) as { kind: string }[]).map((event) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'illustration.queued',
        'illustration.running',
        'illustration.completed',
        'source.illustrations',
      ])
    );
  });
  test('automatic retries follow the frozen limit and explicit retries resume failed work', async () => {
    const { api, respond, settle, settings } = await setup();
    const source = await respond();
    await settings({ generator: 'fixture', maxPerSource: 4, maxAutoRetries: 1 });
    const recovered = await settle(
      (
        await api<Illustration>(`/api/sources/${source.id}/illustrations`, {
          fixture: { failures: 1 },
        })
      ).id
    );
    expect(recovered).toMatchObject({ status: 'completed', attempt: 2 });
    expect(recovered.diagnostic?.retries).toEqual([
      { attempt: 1, code: 'FIXTURE_FAILURE', at: expect.any(String) },
    ]);
    const exhausted = await settle(
      (
        await api<Illustration>(`/api/sources/${source.id}/illustrations`, {
          fixture: { failures: 2 },
        })
      ).id
    );
    expect(exhausted).toMatchObject({ status: 'failed', attempt: 2, error: 'FIXTURE_FAILURE' });
    expect(recovered.images).toHaveLength(1);
    await api(`/api/illustrations/${exhausted.id}/retry`, {}, 'POST');
    const retried = await settle(exhausted.id);
    expect(retried).toMatchObject({ status: 'completed', attempt: 3 });
    expect(retried.diagnostic?.retries.map((entry) => entry.code)).toEqual([
      'FIXTURE_FAILURE',
      'FIXTURE_FAILURE',
    ]);
    await api(`/api/illustrations/${retried.id}/retry`, {}, 'POST', 409).then((body) =>
      expect(body.error).toBe('ILLUSTRATION_NOT_RETRYABLE')
    );
  });
  test('automatic generation reserves one illustration per completed response and never blocks the next response', async () => {
    const { api, chat, respond, settle, settings, illustrations } = await setup();
    await settings({ generator: 'fixture', automatic: true, maxPerSource: 2 });
    const first = await respond('First scene');
    const initial = await until(illustrations, (items) =>
      items.some((item) => item.sourceRevision === first.id)
    );
    expect(initial.find((item) => item.sourceRevision === first.id)).toMatchObject({
      origin: 'automatic',
    });
    await api('/api/test/control', { action: 'hold', barrier: 'illustration' });
    const second = await respond('Second scene while illustration is held');
    const held = await until(illustrations, (items) =>
      items.some((item) => item.sourceRevision === second.id && item.status === 'running')
    );
    expect(held.filter((item) => item.sourceRevision === second.id)).toHaveLength(1);
    const third = await respond('Third scene continues regardless');
    expect(third.text.length).toBeGreaterThan(0);
    const reader = await api<ReaderDetail>(`/api/chats/${chat.id}/reader`);
    expect(reader.reader.activeJobs).toBe(0);
    await api('/api/test/control', { action: 'release', barrier: 'illustration' });
    for (const source of [second, third]) {
      const item = await settle(
        (
          await until(illustrations, (items) =>
            items.some((entry) => entry.sourceRevision === source.id)
          )
        ).find((entry) => entry.sourceRevision === source.id)!.id
      );
      expect(item.status).toBe('completed');
    }
    expect(
      (await settle(initial.find((item) => item.sourceRevision === first.id)!.id)).status
    ).toBe('completed');
    await settings({ generator: 'fixture', automatic: false });
    const manualOnly = await respond('No automatic illustration');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await illustrations()).filter((item) => item.sourceRevision === manualOnly.id)).toEqual(
      []
    );
  });
  test('cancellation and injected failures leave distinct terminal states without stored images', async () => {
    const { api, respond, settle, settings, illustrations } = await setup();
    const source = await respond();
    await settings({ generator: 'fixture', maxPerSource: 4, maxAutoRetries: 2 });
    await api('/api/test/control', { action: 'hold', barrier: 'illustration' });
    const held = await api<Illustration>(`/api/sources/${source.id}/illustrations`, {});
    await until(
      illustrations,
      (items) => items.find((item) => item.id === held.id)?.status === 'running'
    );
    const cancelled = await api<Illustration>(`/api/illustrations/${held.id}/cancel`, {});
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      error: 'ILLUSTRATION_CANCELLED',
      images: [],
    });
    await api('/api/test/control', { action: 'release', barrier: 'illustration' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await settle(held.id)).toMatchObject({ status: 'cancelled', images: [] });
    await api('/api/test/control', { action: 'fail-next', point: 'illustration' });
    const injected = await settle(
      (await api<Illustration>(`/api/sources/${source.id}/illustrations`, {})).id
    );
    expect(injected).toMatchObject({ status: 'failed', error: 'ILLUSTRATION_FAILED', attempt: 1 });
  });
  test('reference roles and ComfyUI settings validate through the API and the connectivity check reports codes', async () => {
    const { api, chat, settings, item } = await setup();
    const empty = await api(`/api/chats/${chat.id}/illustration-references`);
    expect(empty).toEqual({ chatId: chat.id, revision: 0, references: [], candidates: [] });
    await api(
      `/api/chats/${chat.id}/illustration-references`,
      { expectedRevision: 0, references: [{ ref: 'missing', role: 'style' }] },
      'PUT',
      400
    );
    const asset = await api(`/api/chats/${chat.id}/assets`, {
      title: 'Style sheet',
      mime: 'image/png',
      base64: PNG_BASE64,
      description: '',
      actor: '',
      outfit: '',
      location: '',
      allowedUse: 'both',
    });
    const saved = await api(
      `/api/chats/${chat.id}/illustration-references`,
      { expectedRevision: 0, references: [{ ref: asset.id, role: 'style' }] },
      'PUT'
    );
    expect(saved).toMatchObject({ revision: 1, references: [{ ref: asset.id, role: 'style' }] });
    const listed = await api(`/api/chats/${chat.id}/illustration-references`);
    expect(listed.candidates).toEqual([
      {
        ref: asset.id,
        title: 'Style sheet',
        url: `/api/assets/${asset.id}`,
        mime: 'image/png',
        role: 'style',
      },
    ]);
    const current = await api<IllustrationSettings>('/api/illustration-settings');
    const { revision, ...body } = current;
    const invalid = await api(
      '/api/illustration-settings',
      {
        expectedRevision: revision,
        ...body,
        generator: 'comfyui',
        comfyui: {
          ...body.comfyui,
          baseUrl: 'http://127.0.0.1:1',
          workflow: '{"nodes":[],"links":[]}',
        },
      },
      'PUT',
      400
    );
    expect(invalid.error).toBe('COMFYUI_WORKFLOW_UI_FORMAT');
    const comfy = await comfyUIFixture();
    item.close = comfy.close;
    const accepted = await settings({
      generator: 'comfyui',
      comfyui: { ...body.comfyui, baseUrl: `${comfy.origin}/`, workflow: FIXTURE_WORKFLOW },
    });
    expect(accepted.comfyui.baseUrl).toBe(comfy.origin);
    const test = await api('/api/illustration-settings/comfyui/test', {
      baseUrl: comfy.origin,
      authorizationEnv: '',
    });
    expect(test.system.comfyuiVersion).toBe('0.3.99');
    const bad = await api(
      '/api/illustration-settings/comfyui/test',
      { baseUrl: 'ftp://nope', authorizationEnv: '' },
      'POST',
      400
    );
    expect(JSON.parse(bad.error).code).toBe('COMFYUI_BASE_URL_INVALID');
    await comfy.close();
    item.close = undefined;
    const down = await api(
      '/api/illustration-settings/comfyui/test',
      { baseUrl: comfy.origin, authorizationEnv: '' },
      'POST',
      502
    );
    expect(JSON.parse(down.error).code).toBe('COMFYUI_UNREACHABLE');
    const source = await (async () => {
      const before = await api<ChatDetail>(`/api/chats/${chat.id}`);
      const run = await api<Run>(`/api/chats/${chat.id}/runs`, {
        request: 'Scene for the prompt-model check',
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        idempotencyKey: randomUUID(),
      });
      return until(
        () => api<ChatDetail>(`/api/chats/${chat.id}`),
        (detail) => detail.runs.find((entry) => entry.id === run.id)?.status === 'completed'
      );
    })();
    const sourceId = source.sources.at(-1)!.id;
    const rejected = await api(`/api/sources/${sourceId}/illustrations`, {}, 'POST', 409);
    expect(rejected.error).toBe('ILLUSTRATION_PROMPT_MODEL_REQUIRED');
  });
});

test('reconcile is refused for jobs without an accepted ComfyUI prompt', async () => {
  const { api, respond, settle, settings } = await setup();
  const source = await respond();
  await settings({ generator: 'fixture', maxPerSource: 2, maxAutoRetries: 0 });
  const done = await settle(
    (await api<Illustration>(`/api/sources/${source.id}/illustrations`, {})).id
  );
  const refused = await api(`/api/illustrations/${done.id}/reconcile`, {}, 'POST', 409);
  expect(refused.error).toBe('ILLUSTRATION_NOT_RECONCILABLE');
  const failed = await settle(
    (
      await api<Illustration>(`/api/sources/${source.id}/illustrations`, {
        fixture: { failures: 1 },
      })
    ).id
  );
  expect(failed.status).toBe('failed');
  const stillRefused = await api(`/api/illustrations/${failed.id}/reconcile`, {}, 'POST', 409);
  expect(stillRefused.error).toBe('ILLUSTRATION_NOT_RECONCILABLE');
});
