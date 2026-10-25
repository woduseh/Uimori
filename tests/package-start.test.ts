import { readerDetail } from '../server/reader.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';
import { sourceVersions } from '../server/source-editing.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { canChangePackageStart, createPackageStart } from '../server/package-start.js';
import { resolvePackageStart, validatePackageStarts } from '../core/package-start.js';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { createFixtureChat } from './fixtures/chat.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
const owned: { store: Store; dir: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-package-start-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-package-start-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}

function fixture(alternateGreetings = ['A second opening.']) {
  const store = database(),
    pkg = nativeContent({
      name: 'Ari',
      first_mes: '\r\nAri opens the observatory door.\n',
      alternate_greetings: alternateGreetings,
    });
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic greeting', { botId: content.id });
  const profile = store.product.profile(chat.id);
  return {
    store,
    pkg,
    content,
    chat,
    command: {
      packageId: content.id,
      packageRevision: content.revision,
      startId: 'start-0',
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: profile.revision,
      idempotencyKey: 'native-greeting',
    },
  };
}
test('native first and alternative greetings retain authored text with no independent action language', () => {
  const pkg = nativeContent({
    first_mes: '\r\n{{char}} waits.\n',
    alternate_greetings: ['Other {{user}} greeting.'],
  });
  expect(resolvePackageStart(pkg, 'start-0').text).toBe('\r\n{{char}} waits.\n');
  expect(resolvePackageStart(pkg, 'start-1').text).toBe('Other {{user}} greeting.');
  for (const extra of [
    { values: {} },
    { initialAction: {} },
    { template: [] },
    { mode: 'generate' },
  ])
    expect(() => validatePackageStarts([{ ...pkg.starts![0], ...extra }])).toThrow();
});

test.each(['first', 'alternative'])(
  'native %s greetings preserve authored text at the stored message limit',
  (kind) => {
    const text = '가'.repeat(SOURCE_TEXT_MAX_CHARS);
    const pkg = nativeContent({
      first_mes: kind === 'first' ? text : 'First greeting',
      alternate_greetings: kind === 'alternative' ? [text] : [],
    });
    expect(resolvePackageStart(pkg, kind === 'first' ? 'start-0' : 'start-1').text).toBe(text);
  }
);

test('oversized greeting text has a distinct error from malformed authored starts', () => {
  const start = {
    id: 'start-0',
    title: 'Opening',
    mode: 'authored',
    text: 'a'.repeat(SOURCE_TEXT_MAX_CHARS + 1),
  };
  expect(() => validatePackageStarts([start])).toThrow('PACKAGE_START_TEXT_TOO_LONG');
  expect(() => validatePackageStarts([{ ...start, text: null }])).toThrow(
    'PACKAGE_START_INVALID_TEXT'
  );
});

test('alternative greetings remain selectable beyond the old count and combined size caps', () => {
  const starts = Array.from({ length: 101 }, (_, index) => ({
    id: `start-${index}`,
    title: `Opening ${index}`,
    mode: 'authored' as const,
    text: `${index}:${'a'.repeat(21_000)}`,
  }));
  const validated = validatePackageStarts(starts);
  expect(validated).toEqual(starts);
  expect(
    resolvePackageStart({ id: 'card', revision: 1, starts: validated }, 'start-100').text
  ).toBe(starts[100].text);
});

test('greeting selection rejects stale ownership and subsequent attempts without adding a source', () => {
  const f = fixture();
  expect(() =>
    createPackageStart(f.store, f.chat.id, {
      ...f.command,
      expectedProfileRevision: f.command.expectedProfileRevision + 1,
    })
  ).toThrow();
  expect(f.store.chat(f.chat.id).headRevision).toBeNull();
  createPackageStart(f.store, f.chat.id, f.command);
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...f.command, idempotencyKey: 'another' })
  ).toThrow();
});

function selectedStart(f: ReturnType<typeof fixture>) {
  const opening = createPackageStart(f.store, f.chat.id, f.command).run;
  const source = f.store.source(opening.sourceRevision!);
  return {
    source,
    command: {
      ...f.command,
      startId: 'start-1',
      expectedRevision: source.id,
      expectedSourceHash: source.hash,
      idempotencyKey: 'change-opening',
    },
  };
}

