import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { prepareNativeRisuReadOnly } from '../server/risu-native-readonly.js';
import {
  modelWorkspace,
  updateModelWorkspace,
  promptWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { type Content } from '../core/product.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultProfile, type ModelSnapshot } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import {
  contextSourceRefs,
  previousContextPlan,
  seedContextPlan,
  validateContextPlan,
} from '../server/context-planning.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';

const owned: { store: Store; directory: string }[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const model: ModelSnapshot = {
  id: 'synthetic-main',
  revision: 1,
  title: 'Synthetic context model',
  modelId: 'fixture-main',
  connectionId: 'synthetic-connection',
  inputTokenLimit: 8192,
  maxOutputTokens: 8192,
  temperature: null,
  connection: {
    id: 'synthetic-connection',
    revision: 1,
    title: 'Unused loopback',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:44999/turn',
    enabled: true,
    catalog: [],
    catalogError: null,
  },
};

afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-checkpoints-'))
      throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-checkpoints-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const chat = createFixtureChat(store, 'Synthetic checkpoint storage');
  const history: RunSnapshot['history'] = [];
  const snapshot = (): RunSnapshot =>
    seedContextPlan({
      chatId: chat.id,
      parentRevision: history.at(-1)?.revision ?? null,
      settingsRevision: chat.settingsRevision,
      settings: { ...chat.settings, status: false, maxCalls: 16 },
      request: '다음 장면을 이어 주세요.',
      history: structuredClone(history),
      resources: [],
      profile: { ...defaultProfile(chat.id), models: { main: model } },
    });
  const snapshots: RunSnapshot[] = [];
  // The rows have complete source ancestry and cumulative frozen input snapshots.
  // No provider calls or translation jobs are needed to test checkpoint selection.
  for (let index = 0; index < 4; index++) {
    const prior = snapshot();
    snapshots.push(prior);
    const sourceId = `source-${index}`;
    const runId = `run-${index}`;
    const text =
      `합성 장면 ${index}: 비 오는 항구에서 미라가 기다려요.` +
      (index === 0 ? '<EvaluationReport>보존창 검사 기록</EvaluationReport>' : '');
    const time = new Date(index * 1000).toISOString();
    store.db
      .prepare(
        "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at,branch_id) VALUES(?,?,?,'completed',?,?,?,?,?,?,?,?)"
      )
      .run(
        runId,
        chat.id,
        prior.parentRevision,
        prior.request,
        JSON.stringify(prior),
        runId,
        '{}',
        sourceId,
        time,
        time,
        `main:${chat.id}`
      );
    store.db
      .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)')
      .run(sourceId, chat.id, runId, prior.parentRevision, text, hash(text), time);
    history.push({ revision: sourceId, text });
  }
  store.db
    .prepare('UPDATE branches SET head_revision=? WHERE id=?')
    .run('source-3', `main:${chat.id}`);
  store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run('source-3', chat.id);
  const save = (index: number, value: RunSnapshot) => {
    snapshots[index] = structuredClone(value);
    store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(value), `run-${index}`);
  };
  const candidate = (index: number, summary: string) => {
    const value = store.context.prepareRun(structuredClone(snapshots[index]));
    value.contextPlan = {
      ...value.contextPlan!,
      status: 'ready',
      compacted: contextSourceRefs(value).slice(0, 1),
      recentSourceRevisions: value.history.slice(1).map((source) => source.revision),
      summary,
      estimatedInputTokens: 100,
    };
    validateContextPlan(value);
    return value;
  };
  const checkpoint = (index: number, summary: string) => {
    const published = store.context.publishPrepared(candidate(index, summary), {
      origin: 'automatic',
    });
    save(index, published);
    expect(store.context.checkpoint(published.contextPlan!.checkpoint!).activated).toBe(true);
    return published;
  };
  const capture = () => store.context.prepareRun(snapshot());
  return { store, current: capture(), capture, snapshots, save, candidate, checkpoint };
}

