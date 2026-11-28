import sharp from 'sharp';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
import type { Illustration, IllustrationSettings } from '../core/illustration.js';
import { injectWithFixtureBot } from './fixtures/chat.js';
import * as illustrationRunner from '../server/illustration-runner.js';
import { claimIllustration } from '../server/illustrations.js';
import type { CodexRuntimeService } from '../server/codex-runtime.js';

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
async function setup(codexRuntime?: CodexRuntimeService) {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'uimori-illustration-api-'));
  const item: (typeof owned)[number] = { directory };
  owned.push(item);
  const app = await createApp({
    dbPath: join(directory, 'test.sqlite'),
    buildId: 'illustration-api',
    testMode: true,
    ...(codexRuntime ? { codexRuntime } : {}),
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
    { ...chat.settings, expectedSettingsRevision: chat.settingsRevision },
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
  const settleTask = (id: string) =>
    until(illustrations, (items) => {
      const item = items.find((entry) => entry.id === id);
      return !!item && !['queued', 'running'].includes(item.status);
    }).then((items) => items.find((entry) => entry.id === id)!);
  const settle = async (id: string): Promise<Illustration> => {
    const job = await settleTask(id);
    if (job.task !== 'plan' || job.status !== 'completed' || job.diagnostic?.skipped) return job;
    const children = (await illustrations()).filter((item) => item.target?.planId === id);
    expect(children.length).toBeGreaterThan(0);
    return settleTask(children[0].id);
  };
  const settings = async (patch: Partial<Omit<IllustrationSettings, 'revision'>>) => {
    const current = await api<IllustrationSettings>('/api/illustration-settings');
    const { revision, ...body } = current;
    return api<IllustrationSettings>(
      '/api/illustration-settings',
      { expectedRevision: revision, ...body, ...patch },
      'PUT'
    );
  };
  return { app, api, chat, respond, illustrations, settle, settleTask, settings, item };
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
      automatic: false,
    });
    await api(`/api/sources/${source.id}/illustrations`, {}, 'POST', 409).then((body) =>
      expect(body.code).toBe('ILLUSTRATION_MODEL_REQUIRED')
    );
    const saved = await settings({ generator: 'fixture', maxPerSource: 1, maxAutoRetries: 0 });
    expect(saved.revision).toBe(2);
    for (const direction of [42, 'x'.repeat(8001)])
      await api(`/api/sources/${source.id}/illustrations`, { direction }, 'POST', 400);
    await api(
      '/api/illustration-settings',
      { expectedRevision: 1, ...saved, revision: undefined },
      'PUT',
      409
    );
    const queued = await api<Illustration>(`/api/sources/${source.id}/illustrations`, {
      expectedSourceHash: source.hash,
      direction: '  등불을 중심으로 그려 주세요.  ',
    });
    expect(await api(`/api/illustrations/${queued.id}`)).toMatchObject({
      input: { plan: { direction: '등불을 중심으로 그려 주세요.' } },
    });
    expect(queued).toMatchObject({
      status: 'queued',
      origin: 'manual',
      generator: 'fixture',
      sourceRevision: source.id,
    });
    await api(`/api/sources/${source.id}/illustrations`, {}, 'POST', 409).then((body) =>
      expect([
        'ILLUSTRATION_PLAN_ACTIVE',
        'ILLUSTRATION_ACTIVE',
        'ILLUSTRATION_LIMIT_REACHED',
      ]).toContain(body.code)
    );
    const done = await settle(queued.id);
    expect(done.status).toBe('completed');
    for (const changeRequest of [42, 'x'.repeat(8001)])
      await api(`/api/illustrations/${done.id}/regenerate`, { changeRequest }, 'POST', 400);
    expect(done.images).toHaveLength(1);
    const image = await app.inject({ url: done.images[0].url });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/webp');
    expect(await sharp(image.rawPayload).metadata()).toMatchObject({
      format: 'webp',
      width: 1,
      height: 1,
    });
    const reader = await api<ReaderDetail>(`/api/chats/${chat.id}/reader`);
    expect(
      reader.illustrations?.filter((item) => item.task === 'render').map((item) => item.id)
    ).toEqual([done.id]);
    expect(
      reader.reader.activity?.some(
        (item) => item.kind === 'illustration' && item.status === 'completed'
      )
    ).toBe(true);
    await api(`/api/sources/${source.id}/illustrations`, {}, 'POST', 409).then((body) =>
      expect(body.code).toBe('ILLUSTRATION_LIMIT_REACHED')
    );
    await api(
      `/api/sources/${source.id}/illustrations`,
      { expectedSourceHash: 'f'.repeat(64) },
      'POST',
      409
    ).then((body) => expect(body.code).toBe('ILLUSTRATION_SOURCE_CHANGED'));
    const detail = await api<Illustration & { input: unknown }>(`/api/illustrations/${done.id}`);
    expect(detail.input).toMatchObject({ generator: 'fixture', maxAutoRetries: 0 });
    await api(`/api/illustrations/${done.id}`, undefined, 'DELETE');
    expect((await illustrations()).filter((item) => item.task === 'render')).toEqual([]);
    await api(`/api/illustration-images/${done.images[0].id}`, undefined, 'GET', 404);
    const again = await api<Illustration>(`/api/sources/${source.id}/illustrations`, {});
    expect((await settle(again.id)).status).toBe('completed');
    const kinds = (app.store.events(chat.id, 0) as { kind: string }[]).map((event) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'illustration.queued',
        'illustration.running',
        'illustration.completed',
        'illustration-layout.updated',
      ])
    );
  });
  test('generator connection tests answer their failure as a result the settings screen reads', async () => {
    const { api } = await setup();
    expect(
      await api('/api/illustration-settings/comfyui/test', { baseUrl: 'ftp://comfy.invalid' })
    ).toEqual({ ok: false, code: 'COMFYUI_BASE_URL_INVALID' });
    expect(
      await api('/api/illustration-settings/comfyui/test', {
        baseUrl: `http://comfy.invalid/${'a'.repeat(2100)}`,
      })
    ).toEqual({ ok: false, code: 'COMFYUI_BASE_URL_INVALID' });
    expect(await api('/api/illustration-settings/novelai/test', {})).toEqual({
      ok: false,
      code: 'NOVELAI_TOKEN_MISSING',
    });
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
    expect(
      (await settle(initial.find((item) => item.sourceRevision === first.id)!.id)).status
    ).toBe('completed');
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
    await settings({ generator: 'fixture', automatic: false });
    const manualOnly = await respond('No automatic illustration');
    expect((await illustrations()).filter((item) => item.sourceRevision === manualOnly.id)).toEqual(
      []
    );
  });
  test('cancellation and injected failures leave distinct terminal states without stored images', async () => {
    const { api, chat, respond, settle, settings, illustrations } = await setup();
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
    const detail = await api<Illustration & { generation: number }>(
      `/api/illustrations/${held.id}`
    );
    const reader = await api<ReaderDetail>(`/api/chats/${chat.id}/reader`);
    const notice = reader.reader.activity?.find((item) => item.id === held.id);
    expect(detail.generation).toBe(2);
    expect(detail.attempt).toBe(1);
    expect(notice).toMatchObject({
      kind: 'illustration',
      status: 'cancelled',
      generation: detail.generation,
    });
    await api('/api/test/control', { action: 'release', barrier: 'illustration' });
    await api('/api/test/control', {
      action: 'fail-next',
      point: 'illustration',
      chatId: chat.id,
    });
    const injected = await settle(
      (await api<Illustration>(`/api/sources/${source.id}/illustrations`, {})).id
    );
    expect(injected).toMatchObject({ status: 'failed', error: 'ILLUSTRATION_FAILED', attempt: 1 });
    expect(await settle(held.id)).toMatchObject({ status: 'cancelled', images: [] });
  });
  test('deleting a cancelled task while its worker settles does not block the next task', async () => {
    const { api, respond, settings, illustrations, settleTask } = await setup();
    const firstSource = await respond('First scene');
    const secondSource = await respond('Second scene');
    await settings({ generator: 'fixture', maxPerSource: 2, maxAutoRetries: 0 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = illustrationRunner.runIllustrationJob;
    let first = true;
    const runner = vi
      .spyOn(illustrationRunner, 'runIllustrationJob')
      .mockImplementation(async (...args) => {
        if (!first) return original(...args);
        first = false;
        expect(claimIllustration(args[0], args[1], args[2])).not.toBeNull();
        await pending;
        return null;
      });
    try {
      const a = await api<Illustration>(`/api/sources/${firstSource.id}/illustrations`, {});
      await until(illustrations, (items) =>
        items.some((item) => item.id === a.id && item.status === 'running')
      );
      const b = await api<Illustration>(`/api/sources/${secondSource.id}/illustrations`, {});
      expect((await illustrations()).find((item) => item.id === b.id)?.status).toBe('queued');
      await api(`/api/illustrations/${a.id}/cancel`, {});
      expect(await api(`/api/illustrations/${a.id}`, undefined, 'DELETE')).toEqual({
        deleted: true,
      });
      expect((await illustrations()).find((item) => item.id === b.id)?.status).toBe('queued');
      release();
      expect((await settleTask(b.id)).status).toBe('completed');
    } finally {
      release();
      runner.mockRestore();
    }
  });
});
