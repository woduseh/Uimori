import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Chat } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; app?: App }[] = [];
afterEach(async () => {
  for (const { directory, app } of owned.splice(0)) {
    await app?.close();
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-story-ui-settings-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

test('story UI is off by default and only booleans can change a chat’s saved setting', async () => {
  const fixture: (typeof owned)[number] = {
    directory: mkdtempSync(join(tmpdir(), 'uimori-story-ui-settings-')),
  };
  owned.push(fixture);
  const app = await createApp({
    dbPath: join(fixture.directory, 'app.sqlite'),
    buildId: 'story-ui-settings-test',
    testMode: true,
    codex: { enabled: false },
  });
  fixture.app = app;
  const first = createFixtureChat(app.store, 'Story UI chat');
  const other = createFixtureChat(app.store, 'Independent chat');
  const save = (expectedSettingsRevision: number, storyUi: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/chats/${first.id}/settings`,
      payload: { ...first.settings, expectedSettingsRevision, storyUi },
    });

  expect(first.settings.storyUi).toBeUndefined();
  const enabled = await save(first.settingsRevision, true);
  expect(enabled.statusCode).toBe(200);
  const revision = enabled.json<Chat>().settingsRevision;
  expect(app.store.chat(first.id).settings.storyUi).toBe(true);
  expect(app.store.chat(other.id).settings.storyUi).toBeUndefined();

  const styled = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${first.id}/settings`,
    payload: {
      ...enabled.json<Chat>().settings,
      expectedSettingsRevision: revision,
      storyUiStyle: 'east-asian',
    },
  });
  expect(styled.statusCode).toBe(200);
  expect(app.store.chat(first.id).settings.storyUiStyle).toBe('east-asian');
  expect(app.store.chat(other.id).settings.storyUiStyle).toBeUndefined();
  const styledRevision = styled.json<Chat>().settingsRevision;
  const invalidStyle = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${first.id}/settings`,
    payload: {
      ...styled.json<Chat>().settings,
      expectedSettingsRevision: styledRevision,
      storyUiStyle: 'unknown',
    },
  });
  expect(invalidStyle.statusCode).toBe(400);

  const invalid = await save(styledRevision, 'true');
  expect(invalid.statusCode).toBe(400);
  expect(app.store.chat(first.id).settingsRevision).toBe(styledRevision);
  expect(app.store.chat(first.id).settings.storyUi).toBe(true);

  const disabled = await save(styledRevision, false);
  expect(disabled.statusCode).toBe(200);
  expect(app.store.chat(first.id).settings.storyUi).toBe(false);
});
