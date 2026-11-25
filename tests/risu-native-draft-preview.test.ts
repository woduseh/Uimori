import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type App } from '../server/app.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';

const apps: { app: App; directory: string }[] = [];
afterEach(async () => {
  disposeAllNativeRisuSessions();
  for (const item of apps.splice(0)) {
    await item.app.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});

async function start(accessToken?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-draft-preview-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'draft-preview',
    accessToken,
  });
  apps.push({ app, directory });
  return app;
}

async function importBot(app: App) {
  const source = {
    name: 'draft.json',
    base64: Buffer.from(
      JSON.stringify({
        spec: 'chara_card_v3',
        data: {
          name: 'Draft',
          description: 'Desc',
          first_mes: 'Saved {{getvar::mood}}',
          extensions: { risuai: { defaultVariables: 'mood=calm' } },
        },
      })
    ).toString('base64'),
  };
  const prepared = await app.inject({
    method: 'POST',
    url: '/api/risu-imports/prepare',
    payload: { source },
  });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const applied = await app.inject({
    method: 'POST',
    url: '/api/risu-imports/apply',
    payload: {
      source,
      digest: prepared.json().digest,
      allowPartial: false,
      idempotencyKey: 'draft-preview',
      createChat: false,
    },
  });
  expect(applied.statusCode, applied.body).toBe(201);
  const id = applied.json().receipt.items[0].id as string;
  const content = (await app.inject(`/api/content/${id}`)).json();
  return { id, content };
}

test('renders an unsaved draft with its own defaults and leaves the saved content alone', async () => {
  const app = await start();
  const { id, content } = await importBot(app);
  const native = structuredClone(content.package.nativeRisu);
  native.card.extensions.risuai.defaultVariables = 'mood=bright';
  native.card.extensions.risuai.customScripts = [
    { type: 'editdisplay', in: 'Draft', out: 'Edited', flag: 'g', ableFlag: true },
  ];
  const response = await app.inject({
    method: 'POST',
    url: `/api/content/${id}/risu-preview`,
    payload: {
      revision: content.revision,
      nativeRisu: native,
      text: 'Draft {{getvar::mood}} {{img::missing}}',
      viewportWidth: 412,
      viewportHeight: 915,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().html).toContain('Edited bright');
  expect(response.json().issues).toContain('asset:missing');
  const saved = (await app.inject(`/api/content/${id}`)).json();
  expect(saved).toEqual(content);
  const previous = await app.inject(
    `/api/content/${id}/risu-preview?revision=${content.revision}&startId=start-0`
  );
  expect(previous.json().html).toContain('Saved calm');
});

test('rejects invalid drafts and reports evaluation failures without a server error', async () => {
  const app = await start();
  const { id, content } = await importBot(app);
  const post = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/content/${id}/risu-preview`,
      payload: payload as object,
    });
  const native = content.package.nativeRisu;
  const valid = { revision: content.revision, nativeRisu: native, text: 'x' };
  expect((await post({ ...valid, extra: true })).statusCode).toBe(400);
  expect((await post({ ...valid, nativeRisu: { ...native, version: 2 } })).statusCode).toBe(400);
  expect((await post({ ...valid, text: 'x'.repeat(2_000_001) })).statusCode).toBe(400);
  expect((await post({ ...valid, revision: 99 })).statusCode).toBe(404);
  expect(
    (await app.inject({ method: 'POST', url: '/api/content/missing/risu-preview', payload: valid }))
      .statusCode
  ).toBe(404);
  const failing = structuredClone(native);
  failing.card.extensions.risuai.triggerscript = [
    {
      type: 'start',
      effect: [
        {
          type: 'triggerlua',
          code: "listenEdit('editDisplay', function() error('broken draft') end)",
        },
      ],
    },
  ];
  const failed = await post({ ...valid, nativeRisu: failing });
  expect(failed.statusCode, failed.body).toBe(200);
  expect(failed.json().failure).toContain('broken draft');
  expect(failed.json().html).toBeUndefined();
});

test('stays behind the API session', async () => {
  const app = await start('synthetic-token-for-draft-preview');
  const response = await app.inject({
    method: 'POST',
    url: '/api/content/any/risu-preview',
    payload: { revision: 1, nativeRisu: {}, text: '' },
  });
  expect(response.statusCode).toBe(401);
});