describe('stored context checkpoint selection', () => {
  test('uses only the captured active reference, even when an ancestor has a summary', () => {
    const f = fixture();
    delete f.snapshots[0].contextPlan;
    f.save(0, f.snapshots[0]);
    f.store.db
      .prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.contextPlan',NULL) WHERE id=?")
      .run('run-1');
    const ready = structuredClone(f.snapshots[2]);
    ready.contextPlan!.status = 'ready';
    ready.contextPlan!.estimatedInputTokens = 100;
    validateContextPlan(ready);
    f.save(2, ready);
    f.save(3, f.candidate(3, '공통 checkpoint로 발행하지 않은 요약'));
    expect(previousContextPlan(f.store, f.current)).toBeUndefined();
    expect(previousContextPlan(f.store, f.capture())).toBeUndefined();
  });

  test('keeps the captured immutable checkpoint after activation changes and returns copies', () => {
    const f = fixture();
    const old = f.checkpoint(1, '오래된 유효 요약');
    const captured = f.capture();
    const newest = f.checkpoint(2, '최신 유효 요약');
    f.store.db
      .prepare('UPDATE runs SET created_at=?,updated_at=? WHERE id=?')
      .run('9999-01-01', '9999-01-01', 'run-1');
    expect(previousContextPlan(f.store, captured)).toEqual(old.contextPlan);
    const latest = f.capture();
    const selected = previousContextPlan(f.store, latest)!;
    expect(selected).toEqual(newest.contextPlan);
    selected.summary = '호출자 변경';
    selected.compacted[0].hash = '호출자 변경';
    expect(previousContextPlan(f.store, latest)).toEqual(newest.contextPlan);
    expect(previousContextPlan(f.store, captured)).toEqual(old.contextPlan);
    expect(f.store.run('run-2').snapshot.contextPlan).toEqual(newest.contextPlan);
    expect(previousContextPlan(f.store, f.current)).toBeUndefined();
  });

  test.each(['invalid-source', 'invalid-budget', 'dependency', 'pending', 'failed'])(
    'rejects a %s candidate without changing the active checkpoint',
    (reason) => {
      const f = fixture();
      const old = f.checkpoint(1, '오래된 유효 요약');
      const newer = f.candidate(2, '선택하면 안 되는 요약');
      const plan = newer.contextPlan!;
      if (reason === 'invalid-source') plan.compacted[0].hash = 'wrong-hash';
      else if (reason === 'invalid-budget') plan.budget.inputTokenLimit = 100;
      else if (reason === 'dependency') plan.dependencyKey = 'other-canon';
      else plan.status = reason === 'pending' ? 'pending' : 'failed';
      expect(() => f.store.context.publishPrepared(newer, { origin: 'automatic' })).toThrow();
      expect(previousContextPlan(f.store, f.capture())).toEqual(old.contextPlan);
      expect(
        f.store.db.prepare('SELECT COUNT(*) AS count FROM context_checkpoints').get()!.count
      ).toBe(1);
    }
  );

  test('rejects reuse after current source edits or changed semantic dependencies', () => {
    const f = fixture();
    f.checkpoint(1, '과거 원문 요약');
    const current = f.capture();
    const edited = structuredClone(current);
    edited.history[0].text = '사용자가 수정한 원문';
    edited.history[0].contentHash = hash(edited.history[0].text);
    expect(previousContextPlan(f.store, edited)).toBeUndefined();
    const changed = structuredClone(current);
    changed.profile!.packages = [
      nativeContent(
        { name: '새 정사 자료', description: '약속의 의미가 달라졌어요.' },
        { id: 'new-canon' },
        'module'
      ),
    ];
    changed.profile!.packageAttachments = [{ id: 'new-canon', revision: 1, role: 'module' }];
    expect(previousContextPlan(f.store, seedContextPlan(changed))).toBeUndefined();
  });

  test.each(['id', 'revision', 'hash', 'scope'] as const)(
    'rejects a captured checkpoint with mismatched %s',
    (part) => {
      const f = fixture();
      f.checkpoint(1, '검증한 요약');
      const captured = f.capture();
      if (part === 'scope') captured.contextBase!.scopeKey += ':other-branch';
      else if (part === 'revision') captured.contextBase!.checkpoint!.revision++;
      else captured.contextBase!.checkpoint![part] = 'missing-or-altered';
      expect(() => previousContextPlan(f.store, captured)).toThrow(
        part === 'scope' ? 'CONTEXT_CHECKPOINT_SCOPE_MISMATCH' : 'CONTEXT_CHECKPOINT_MISSING'
      );
    }
  );

  test('rejects a stored checkpoint whose projection no longer matches its hash', () => {
    const f = fixture();
    f.checkpoint(1, '저장된 불변 요약');
    const captured = f.capture();
    f.store.db
      .prepare("UPDATE context_checkpoints SET plan=json_set(plan,'$.summary',?) WHERE id=?")
      .run('외부 변조', captured.contextBase!.checkpoint!.id);
    expect(() => previousContextPlan(f.store, captured)).toThrow(
      'CONTEXT_CHECKPOINT_HASH_MISMATCH'
    );
  });

  test.each(['id', 'chatId', 'blank', 'hash'])(
    'rejects invalid source identity at source capture: %s',
    (part) => {
      const f = fixture();
      const current = f.current.history.at(-1)!;
      const id = part === 'id' ? '' : current.revision;
      const chatId = part === 'chatId' ? '' : f.current.chatId;
      const text = part === 'blank' ? ' \n\t' : current.text;
      const sourceHash = part === 'hash' ? 'wrong-hash' : hash(text);
      f.store.db.exec('PRAGMA foreign_keys=OFF');
      f.store.db
        .prepare('UPDATE sources SET id=?,chat_id=?,text=?,hash=? WHERE id=?')
        .run(id, chatId, text, sourceHash, current.revision);
      f.store.db.exec('PRAGMA foreign_keys=ON');
      expect(() => f.store.source(id)).toThrow('SOURCE_IDENTITY_INVALID');
      if (part !== 'id') expect(() => f.store.history(id)).toThrow('SOURCE_IDENTITY_INVALID');
    }
  );

  test('preserves missing-source and missing-run errors at their storage boundaries', () => {
    const f = fixture();
    expect(() => f.store.history('missing-source')).toThrow(
      expect.objectContaining({ statusCode: 404, message: 'Source not found' })
    );
    f.store.db.exec('PRAGMA foreign_keys=OFF');
    f.store.db.prepare('DELETE FROM runs WHERE id=?').run('run-3');
    f.store.db.exec('PRAGMA foreign_keys=ON');
    expect(() => f.store.run('run-3')).toThrow(
      expect.objectContaining({ statusCode: 404, message: 'Run not found' })
    );
    expect(() => f.store.history('source-3')).toThrow(
      expect.objectContaining({ statusCode: 404, message: 'Source not found' })
    );
  });
});

