import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultProfile, type ModelSnapshot } from '../core/product.js';
import type { SourceSegmentPolicy } from '../core/source-segments.js';
import type { RunSnapshot } from '../core/types.js';
import {
  contextSourceRefs,
  previousContextPlan,
  seedContextPlan,
  validateContextPlan,
} from '../server/context-planning.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';

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

function fixture(sourceSegments?: SourceSegmentPolicy) {
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
      settings: { ...chat.settings, translation: false, status: false, maxCalls: 16 },
      request: '다음 장면을 이어 주세요.',
      history: structuredClone(history),
      resources: [],
      profile: { ...defaultProfile(chat.id), contents: [], models: { main: model } },
      ...(sourceSegments ? { sourceSegments } : {}),
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
    changed.profile!.contents.push({
      id: 'new-canon',
      revision: 1,
      kind: 'module',
      title: '새 정사 자료',
      description: '',
      text: '약속의 의미가 달라졌어요.',
      loading: 'pinned',
      relatedIds: [],
    });
    expect(previousContextPlan(f.store, seedContextPlan(changed))).toBeUndefined();
  });

  test('rejects expired source-segment views even when original text and hashes are unchanged', () => {
    const f = fixture(
      createSourceSegmentFixture({ excludeAnnotations: false, keepLastMessages: 5 })
    );
    const old = f.checkpoint(1, '보존창 안에서 읽은 기록 요약');
    const current = contextSourceRefs(f.current)[0];
    expect(current.hash).toBe(old.contextPlan!.compacted[0].hash);
    expect(current.viewHash).not.toBe(old.contextPlan!.compacted[0].viewHash);
    expect(previousContextPlan(f.store, f.capture())).toBeUndefined();
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
