import { expect, test } from 'vitest';
import type { Job } from '../core/types.js';
import { displayTranslationJob } from '../web/translation-display.js';
const source = { id: 'source', hash: 'hash' };
const result = { mock: false, sourceRevision: 'source', sourceHash: 'hash', text: '완료 번역' };
const job = (status: Job['status']) =>
  ({
    id: 'new',
    revision: 2,
    kind: 'translation',
    sourceRevision: 'source',
    sourceHash: 'hash',
    status,
    result: { ...result, text: '죄송하지만 번역할 수 없습니다.' },
  }) as Job;
test('new pending, refused and failed candidates preserve the previous successful translation', () => {
  for (const status of ['queued', 'running', 'failed', 'partial', 'cancelled'] as Job['status'][]) {
    expect(displayTranslationJob(source, job(status))).toBeUndefined();
    const displayed = displayTranslationJob(source, {
      ...job(status),
      previousResult: { jobId: 'old', revision: 1, result },
    });
    expect(displayed?.id).toBe('old');
    expect(displayed?.result?.text).toBe('완료 번역');
  }
});
test('completed replacement wins and stale source identity never displays', () => {
  const completed = {
    ...job('completed'),
    result,
    previousResult: { jobId: 'old', revision: 1, result },
  };
  expect(displayTranslationJob(source, completed)?.id).toBe('new');
  expect(displayTranslationJob({ ...source, hash: 'changed' }, completed)).toBeUndefined();
  expect(
    displayTranslationJob(source, {
      ...job('failed'),
      previousResult: { jobId: 'old', revision: 1, result: { ...result, sourceHash: 'old-hash' } },
    })
  ).toBeUndefined();
});