test('changing the opening keeps one active source and preserves edited originals, translations and explicit variables', () => {
  const f = fixture();
  const initial = selectedStart(f);
  const edited = f.store.editSource(initial.source.id, {
    text: 'My edited opening.',
    expectedRevision: 0,
  });
  const translation = f.store.editTranslation(edited.id, {
    text: 'Saved translation.',
    expectedRevision: 0,
    expectedSourceHash: edited.hash,
  });
  writeChatVariables(f.store, f.chat.id, {
    expectedRevision: 0,
    expectedSourceHash: edited.hash,
    idempotencyKey: 'personal-setting',
    values: { $name: 'Reader' },
  });
  const pending = f.store.retranslate(edited.id);
  expect(canChangePackageStart(f.store, f.chat.id)).toBe(true);
  const changed = createPackageStart(f.store, f.chat.id, {
    ...initial.command,
    expectedSourceHash: edited.hash,
  });
  const next = f.store.source(changed.run.sourceRevision!);
  expect(changed.created).toBe(true);
  expect(next.text).toBe('A second opening.');
  expect(next.parentRevision).toBeNull();
  expect(f.store.history(next.id).map((entry) => entry.text)).toEqual(['A second opening.']);
  expect(sourceVersions(f.store, edited.id).versions.map((entry) => entry.text)).toEqual([
    'My edited opening.',
    initial.source.text,
  ]);
  expect(f.store.job(translation.id).result?.text).toBe('Saved translation.');
  expect(f.store.job(translation.id).status).toBe('completed');
  expect(f.store.job(pending.id).status).toBe('cancelled');
  expect(readChatVariables(f.store, f.chat.id).values).toEqual({ $name: 'Reader' });
  expect(changed.run.usage?.modelCalls).toBe(0);
  const detail = readerDetail(f.store, f.chat.id, {});
  expect(detail.reader.order).toEqual([next.id]);
  expect(detail.reader.canChangePackageStart).toBe(true);
  expect(detail.runs[0].packageStart).toMatchObject({
    startId: 'start-1',
    packageId: f.content.id,
    packageRevision: f.content.revision,
  });
});

test('opening changes reject stale hashes and heads and replay the exact result after another selection', () => {
  const f = fixture();
  const initial = selectedStart(f);
  expect(() =>
    createPackageStart(f.store, f.chat.id, {
      ...initial.command,
      expectedSourceHash: '0'.repeat(64),
    })
  ).toThrow('Source hash conflict');
  const first = createPackageStart(f.store, f.chat.id, initial.command);
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...initial.command, idempotencyKey: 'stale' })
  ).toThrow('Source revision conflict');
  const source = f.store.source(first.run.sourceRevision!);
  createPackageStart(f.store, f.chat.id, {
    ...initial.command,
    startId: 'start-0',
    expectedRevision: source.id,
    expectedSourceHash: source.hash,
    idempotencyKey: 'change-back',
  });
  const replay = createPackageStart(f.store, f.chat.id, initial.command);
  expect(replay.created).toBe(false);
  expect(replay.run.id).toBe(first.run.id);
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...initial.command, startId: 'start-0' })
  ).toThrow('Idempotency key reused');
});

test.each(['ordinary', 'native-action'] as const)(
  'opening cannot change after a %s reservation, including cancelled attempts',
  (kind) => {
    const f = fixture();
    const initial = selectedStart(f);
    const chat = f.store.chat(f.chat.id);
    const run = f.store.createRun(
      chat.id,
      {
        request: 'Continue',
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'follow-up',
      },
      () => ({
        chatId: chat.id,
        request: 'Continue',
        parentRevision: chat.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        history: f.store.history(chat.headRevision),
        resources: [],
        ...(kind === 'native-action'
          ? {
              nativeRisuAuthored: {
                version: 1 as const,
                action: 'button',
                messages: [],
                commandHash: '0'.repeat(64),
              },
            }
          : {}),
      })
    ).run;
    f.store.finishRun(run.id, 'cancelled', 'Cancelled by user');
    expect(canChangePackageStart(f.store, chat.id)).toBe(false);
    expect(() => createPackageStart(f.store, chat.id, initial.command)).toThrow(
      'PACKAGE_START_CONVERSATION_STARTED'
    );
    expect(f.store.chat(chat.id).headRevision).toBe(initial.source.id);
  }
);

