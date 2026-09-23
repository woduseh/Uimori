import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { Content } from '../core/product.js';
import {
  emptyTranslationGuide,
  readTranslationGuide,
  validateTranslationGuide,
  withTranslationGuide,
  type TranslationGuide,
} from '../core/translation-guide.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { editableResource, type ContentEditModel } from '../core/resource-editing.js';
import { saveResource, undoResource } from '../server/resource-service.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { currentBotTranslationGuide } from '../server/translation-guide.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { requestTranslation, rejudgeTranslation } from '../server/source-editing.js';
import { translationInput } from '../core/auxiliary.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import {
  exportResourceBundle,
  importResourceBundle,
  inspectBundle,
} from '../server/resource-bundle.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { exportRisuContent } from '../server/risu-export.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const guide: TranslationGuide = {
  instructions:
    'GUIDE_ONLY: Preserve the deliberate change of speech level. {{char}} is literal here.',
  terms: [{ source: 'Rose', target: '로즈', note: '인물 이름일 때만. 꽃은 장미.' }],
};
const owned: { path: string; store?: Store; app?: Awaited<ReturnType<typeof createApp>> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    if (item.app) await item.app.close();
    else item.store?.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-translation-guides-'));
  const store = new Store(join(path, 'app.sqlite'));
  owned.push({ path, store });
  return store;
}
function bot(store: Store, title = 'Guide bot', value = guide): Content {
  const input = fixtureBotInput(title, 'Plain story description.');
  input.package.nativeRisu.card = withTranslationGuide(
    {
      ...input.package.nativeRisu.card,
      extensions: { other: { preserved: true }, uimori: { unrelated: 'keep me' } },
    },
    value
  );
  return store.product.content(input) as Content;
}
function save(store: Store, bot: Content, value: TranslationGuide): Content {
  const model = editableResource('content', bot) as ContentEditModel;
  model.package.nativeRisu.card = withTranslationGuide(model.package.nativeRisu.card, value);
  return saveResource(store, { kind: 'content', id: bot.id, expectedRevision: bot.revision, model })
    .saved as Content;
}
function story(store: Store, bot: Content) {
  return importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Old scene',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [
        {
          request: 'Read a scene.',
          text: 'Rose quietly held a rose.',
          translation: '로즈는 조용히 장미를 들고 있었다.',
        },
      ],
    },
  }).chat;
}
function resolved(store: Store, sourceId: string, jobId: string) {
  const source = store.source(sourceId);
  return store.product.resolveJobPrompt(store.run(source.runId).snapshot, store.job(jobId).input);
}

test('guide validates authored text, rejects unfinished rows and preserves unrelated extensions', () => {
  expect(validateTranslationGuide(guide)).toEqual(guide);
  expect(() =>
    validateTranslationGuide({ instructions: '', terms: [{ source: 'Rose', target: '' }] })
  ).toThrow('표기 1');
  expect(() =>
    validateTranslationGuide({
      instructions: '',
      terms: [{ source: 'Rose', target: '로즈', regex: true }],
    })
  ).toThrow('표기 1');
  expect(() =>
    validateTranslationGuide({ instructions: '', terms: [], chatOverrides: {} })
  ).toThrow('객체');
  const original = {
    name: 'Bot',
    extensions: { risuai: { defaultVariables: 'x=1' }, uimori: { other: true } },
  };
  const next = withTranslationGuide(original, guide);
  expect(original.extensions.uimori).toEqual({ other: true });
  expect(next.extensions).toMatchObject({
    risuai: { defaultVariables: 'x=1' },
    uimori: { other: true, translationGuide: guide },
  });
  expect(readTranslationGuide({})).toEqual(emptyTranslationGuide());
});

