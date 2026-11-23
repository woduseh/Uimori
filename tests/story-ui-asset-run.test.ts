import { createHash, randomUUID } from 'node:crypto';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { parseStoryUi } from '../core/story-ui.js';
import { createApp } from '../server/app.js';
import { storeImage } from '../server/image-storage.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';

test('a native card portrait resolves to the same stored image during streaming and after the run commits', async () => {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'uimori-story-ui-asset-'));
  const app = await createApp({
    dbPath: join(directory.path, 'app.sqlite'),
    buildId: 'story-ui-asset-test',
    testMode: true,
    codex: { enabled: false },
  });
  try {
    const { store } = app;
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/k9sAAAAASUVORK5CYII=',
      'base64'
    );
    const hash = createHash('sha256').update(bytes).digest('hex');
    storeImage(store.db, { hash, mime: 'image/png', bytes });
    const card = fixtureBotInput('서윤');
    card.package.images = [
      {
        id: 'image-0',
        title: '초상화',
        description: '',
        blobHash: hash,
        mime: 'image/png',
        allowedUse: 'both',
      },
    ];
    card.package.nativeRisu.assets = [
      { name: '서윤_교복_웃음', uri: 'embeded://portrait.png', imageId: 'image-0' },
    ];
    const bot = store.product.content(card);
    const created = createFixtureChat(store, '메신저', { botId: bot.id });
    const chat = store.settings(created.id, created.settingsRevision, {
      ...created.settings,
      storyUi: true,
    });
    const expression =
      '<a2ui>root = Message("도착했어.", "서윤", avatar="{{img::서윤_교복_웃음}}")</a2ui>';
    app.controls.hold('run');
    const admitted = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      payload: {
        request: expression,
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
    const runId = admitted.json().id;
    const response = await app.inject({
      method: 'POST',
      url: '/api/story-ui/preview',
      payload: { runId, text: expression },
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = parseStoryUi(response.json().text).find((part) => part.kind === 'ui');
    expect(preview?.expression).toBe(expression);
    expect(Object.values(preview?.imageUrls ?? {})).toEqual([`/api/package-image-blobs/${hash}`]);
    app.controls.release('run');
    await vi.waitFor(() => expect(store.run(runId).status).toBe('completed'), { timeout: 15000 });
    const source = store.source(store.chat(chat.id).headRevision!);
    const saved = parseStoryUi(source.text).find((part) => part.kind === 'ui');
    expect(saved?.expression).toBe(expression);
    expect(saved?.imageUrls).toEqual(preview?.imageUrls);
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/sources/${source.id}/text`,
      payload: {
        text: `수정한 첫 줄.

${expression.replace('도착했어.', '이제 도착했어.')}`,
        expectedRevision: 0,
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const recompiled = parseStoryUi(store.source(source.id).text).find(
      (part) => part.kind === 'ui'
    );
    expect(recompiled?.expression).toContain('이제 도착했어.');
    expect(recompiled?.imageUrls).toEqual(preview?.imageUrls);
  } finally {
    app.controls.release('run');
    await app.close();
    directory.remove();
  }
});