test('clearing the opening detaches history without an empty run, preserves explicit state, and replays after generation', () => {
  const f = fixture();
  const initial = selectedStart(f);
  const edited = f.store.editSource(initial.source.id, {
    text: 'Edited opening.',
    expectedRevision: 0,
  });
  writeChatVariables(f.store, f.chat.id, {
    expectedRevision: 0,
    expectedSourceHash: edited.hash,
    idempotencyKey: 'variables',
    values: { $name: 'Reader' },
  });
  const translation = f.store.editTranslation(edited.id, {
    text: 'Saved translation.',
    expectedRevision: 0,
    expectedSourceHash: edited.hash,
  });
  const pending = f.store.retranslate(edited.id);
  const profile = f.store.product.profile(f.chat.id);
  const command = { ...initial.command, startId: null, expectedSourceHash: edited.hash };
  expect(createPackageStart(f.store, f.chat.id, command)).toEqual({ run: null, created: true });
  expect(f.store.chat(f.chat.id).headRevision).toBeNull();
  expect(f.store.history(null)).toEqual([]);
  expect(readerDetail(f.store, f.chat.id, {}).reader.order).toEqual([]);
  expect(
    f.store.db.prepare('SELECT count(*) AS count FROM runs WHERE chat_id=?').get(f.chat.id)?.count
  ).toBe(1);
  expect(f.store.source(edited.id).text).toBe('Edited opening.');
  expect(sourceVersions(f.store, edited.id).versions).toHaveLength(2);
  expect(f.store.job(translation.id).status).toBe('completed');
  expect(f.store.job(pending.id).status).toBe('cancelled');
  expect(readChatVariables(f.store, f.chat.id).values).toEqual({ $name: 'Reader' });
  expect(f.store.product.profile(f.chat.id)).toEqual(profile);
  const chat = f.store.chat(f.chat.id);
  const run = f.store.createRun(
    chat.id,
    {
      request: 'Hello',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'next',
    },
    () => ({
      chatId: chat.id,
      request: 'Hello',
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      history: f.store.history(chat.headRevision),
      resources: [],
    })
  ).run;
  expect(run.snapshot.history).toEqual([]);
  f.store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
  f.store.completeRun(run.id, 'New conversation.', {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  const head = f.store.chat(chat.id).headRevision;
  expect(createPackageStart(f.store, chat.id, command)).toEqual({ run: null, created: false });
  expect(f.store.chat(chat.id).headRevision).toBe(head);
  expect(() => createPackageStart(f.store, chat.id, { ...command, startId: 'start-1' })).toThrow(
    'Idempotency key reused'
  );
});

test('clearing requires current source identity and rejects progressed conversations or reused authored keys', () => {
  const f = fixture();
  const initial = selectedStart(f);
  const command = { ...initial.command, startId: null };
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...command, expectedSourceHash: '0'.repeat(64) })
  ).toThrow('Source hash conflict');
  expect(() =>
    createPackageStart(f.store, f.chat.id, { ...command, idempotencyKey: f.command.idempotencyKey })
  ).toThrow('Idempotency key reused');
  expect(() =>
    createPackageStart(f.store, f.chat.id, {
      ...command,
      expectedRevision: undefined,
      expectedSourceHash: undefined,
    })
  ).toThrow('Source revision required');
  f.store.db
    .prepare("UPDATE runs SET snapshot=json_remove(snapshot,'$.packageStart') WHERE chat_id=?")
    .run(f.chat.id);
  expect(() => createPackageStart(f.store, f.chat.id, command)).toThrow(
    'PACKAGE_START_CONVERSATION_STARTED'
  );
  expect(f.store.chat(f.chat.id).headRevision).toBe(initial.source.id);
});

test('a single authored opening can be cleared with full admission revision checks', () => {
  const f = fixture([]);
  const opening = createPackageStart(f.store, f.chat.id, f.command).run;
  const source = f.store.source(opening.sourceRevision!);
  expect(canChangePackageStart(f.store, f.chat.id)).toBe(true);
  const command = {
    ...f.command,
    startId: null,
    expectedRevision: source.id,
    expectedSourceHash: source.hash,
    idempotencyKey: 'clear-single',
  };
  for (const conflict of [
    { expectedRevision: 'stale-source' },
    { expectedSettingsRevision: command.expectedSettingsRevision + 1 },
    { expectedProfileRevision: command.expectedProfileRevision + 1 },
  ])
    expect(() => createPackageStart(f.store, f.chat.id, { ...command, ...conflict })).toThrow(
      'conflict'
    );
  expect(createPackageStart(f.store, f.chat.id, command)).toEqual({ run: null, created: true });
  expect(canChangePackageStart(f.store, f.chat.id)).toBe(false);
});