describe('Current checkpoint lifetime', () => {
  const owners: { store: Store; path: string }[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const { store, path } of owners.splice(0)) {
      store.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  function database() {
    const path = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const owner = { store: new Store(join(path, 'app.sqlite')), path };
    owners.push(owner);
    return owner.store;
  }

  function fixture(count = 4) {
    const store = database();
    const connection = store.product.connection({
      title: 'Synthetic',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    });
    const model = store.product.model({
      title: 'Main',
      connectionId: connection.id,
      modelId: 'fixture',
      temperature: null,
      maxOutputTokens: 1024,
      inputTokenLimit: 272000,
    });
    const helper = store.product.model({
      title: 'Helper',
      connectionId: connection.id,
      modelId: 'other',
      temperature: null,
      maxOutputTokens: 1024,
    });
    const workspace = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: workspace.revision,
      routes: { ...workspace.routes, main: { id: model.id } },
      translationPolicy: workspace.translationPolicy,
    });
    const bot = store.product.content(fixtureBotInput()) as Content;
    const chat = importChatTranscript(store, {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: 'Current summary',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: Array.from({ length: count }, (_, i) => ({
          request: 'Request ' + i,
          text: ('Scene ' + i + '. ' + 'river '.repeat(600)).slice(0, 3000),
          translation: null,
        })),
      },
    }).chat;
    const branch = store.product.branch(chat.id);
    const snapshot = () =>
      prepareNativeRisuReadOnly(
        helperWritingSnapshot(store, chat.id, branch.id, 'context'),
        'context'
      );
    return { store, chat, branch, model, helper, bot, snapshot };
  }

  test('current summaries do not retain full inputs or detail receipts after repeated jobs and edits', async () => {
    const { store, chat, branch, snapshot } = fixture(4);
    for (let i = 0; i < 2; i++) {
      const input = await snapshot(),
        current = store.context.current(chat.id);
      const job = store.context.schedule(
        chat.id,
        {
          expectedRevision: current.activeRevision,
          expectedHeadRevision: branch.headRevision,
          idempotencyKey: randomUUID(),
        },
        input
      );
      store.context.start(job.id);
      const plan = {
        ...input.contextPlan!,
        status: 'ready' as const,
        compacted: contextSourceRefs(input).slice(0, 2),
        recentSourceRevisions: input.history.slice(2).map((s) => s.revision),
        summary: 'Summary ' + i,
        estimatedInputTokens: 1000,
      };
      store.context.finish(job.id, { ...input, contextPlan: plan });
      const detail = store.context.detail(chat.id);
      expect(detail.jobs.every((j) => !('snapshot' in j))).toBe(true);
      const body = {
        expectedRevision: detail.activeRevision,
        expectedHeadRevision: branch.headRevision,
        idempotencyKey: randomUUID(),
        summary: 'Edited ' + i,
      };
      const saved = store.context.edit(chat.id, body, await snapshot());
      expect(store.context.edit(chat.id, body, await snapshot()).activeRevision).toBe(
        saved.activeRevision
      );
    }
    expect(
      store.db
        .prepare('PRAGMA table_info(context_checkpoints)')
        .all()
        .map((r) => r.name)
    ).not.toContain('snapshot');
    expect(store.db.prepare('SELECT count(*) AS n FROM context_checkpoints').get()?.n).toBe(1);
    expect(
      store.db.prepare('SELECT count(*) AS n FROM context_jobs WHERE snapshot IS NOT NULL').get()?.n
    ).toBe(0);
    expect(
      Buffer.byteLength(JSON.stringify(store.db.prepare('SELECT * FROM context_commands').all()))
    ).toBeLessThan(4000);
    expect(store.context.current(chat.id)).toMatchObject({
      usable: true,
      checkpoint: { plan: { summary: 'Edited 1' } },
    });
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('unrelated helper and translation settings do not invalidate the main summary', async () => {
    const { store, chat, branch, helper, snapshot } = fixture();
    store.context.edit(
      chat.id,
      {
        expectedRevision: 0,
        expectedHeadRevision: branch.headRevision,
        idempotencyKey: 'summary',
        summary: 'A factual source summary.',
      },
      await snapshot()
    );
    const initial = store.context.current(chat.id);
    expect(initial.usable).toBe(true);
    const models = modelWorkspace(store);
    updateModelWorkspace(store, {
      expectedRevision: models.revision,
      helperModel: { id: helper.id },
      routes: { ...models.routes, translation: { id: helper.id } },
      translationPolicy: models.translationPolicy,
    });
    expect(store.context.current(chat.id)).toMatchObject({
      usable: true,
      checkpoint: initial.checkpoint,
    });
    const workspace = promptWorkspace(store);
    updatePromptWorkspace(store, {
      expectedRevision: workspace.revision,
      translation: {
        ...workspace.translation,
        program: nativePrompt('A new translation-only rule.', {}, 'translation'),
        values: {},
        defaultValues: {},
      },
    });
    expect(store.context.current(chat.id).usable).toBe(true);
    const next = promptWorkspace(store);
    updatePromptWorkspace(store, {
      expectedRevision: next.revision,
      main: {
        ...next.main,
        program: nativePrompt('A genuinely different main instruction.'),
        values: {},
        defaultValues: {},
      },
    });
    expect(store.context.current(chat.id).usable).toBe(false);
  });
});
