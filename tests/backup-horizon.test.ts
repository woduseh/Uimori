import { afterEach, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import { ManuscriptSearch } from '../server/manuscript-search.js';
import { foldSearchText } from '../server/search-schema.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { illustrationPresetCatalog } from '../server/illustration-presets.js';
import { illustrationSettings } from '../server/illustrations.js';
import { defaultIllustrationSettings } from '../core/illustration.js';
import { deleteChat } from '../server/chat-deletion.js';
import { uploadDirectory } from '../server/uploads.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';
import { transferRoutes } from '../server/transfer-routes.js';
import { importChatBackupArchiveRequest } from '../server/chat-backup.js';
import { buildMainProviderRequest, encodeMainPreview } from '../server/main-request.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { retryRun } from '../server/run-retry.js';
import {
  validateModelSnapshot,
  validateProviderSettingVersion,
} from '../server/provider-archive.js';
import type {
  Connection,
  Content,
  ModelPreset,
  PromptPreset,
  SavedPromptCombination,
} from '../core/product.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'backup-horizon-0.18.0');
const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));
const firstScene = 'Golden LANTERN 아래 붉은 우산을 든 미라가 부두에서 기다렸다.';
const secondScene = '강물 위로 보라색우산이 천천히 떠내려갔다.';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function database(bytes?: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-horizon-'));
  const path = join(directory, 'app.sqlite');
  if (bytes) writeFileSync(path, bytes);
  const store = new Store(path);
  owned.push({ directory, store });
  return store;
}
function upload(store: Store, name: string) {
  const id = randomBytes(16).toString('hex');
  mkdirSync(uploadDirectory(store.path), { recursive: true });
  writeFileSync(join(uploadDirectory(store.path), `${id}.bin`), readFileSync(join(fixtures, name)));
  return id;
}
const lore = (content: Content) =>
  (content.package.nativeRisu.card.character_book as { entries: { content: string }[] }).entries;

