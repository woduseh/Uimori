import { get, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { PromptWorkspace } from '../core/product.js';
import { createApp, type App } from '../server/app.js';
import { createTestDirectory } from './fixtures/test-directory.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const origin = 'https://story.example.test';
const accessToken = 'synthetic-live-frame-access-key-32-chars';
const directory = createTestDirectory('uimori-resource-live-');
let app: App | undefined;
let stream: AbortController | undefined;

afterEach(async () => {
  stream?.abort();
  await app?.close();
  app = undefined;
  directory.remove();
});

test('a prompt-workspace save or undo through the resource routes reaches the live stream', async () => {
  app = await createApp({
    dbPath: join(directory.directory, 'app.sqlite'),
    buildId: 'resource-live-frames',
    accessToken,
    publicOrigin: origin,
    pushSender: async () => ({ status: 201 }),
  });
  const base = { host: 'story.example.test', origin };
  const session = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: base,
    payload: { token: accessToken },
  });
  expect(session.statusCode, session.body).toBe(200);
  const headers = { ...base, cookie: String(session.headers['set-cookie']) };
  const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  stream = new AbortController();
  const response = await new Promise<IncomingMessage>((resolve, reject) =>
    get(
      {
        host: address.hostname,
        port: address.port,
        path: '/api/events',
        headers,
        signal: stream!.signal,
      },
      resolve
    ).on('error', reject)
  );
  expect(response.statusCode).toBe(200);
  response.setEncoding('utf8');
  let received = '';
  let arrived = () => {};
  response.on('data', (chunk: string) => {
    received += chunk;
    arrived();
  });
  const waitFor = (seen: () => boolean) =>
    new Promise<void>((resolve) => {
      arrived = () => {
        if (seen()) resolve();
      };
      arrived();
    });
  const workspaceFrames = () => received.match(/"kind":"prompt-workspace\.updated"/gu)?.length ?? 0;
  const waitForFrames = (count: number) => waitFor(() => workspaceFrames() >= count);
  await waitFor(() => received.includes('event: live'));

  const seeded = await app.inject({
    method: 'PUT',
    url: '/api/prompt-workspace',
    headers,
    payload: {
      expectedRevision: (
        (
          await app.inject({ method: 'GET', url: '/api/prompt-workspace', headers })
        ).json() as PromptWorkspace
      ).revision,
      main: {
        title: 'Live options',
        program: nativePrompt('', { customPromptTemplateToggle: 'tone=Tone=text' }),
        values: {},
      },
    },
  });
  expect(seeded.statusCode, seeded.body).toBe(200);
  await waitForFrames(1);
  const workspace = seeded.json() as PromptWorkspace;
  const saved = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    headers,
    payload: {
      kind: 'prompt-workspace',
      id: 'current',
      expectedRevision: workspace.revision,
      model: { main: { ...workspace.main, values: { tone: 'Elsewhere' } } },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await waitForFrames(2);

  const undone = await app.inject({
    method: 'POST',
    url: '/api/resources/prompt-workspace/current/undo',
    headers,
    payload: { expectedRevision: saved.json().saved.revision },
  });
  expect(undone.statusCode, undone.body).toBe(200);
  await waitForFrames(3);
});
