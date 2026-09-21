import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Job, Source } from '../core/types.js';
import type { Store } from '../server/store.js';
import {
  successfulTranslation,
  validateTranslationArtifact,
} from '../server/translation-artifacts.js';

const source: Source = {
  id: 'source',
  chatId: 'chat',
  runId: 'run',
  parentRevision: null,
  text: 'Original',
  hash: 'source-hash',
};
function job(): Job {
  return {
    id: 'translation',
    chatId: source.chatId,
    sourceRevision: source.id,
    sourceHash: source.hash,
    kind: 'translation',
    status: 'completed',
    attempt: 1,
    error: null,
    result: {
      mock: false,
      text: '번역',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
  };
}

test('translation validation is read-only for authored and generated results', () => {
  for (const manual of [false, true]) {
    const value = job();
    if (manual) value.result!.manual = true;
    const before = structuredClone(value);
    Object.freeze(value.result);
    Object.freeze(value);
    expect(() => validateTranslationArtifact(value, source)).not.toThrow();
    expect(value).toEqual(before);
  }
});

test.each(['source-id', 'result-hash', 'job-hash', 'empty', 'manual-mock', 'unknown'] as const)(
  'translation artifact validation rejects %s',
  (kind) => {
    const value = job();
    if (kind === 'source-id') value.result!.sourceRevision = 'other-source';
    if (kind === 'result-hash') value.result!.sourceHash = 'other-hash';
    if (kind === 'job-hash') value.sourceHash = 'other-hash';
    if (kind === 'empty') value.result!.text = '';
    if (kind === 'manual-mock') Object.assign(value.result!, { manual: true, mock: true });
    if (kind === 'unknown') Object.assign(value.result!, { unknown: true });
    expect(() => validateTranslationArtifact(value, source)).toThrow();
  }
);

test('successful translation selection keeps result, source, kind and ordering constraints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, source_revision TEXT, source_hash TEXT, kind TEXT,
        status TEXT, revision INTEGER, created_at TEXT
      );
      CREATE TABLE job_results (job_id TEXT PRIMARY KEY);
    `);
    const put = (
      id: string,
      revision: number,
      hash = source.hash,
      status = 'completed',
      result = true,
      kind = 'translation',
      timestamp = '2026-01-01T00:00:00Z'
    ) => {
      db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(
        id,
        source.id,
        hash,
        kind,
        status,
        revision,
        timestamp
      );
      if (result) db.prepare('INSERT INTO job_results VALUES(?)').run(id);
    };
    const store = { db, job: (id: string) => ({ ...job(), id }) } as unknown as Store;
    expect(successfulTranslation(store, source)).toBeNull();
    put('old', 1);
    put('chosen-a', 2);
    put('chosen-b', 2);
    put('wrong-hash', 100, 'old-source-hash');
    put('unfinished', 100, source.hash, 'running');
    put('no-result', 100, source.hash, 'completed', false);
    put('image', 100, source.hash, 'completed', true, 'image');
    expect(successfulTranslation(store, source)?.id).toBe('chosen-b');
    put('later', 2, source.hash, 'completed', true, 'translation', '2026-01-02T00:00:00Z');
    expect(successfulTranslation(store, source)?.id).toBe('later');
    expect(successfulTranslation(store, { ...source, id: 'absent' })).toBeNull();
  } finally {
    db.close();
  }
});
