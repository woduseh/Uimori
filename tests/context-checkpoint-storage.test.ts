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
  const chat = createFixtureChat(store, 'Synthetic checkpoint ancestry');
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
    history.push({ revision: sourceId, text, contentHash: hash(text) });
  }
  const save = (index: number, value: RunSnapshot) => {
    snapshots[index] = structuredClone(value);
    store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(value), `run-${index}`);
  };
  const checkpoint = (index: number, summary: string) => {
    const value = structuredClone(snapshots[index]);
    value.contextPlan = {
      ...value.contextPlan!,
      status: 'ready',
      compacted: contextSourceRefs(value).slice(0, 1),
      recentSourceRevisions: value.history.slice(1).map((source) => source.revision),
      summary,
      estimatedInputTokens: 100,
    };
    validateContextPlan(value);
    save(index, value);
    return value;
  };
  return { store, current: snapshot(), snapshots, save, checkpoint };
}

describe('stored context checkpoint selection', () => {
  test('returns no checkpoint for unsummarized ancestors, including absent and null plans', () => {
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
    expect(previousContextPlan(f.store, f.current)).toBeUndefined();
  });

  test('uses ancestry order, skips a newer unsummarized run and returns independent copies', () => {
    const f = fixture();
    f.checkpoint(1, '오래된 유효 요약');
    const newest = f.checkpoint(2, '최신 유효 요약');
    f.store.db
      .prepare('UPDATE runs SET created_at=?,updated_at=? WHERE id=?')
      .run('9999-01-01', '9999-01-01', 'run-1');
    const selected = previousContextPlan(f.store, f.current)!;
    expect(selected).toEqual(newest.contextPlan);
    selected.summary = '호출자 변경';
    selected.compacted[0].hash = '호출자 변경';
    expect(previousContextPlan(f.store, f.current)).toEqual(newest.contextPlan);
    expect(f.store.run('run-2').snapshot.contextPlan).toEqual(newest.contextPlan);
  });

  test.each(['invalid-source', 'invalid-budget', 'dependency', 'pending', 'failed'])(
    'falls back to an older valid checkpoint after a newer %s candidate',
    (reason) => {
      const f = fixture();
      const old = f.checkpoint(1, '오래된 유효 요약');
      const newer = f.checkpoint(2, '선택하면 안 되는 요약');
      const plan = newer.contextPlan!;
      if (reason === 'invalid-source') plan.compacted[0].hash = 'wrong-hash';
      else if (reason === 'invalid-budget') plan.budget.inputTokenLimit = 100;
      else if (reason === 'dependency') plan.dependencyKey = 'other-canon';
      else plan.status = reason === 'pending' ? 'pending' : 'failed';
      f.save(2, newer);
      expect(previousContextPlan(f.store, f.current)).toEqual(old.contextPlan);
    }
  );

  test('rejects reuse after current source edits or changed semantic dependencies', () => {
    const f = fixture();
    f.checkpoint(1, '과거 원문 요약');
    const edited = structuredClone(f.current);
    edited.history[0].text = '사용자가 수정한 원문';
    edited.history[0].contentHash = hash(edited.history[0].text);
    expect(previousContextPlan(f.store, edited)).toBeUndefined();
    const changed = structuredClone(f.current);
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
    expect(previousContextPlan(f.store, f.current)).toBeUndefined();
  });

  test.each(['id', 'chatId', 'blank', 'hash'])(
    'still rejects invalid source identity: %s',
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
      current.revision = id;
      expect(() => previousContextPlan(f.store, f.current)).toThrow('SOURCE_IDENTITY_INVALID');
    }
  );

  test('preserves 404 errors for missing ancestors and missing originating runs', () => {
    const f = fixture();
    const missing = structuredClone(f.current);
    missing.history.at(-1)!.revision = 'missing-source';
    expect(() => previousContextPlan(f.store, missing)).toThrow(
      expect.objectContaining({ statusCode: 404, message: 'Source not found' })
    );
    f.store.db.exec('PRAGMA foreign_keys=OFF');
    f.store.db.prepare('DELETE FROM runs WHERE id=?').run('run-3');
    f.store.db.exec('PRAGMA foreign_keys=ON');
    expect(() => previousContextPlan(f.store, f.current)).toThrow(
      expect.objectContaining({ statusCode: 404, message: 'Run not found' })
    );
  });
});