test('a v0.18.0 automatic backup, made in a worktree of tag v0.18.0, opens with its chat, search, library, presets and helper conversation', async () => {
  const snapshot = gunzipSync(readFileSync(join(fixtures, 'snapshot.db.gz')));
  expect(manifest).toMatchObject({
    format: 'uimori-snapshot-v1',
    appVersion: '0.18.0',
    schema: 15,
  });
  expect(createHash('sha256').update(snapshot).digest('hex')).toBe(manifest.sha256);
  const store = database(snapshot);

  const [chat] = store.chats();
  expect(chat.title).toBe('Lantern river');
  expect(store.history(chat.headRevision).map((entry) => entry.text)).toEqual([
    firstScene,
    secondScene,
  ]);
  expect(store.db.prepare('SELECT count(*) AS n FROM search_dirty_sources').get()!.n).toBe(0);
  expect(
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'search_fts%'").get()
  ).toBeUndefined();
  const search = new ManuscriptSearch(store);
  const found = async (query: string) =>
    (await search.search({ query, scope: 'workspace', kinds: ['original'] })).items.map(
      (item) => item.target.sourceId
    );
  const [first, second] = store.history(chat.headRevision).map((entry) => entry.revision);
  expect(await found('golden lantern')).toEqual([first]);
  expect(await found('보라색우산')).toEqual([second]);
  await search.close();

  const [bot] = store.product.all('content') as Content[];
  expect(bot.title).toBe('Mira of the Pier');
  expect(lore(bot).map((entry) => entry.content)).toEqual([
    'The golden lantern on the pier never goes out.',
  ]);
  const preset = (store.product.all('prompt-preset') as PromptPreset[]).find(
    (item) => item.title === 'Horizon main prompt'
  )!;
  expect(store.product.all('prompt-combination')).toMatchObject([
    { title: 'Horizon combination', role: 'main', owner: { kind: 'preset', id: preset.id } },
  ]);
  expect(illustrationPresetCatalog(store).presets.map((item) => item.title)).toContain('Ink wash');
  expect(illustrationSettings(store)).toEqual(defaultIllustrationSettings());

  const conversationId = String(store.db.prepare('SELECT id FROM helper_conversations').get()!.id);
  const helper = new HelperWorkspace(store);
  expect(helper.conversation(conversationId).limits).toEqual({ totalCalls: 128, helperCalls: 64 });
  expect(helper.messages(conversationId).map((message) => message.text)).toEqual([
    'Summarize the lantern lore',
  ]);

  deleteChat(store, chat.id);
  expect(store.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n).toBe(0);
  store.db.exec("INSERT INTO search_trigrams(search_trigrams) VALUES('integrity-check')");
  expect(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
});

test('a v0.18.0 backup taken before the legacy search index finished moving finds those scenes again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-horizon-legacy-'));
  const path = join(directory, 'app.sqlite');
  writeFileSync(path, gunzipSync(readFileSync(join(fixtures, 'snapshot.db.gz'))));
  const legacy = new DatabaseSync(path);
  const row = legacy
    .prepare("SELECT id,text FROM search_documents WHERE kind='original' AND text=?")
    .get(firstScene)!;
  legacy
    .prepare('UPDATE search_documents SET search_text=? WHERE id=?')
    .run(foldSearchText(String(row.text)), Number(row.id));
  legacy.prepare('DELETE FROM search_trigrams WHERE rowid=?').run(Number(row.id));
  legacy.close();
  const store = database(readFileSync(path));
  rmSync(directory, { recursive: true, force: true });

  const search = new ManuscriptSearch(store);
  const [first] = store.history(store.chats()[0].headRevision).map((entry) => entry.revision);
  const found = async () =>
    (await search.search({ query: 'golden lantern', scope: 'workspace', kinds: ['original'] }))
      .items;
  expect((await found()).map((item) => item.target.sourceId)).toEqual([first]);
  await search.refreshBatch();
  expect(store.db.prepare('SELECT count(*) AS n FROM search_dirty_sources').get()!.n).toBe(0);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM search_documents WHERE search_text<>''").get()!.n
  ).toBe(0);
  expect((await found()).map((item) => item.target.sourceId)).toEqual([first]);
  await search.close();
});

test('.uimori and .chat.uimori archives exported by v0.18.0 import as new copies', async () => {
  const store = database();
  const resources = await prepareNativeArchive(
    store,
    upload(store, 'resources.uimori'),
    'resources'
  );
  const app = Fastify();
  transferRoutes(app, store, () => {});
  const applied = await app.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: {
      preparedId: resources.preparedId,
      digest: resources.digest,
      idempotencyKey: 'horizon-resources',
    },
  });
  await app.close();
  expect(applied.statusCode).toBe(200);
  const imported = store.product.all('content') as Content[];
  expect(imported.map((item) => item.title)).toEqual(['Mira of the Pier']);
  expect(lore(imported[0]).map((entry) => entry.content)).toEqual([
    'The golden lantern on the pier never goes out.',
  ]);
  const preset = (store.product.all('prompt-preset') as PromptPreset[]).find(
    (item) => item.title === 'Horizon main prompt'
  )!;
  expect(store.product.all('prompt-combination') as SavedPromptCombination[]).toMatchObject([
    { title: 'Horizon combination', owner: { kind: 'preset', id: preset.id } },
  ]);

  const backup = await prepareNativeArchive(store, upload(store, 'chat.chat.uimori'), 'chat');
  const restored = importChatBackupArchiveRequest(store, {
    preparedId: backup.preparedId,
    digest: backup.digest,
    idempotencyKey: 'horizon-chat',
  });
  expect(restored.chat.title).toBe('Lantern river');
  expect(store.history(restored.chat.headRevision).map((entry) => entry.text)).toEqual([
    firstScene,
    secondScene,
  ]);
  expect(store.product.all('content')).toHaveLength(2);
});