test('ordinary and helper saves use one native field, validate atomically and support undo', () => {
  const store = database();
  const original = bot(store);
  const model = editableResource('content', original) as ContentEditModel;
  const changed = { ...guide, instructions: 'Requested helper edit' };
  model.package.nativeRisu.card = withTranslationGuide(model.package.nativeRisu.card, changed);
  const result = invokeResourceTool(store, 'resource.save', {
    kind: 'content',
    id: original.id,
    expectedRevision: original.revision,
    model,
  }) as { revision: number };
  const saved = store.product.get<Content>('content', original.id);
  expect(readTranslationGuide(saved.package.nativeRisu.card)).toEqual(changed);
  expect(saved.text).toBe(original.text);
  expect(saved.package.nativeRisu.card.extensions).toMatchObject({
    other: { preserved: true },
    uimori: { unrelated: 'keep me' },
  });
  expect(() =>
    save(store, saved, { instructions: 'Invalid', terms: [{ source: '', target: '미라' }] })
  ).toThrow('표기 1');
  expect(store.product.get<Content>('content', original.id).revision).toBe(result.revision);
  expect(() => save(store, original, guide)).toThrow('변경');
  const restored = undoResource(store, 'content', original.id, result.revision).saved as Content;
  expect(readTranslationGuide(restored.package.nativeRisu.card)).toEqual(guide);
  expect(store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n).toBe(0);
  expect(store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0);
});

test('guide survives restart, native projection, independent resource and chat backups, and CHARX export', async () => {
  const source = database();
  const original = bot(source);
  const chat = story(source, original);
  const bundle = exportResourceBundle(source, [{ kind: 'content', id: original.id }]);
  const target = database();
  const imported = importResourceBundle(target, {
    file: bundle,
    digest: inspectBundle(bundle).digest,
    idempotencyKey: randomUUID(),
  });
  const copy = target.product.get<Content>('content', imported.items[0].id);
  expect(copy.id).not.toBe(original.id);
  expect(readTranslationGuide(copy.package.nativeRisu.card)).toEqual(guide);
  const portable = await importChatBackup(target, {
    backup: exportChatBackup(source, chat.id),
    idempotencyKey: randomUUID(),
  });
  expect(currentBotTranslationGuide(target, portable.chat.id)).toMatchObject({
    ...guide,
    botId: portable.chat.botId,
  });
  const charx = exportRisuContent(source.product, original);
  const analyzed = analyzeNativeRisuImport(
    readCharacterCard({ name: charx.filename, base64: charx.bytes.toString('base64') })
  );
  expect(readTranslationGuide(analyzed.file.contents[0].source.package.nativeRisu.card)).toEqual(
    guide
  );
  const path = source.path;
  source.close();
  const reopened = new Store(path);
  owned.find((item) => item.store === source)!.store = reopened;
  expect(
    readTranslationGuide(
      reopened.product.get<Content>('content', original.id).package.nativeRisu.card
    )
  ).toEqual(guide);
});

test('old scenes use latest guide at request time; queued and running jobs keep that choice; no existing translation rewrite', () => {
  const store = database();
  let current = bot(store);
  const chat = story(store, current);
  const source = store.source(chat.headRevision!);
  const existing = requestTranslation(store, source.id);
  const savedText = existing.result!.text;
  const originalSource = source.text;
  const first = requestTranslation(store, source.id, true);
  expect((first.input as any).translationGuide).toMatchObject({ ...guide, botRevision: 1 });
  current = save(store, current, {
    instructions: 'NEW_GUIDE_ONLY',
    terms: [{ source: 'Rose', target: '로제' }],
  });
  expect(resolved(store, source.id, first.id).translationGuide!.instructions).toBe(
    guide.instructions
  );
  expect(requestTranslation(store, source.id, true).id).toBe(first.id);
  store.claimJob(first.id, 'test', {});
  current = save(store, current, {
    instructions: 'LATEST_GUIDE',
    terms: [{ source: 'Rose', target: '로제' }],
  });
  expect(resolved(store, source.id, first.id).translationGuide!.instructions).toBe(
    guide.instructions
  );
  store.failJob(first.id, store.job(first.id).generation, 'test', 'synthetic failure');
  const next = requestTranslation(store, source.id, true);
  expect(resolved(store, source.id, next.id).translationGuide!.instructions).toBe('LATEST_GUIDE');
  expect((next.input as any).translationGuide.botRevision).toBe(current.revision);
  expect(store.job(existing.id).result!.text).toBe(savedText);
  expect(store.source(source.id).text).toBe(originalSource);
  const secondChat = story(store, current);
  expect(currentBotTranslationGuide(store, secondChat.id)!.instructions).toBe('LATEST_GUIDE');
  const other = bot(store, 'Other bot', { instructions: 'OTHER_BOT_ONLY', terms: [] });
  expect(currentBotTranslationGuide(store, story(store, other).id)!.instructions).toBe(
    'OTHER_BOT_ONLY'
  );
  expect(JSON.stringify(resolved(store, source.id, next.id).translationGuide)).not.toContain(
    'OTHER_BOT_ONLY'
  );
});

