import { expect, test, vi } from 'vitest';

vi.mock('../web/unsaved-input.js', () => ({
  hasUnsavedInput: (touch: { domain: string }) => touch.domain === 'outline',
  useUnsavedInputVersion: () => 0,
}));
import type { HelperRollbackUnit, HelperRollbackView } from '../core/helper.js';
import {
  clearRollbackFailures,
  mergeRollbackResults,
  recordRollbackFailures,
  rollbackSelection,
} from '../web/HelperTaskRollback.js';

const unit = (
  name: string,
  status: HelperRollbackUnit['status'] = 'restorable',
  error?: string
): HelperRollbackUnit => ({
  unit: name,
  domain: 'resource',
  title: name,
  changeTargetIds: [name],
  status,
  touches: null,
  ...(error ? { error } : {}),
});
const restoreNames = (value: HelperRollbackView, target: string | null) =>
  rollbackSelection(value, { unit: target }).restore.map((item) => item.unit);

test('after a partial rollback failure only the failed unit is offered and requested again', () => {
  const initial: HelperRollbackView = {
    taskId: 'task',
    blocked: null,
    units: [unit('a'), unit('b'), unit('c')],
  };
  expect(rollbackSelection(initial, { unit: null }).bodies).toEqual([{}]);

  const results = [unit('a', 'restored'), unit('b', 'failed', 'disk full'), unit('c', 'restored')];
  const view = mergeRollbackResults(initial, results)!;
  const failures = recordRollbackFailures({}, results);
  expect(view.units.map((item) => [item.unit, item.status])).toEqual([
    ['a', 'restored'],
    ['b', 'restorable'],
    ['c', 'restored'],
  ]);
  expect(failures).toEqual({ b: 'disk full' });

  expect(restoreNames(view, null)).toEqual(['b']);
  expect(rollbackSelection(view, { unit: 'b' }).bodies).toEqual([{ unit: 'b' }]);
  expect(restoreNames(view, 'a')).toEqual([]);

  const retrying = clearRollbackFailures(
    { ...failures, d: 'other' },
    rollbackSelection(view, { unit: 'b' }).restore
  );
  expect(retrying).toEqual({ d: 'other' });
  const retried = [unit('b', 'restored')];
  expect(
    mergeRollbackResults(view, retried)!.units.every((item) => item.status === 'restored')
  ).toBe(true);
  expect(recordRollbackFailures(retrying, retried)).toBe(retrying);
});

test('a run whose every unit failed leaves the view and earlier failures untouched apart from the new errors', () => {
  const view: HelperRollbackView = { taskId: 'task', blocked: null, units: [unit('a'), unit('b')] };
  const results = [unit('a', 'failed'), unit('b', 'failed', 'locked')];
  expect(mergeRollbackResults(view, results)).toBe(view);
  expect(recordRollbackFailures({ z: 'older' }, results)).toEqual({
    z: 'older',
    a: '',
    b: 'locked',
  });
});

test('an unsaved draft is left out of a full rollback request so only saved units are sent', () => {
  const view: HelperRollbackView = {
    taskId: 'task',
    blocked: null,
    units: [unit('a'), { ...unit('b'), touches: { domain: 'outline', chatId: 'chat' } }, unit('c')],
  };
  const chosen = rollbackSelection(view, { unit: null });
  expect(chosen.restore.map((item) => item.unit)).toEqual(['a', 'c']);
  expect(chosen.drafts.map((item) => item.unit)).toEqual(['b']);
  expect(chosen.bodies).toEqual([{ unit: 'a' }, { unit: 'c' }]);
});