test('stored presets, provider archives and model snapshots carrying legacy evaluationTools load without error, drop the field and keep writing requests identical', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-horizon-eval-'));
  const path = join(directory, 'app.sqlite');
  writeFileSync(path, gunzipSync(readFileSync(join(fixtures, 'snapshot.db.gz'))));
  const connection: Connection = {
    id: 'conn-horizon',
    revision: 1,
    title: 'Horizon OpenAI',
    protocol: 'openai-responses-v1',
    endpoint: 'https://api.openai.com/v1',
    credentialRef: 'HORIZON_KEY',
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  const baseModel = {
    revision: 1,
    connectionId: connection.id,
    modelId: 'gpt-6.2-astra',
    maxOutputTokens: 8192,
    temperature: null,
    capabilityProtocol: connection.protocol,
    enabled: true,
  };
  const legacyModelBody = {
    ...baseModel,
    id: 'model-legacy-eval',
    title: 'Horizon model with legacy evaluationTools',
    evaluationTools: {
      contextMode: 'preloaded',
      approvalReasoningMode: 'economized',
      metadataProfile: 'anthropic',
    },
  };
  const obsoleteModelBody = {
    ...baseModel,
    id: 'model-obsolete-eval',
    title: 'Horizon model with obsolete evaluationTools',
    evaluationTools: { contextMode: 'source-bound' },
  };
  const plainModelBody = {
    ...baseModel,
    id: 'model-plain',
    title: 'Horizon plain model',
  };
  const seeded = new DatabaseSync(path);
  const insert = seeded.prepare('INSERT INTO provider_settings VALUES(?,?,?,?)');
  insert.run('connection', connection.id, connection.revision, JSON.stringify(connection));
  for (const model of [legacyModelBody, obsoleteModelBody, plainModelBody])
    insert.run('model', model.id, model.revision, JSON.stringify(model));
  seeded.close();

  const store = database(readFileSync(path));
  rmSync(directory, { recursive: true, force: true });

  const listed = store.product.all('model') as ModelPreset[];
  expect(listed.map((item) => item.id)).toEqual([
    'model-legacy-eval',
    'model-obsolete-eval',
    'model-plain',
  ]);
  for (const item of listed) expect(item).not.toHaveProperty('evaluationTools');
  expect(store.product.stored<ModelPreset>('model', 'model-legacy-eval')).not.toHaveProperty(
    'evaluationTools'
  );
  expect(store.product.stored<ModelPreset>('model', 'model-obsolete-eval')).not.toHaveProperty(
    'evaluationTools'
  );

  for (const legacy of [legacyModelBody, obsoleteModelBody]) {
    expect(() =>
      validateProviderSettingVersion({
        kind: 'model',
        id: legacy.id,
        revision: legacy.revision,
        body: JSON.stringify(legacy),
      })
    ).not.toThrow();
    const validatedSnapshot = validateModelSnapshot({ ...legacy, connection });
    expect(validatedSnapshot).not.toHaveProperty('evaluationTools');
  }

  const legacySnapshot = store.product.modelSnapshot('model-legacy-eval', undefined, false);
  const plainSnapshot = store.product.modelSnapshot('model-plain', undefined, false);
  expect(legacySnapshot).not.toHaveProperty('evaluationTools');

  const [chat] = store.chats();
  const baseProfile = store.product.snapshot(chat.id, 'inspect');
  const baseRunSnapshot = {
    chatId: chat.id,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Continue from the pier.',
    history: store.history(chat.headRevision),
    resources: [],
    profile: {
      ...baseProfile,
      models: { ...baseProfile.models, main: plainSnapshot },
    },
  };
  const preparedPlain = await prepareNativeRisuRun(baseRunSnapshot, { preview: true });
  const preparedLegacy = await prepareNativeRisuRun(
    {
      ...baseRunSnapshot,
      profile: {
        ...baseRunSnapshot.profile,
        models: { ...baseRunSnapshot.profile.models, main: legacySnapshot },
      },
    },
    { preview: true }
  );
  const plainBuilt = buildMainProviderRequest(preparedPlain);
  const legacyBuilt = buildMainProviderRequest(preparedLegacy);
  expect(legacyBuilt.request.stable.tools.some((tool) => tool.name.startsWith('eval_'))).toBe(
    false
  );
  expect(JSON.stringify(encodeMainPreview(legacyBuilt.request, legacySnapshot).body)).toBe(
    JSON.stringify(encodeMainPreview(plainBuilt.request, plainSnapshot).body)
  );

  const candidateText = 'Candidate prose from legacy run.';
  const legacyRunId = 'run-legacy-rejudge';
  const legacyRunSnapshot = {
    ...baseRunSnapshot,
    profile: {
      ...baseRunSnapshot.profile,
      models: {
        ...baseRunSnapshot.profile.models,
        main: { ...legacySnapshot, evaluationTools: legacyModelBody.evaluationTools },
      },
    },
    mainJudgmentEnabled: true,
    mainJudgment: {
      response: candidateText,
      kind: 'refusal',
      sourceHash: 'legacy-source-hash',
    },
  };
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,partial_text,error,created_at,updated_at)
       VALUES(?,?,?,'failed',?,?,?,?,?,?,?,?)`
    )
    .run(
      legacyRunId,
      chat.id,
      chat.headRevision,
      'Continue from the pier.',
      JSON.stringify(legacyRunSnapshot),
      'legacy-request-key',
      '{}',
      candidateText,
      'JEV_UNAVAILABLE',
      now,
      now
    );
  const rejudged = retryRun(store, legacyRunId, 'horizon-rejudge', { judgmentOnly: true });
  expect(rejudged.created).toBe(true);
  const rawRecoveredRun = store.db
    .prepare('SELECT snapshot FROM runs WHERE id=?')
    .get(rejudged.run.id) as { snapshot: string };
  const recoveredSnapshot = JSON.parse(rawRecoveredRun.snapshot);
  expect(recoveredSnapshot.judgmentRecovery).toBe(true);
  expect(recoveredSnapshot.mainJudgment.response).toBe(candidateText);
  expect(recoveredSnapshot.profile.models.main).not.toHaveProperty('evaluationTools');

  const readRawModel = (id: string) =>
    JSON.parse(
      (
        store.db
          .prepare("SELECT body FROM provider_settings WHERE kind='model' AND id=?")
          .get(id) as { body: string }
      ).body
    );
  expect(readRawModel('model-legacy-eval')).toHaveProperty('evaluationTools');
  expect(readRawModel('model-obsolete-eval')).toHaveProperty('evaluationTools');
  expect(
    store.product.moveModel('model-legacy-eval', {
      targetId: 'model-obsolete-eval',
      position: 'after',
      expectedOrder: ['model-legacy-eval', 'model-obsolete-eval', 'model-plain'],
    })
  ).toEqual({ moved: true });
  expect(readRawModel('model-legacy-eval')).toMatchObject({ displayOrder: 1 });
  expect(readRawModel('model-legacy-eval')).not.toHaveProperty('evaluationTools');
  expect(readRawModel('model-obsolete-eval')).toMatchObject({ displayOrder: 0 });
  expect(readRawModel('model-obsolete-eval')).not.toHaveProperty('evaluationTools');

  const resaved = store.product.model(
    {
      title: 'Horizon model resaved',
      connectionId: connection.id,
      modelId: baseModel.modelId,
      maxOutputTokens: baseModel.maxOutputTokens,
      temperature: baseModel.temperature,
      enabled: true,
      expectedRevision: 1,
    },
    'model-legacy-eval'
  ) as ModelPreset;
  expect(resaved.revision).toBe(2);
  expect(resaved).not.toHaveProperty('evaluationTools');
  expect(readRawModel('model-legacy-eval')).not.toHaveProperty('evaluationTools');
});
