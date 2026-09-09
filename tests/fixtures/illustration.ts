import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store, type Source } from '../../server/store.js';
import { defaultIllustrationSettings, type IllustrationSettings } from '../../core/illustration.js';
import { createFixtureChat } from './chat.js';

/** Illustration tests own a temporary SQLite file under the resolved temp root. */
export function illustrationDatabases(prefix: string) {
  const owned: { directory: string; store: Store }[] = [];
  const root = realpathSync(tmpdir());
  return {
    create() {
      const directory = mkdtempSync(join(root, prefix));
      const store = new Store(join(directory, 'synthetic.sqlite'));
      owned.push({ directory, store });
      return store;
    },
    cleanup() {
      for (const { directory, store } of owned.splice(0)) {
        try {
          store.close();
        } catch {
          /* Already closed by the test. */
        }
        const path = resolve(directory),
          rel = relative(root, path);
        if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith(prefix))
          throw new Error('Unsafe synthetic fixture cleanup');
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}
/** One completed scripted response so a source exists for illustration reservations. */
export function completedSource(
  store: Store,
  chatId: string,
  text = 'A lantern swung above the quiet river.\n\nMira waited on the pier.'
): Source {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const request = `Synthetic scene ${randomUUID()}`;
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => ({
      chatId,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: { ...selected.settings, status: false },
      request,
      history: store.history(selected.headRevision),
      profile,
      resources: store.product.resources(chatId, profile),
    })
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(
      run.id,
      text,
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
}
export function chatWithSource(store: Store, title = 'Synthetic illustration chat') {
  const chat = createFixtureChat(store, title);
  return { chat, source: completedSource(store, chat.id) };
}
export function fixtureSettings(
  overrides: Partial<Omit<IllustrationSettings, 'codex' | 'comfyui'>> & {
    codex?: Partial<IllustrationSettings['codex']>;
    comfyui?: Partial<IllustrationSettings['comfyui']>;
  } = {}
): IllustrationSettings {
  const base = defaultIllustrationSettings();
  return {
    ...base,
    generator: 'fixture',
    ...overrides,
    codex: { ...base.codex, ...(overrides.codex ?? {}) },
    comfyui: { ...base.comfyui, ...(overrides.comfyui ?? {}) },
  };
}
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=';
