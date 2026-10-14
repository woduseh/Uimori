import { expect, test } from 'vitest';
import {
  canAcknowledge,
  translationResolved,
  type ActivityNoticeItem,
} from '../web/activity-notices.js';

const original: ActivityNoticeItem = {
  key: 'old',
  acknowledgementKey: 'old',
  kind: 'translation',
  status: 'interrupted',
  runId: 'old',
  startedAt: '2026-10-14T01:00:00Z',
  finishedAt: '2026-10-14T01:01:00Z',
  sourceRevision: 'source-1',
  sourceHash: 'hash-1',
};

test('uncertain finished executions may be acknowledged, but are never auto-acknowledged', () => {
  const uncertain = { ...original, executionUncertain: true };
  const replacement: ActivityNoticeItem = {
    ...original,
    key: 'new',
    acknowledgementKey: 'new',
    runId: 'new',
    status: 'completed',
    startedAt: '2026-10-14T02:00:00Z',
  };
  expect(canAcknowledge(uncertain)).toBe(true);
  expect(translationResolved(uncertain, [uncertain, replacement])).toBe(false);
  expect(translationResolved({ ...uncertain, superseded: true }, [uncertain])).toBe(false);
  expect(translationResolved(original, [original, replacement])).toBe(true);
  expect(canAcknowledge({ ...original, kind: 'request', status: 'uncertain' })).toBe(false);
  expect(canAcknowledge({ ...original, status: 'running' })).toBe(false);
});