test('empty guide is captured explicitly and judgment-only recovery never adopts a new guide', () => {
  const store = database();
  let current = bot(store, 'No guide', emptyTranslationGuide());
  const chat = story(store, current);
  const first = requestTranslation(store, chat.headRevision!, true);
  expect((first.input as any).translationGuide).toBeNull();
  current = save(store, current, guide);
  const frozen = resolved(store, chat.headRevision!, first.id);
  expect(frozen.translationGuide).toBeNull();
  const input = translationInput(
    store.source(chat.headRevision!),
    sourceTimeContext(frozen, 'translation'),
    frozen
  );
  expect(input.context).not.toHaveProperty('translationGuide');
  const claimed = store.claimJob(first.id, 'recovery', {})!;
  store.finishAuxiliary(first.id, claimed.generation, 'recovery', {
    status: 'failed',
    error: 'TRANSLATION_REFUSAL_CHECK_FAILED',
    result: {
      mock: false,
      text: '판정 대기 번역',
      sourceRevision: chat.headRevision!,
      sourceHash: store.source(chat.headRevision!).hash,
    },
  });
  const recovered = rejudgeTranslation(store, first.id);
  expect(recovered.input).toMatchObject({
    translationGuide: null,
    judgmentRecovery: { text: '판정 대기 번역' },
  });
  expect(resolved(store, chat.headRevision!, recovered.id).translationGuide).toBeNull();
  expect(currentBotTranslationGuide(store, chat.id)).toMatchObject(guide);
});

test('preview shows latest bot guidance without provider calls and main preview never delivers it', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-translation-guides-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'translation-guide-test',
    testMode: true,
  });
  owned.push({ path, app });
  const current = bot(app.store);
  const chat = story(app.store, current);
  const counts = () => ({
    runs: app.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n,
    jobs: app.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n,
    attempts: app.store.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n,
  });
  const before = counts();
  const translation = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/prompt-preview`,
    payload: { role: 'translation', request: 'Preview' },
  });
  expect(translation.statusCode, translation.body).toBe(200);
  expect(translation.json().translationGuide).toMatchObject({ ...guide, botId: current.id });
  expect(JSON.stringify(translation.json().compilation)).toContain('GUIDE_ONLY');
  const main = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/prompt-preview`,
    payload: { role: 'main', request: 'Preview' },
  });
  expect(main.statusCode, main.body).toBe(200);
  expect(main.json()).not.toHaveProperty('translationGuide');
  expect(JSON.stringify(main.json())).not.toContain('GUIDE_ONLY');
  const custom = nativePrompt(
    'Only my translation principle.',
    { promptTemplate: [{ type: 'plain', role: 'system', text: 'Translate only.' }] },
    'translation'
  );
  const withoutSlot = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/prompt-preview`,
    payload: { role: 'translation', request: 'Preview', program: custom },
  });
  expect(withoutSlot.statusCode, withoutSlot.body).toBe(200);
  expect(withoutSlot.json().translationGuide).toMatchObject(guide);
  expect(counts()).toEqual(before);
});

test('module-only bot guides preserve an empty card; attached module metadata is never an override', () => {
  const store = database();
  const input = fixtureBotInput('Module-only bot');
  input.package.nativeRisu.card = {};
  input.package.nativeRisu.module = withTranslationGuide(
    { name: 'Module-only bot', description: 'Synthetic module', lorebook: [] },
    guide
  );
  const saved = store.product.content(input) as Content;
  const chat = store.createChat('Module owner', { botId: saved.id });
  expect(saved.package.nativeRisu.card).toEqual({});
  expect(currentBotTranslationGuide(store, chat.id)).toMatchObject({ ...guide, botId: saved.id });
  const main = fixtureBotInput('Card wins');
  main.package.nativeRisu.module = withTranslationGuide(
    { name: 'Attached module', lorebook: [] },
    guide
  );
  const cardBot = store.product.content(main) as Content;
  expect(
    currentBotTranslationGuide(
      store,
      store.createChat('No inherited module guide', { botId: cardBot.id }).id
    )
  ).toBeNull();
});
