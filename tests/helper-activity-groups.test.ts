import { expect, test } from 'vitest';
import type { HelperActivity, HelperActivityEvent } from '../core/helper-activity.js';
import { helperActivityStages } from '../web/helper-activity.js';
import { groupHelperActivity, isHelperReadTool } from '../web/helper-activity-groups.js';

const call = (
  seq: number,
  name: string,
  target?: HelperActivityEvent['target'],
  finished: Partial<HelperActivityEvent> | null = {}
): HelperActivityEvent[] => [
  { seq, kind: 'tool.started', callId: `call-${seq}`, name, ...(target ? { target } : {}) },
  ...(finished
    ? [{ seq: seq + 1, kind: 'tool.finished', callId: `call-${seq}`, name, ...finished }]
    : []),
];
const rows = (events: HelperActivityEvent[], status: HelperActivity['status'] = 'running') =>
  groupHelperActivity(
    helperActivityStages({ taskId: 'task', status, hasEarlier: false, helperCalls: 0, events })
  );

test('read, list, search and inspect calls are reads; writes and the shell are not', () => {
  for (const name of [
    'resource.read',
    'resource.list',
    'data.search',
    'task.inspect',
    'tool.guide',
    'scene.versions',
    'scene.lore',
    'scene.regex',
  ])
    expect(isHelperReadTool(name), name).toBe(true);
  for (const name of ['resource.patch', 'scene.patch', 'settings.update', 'data.exec', undefined])
    expect(isHelperReadTool(name), String(name)).toBe(false);
});

test('consecutive reads fold into one row that counts scenes, resources and other lookups', () => {
  const result = rows([
    ...call(1, 'scene.read', { kind: 'scene', title: '첫 장면' }),
    ...call(3, 'scene.read', { kind: 'scene', title: '첫 장면' }),
    ...call(5, 'scene.read', { kind: 'scene', title: '둘째 장면' }),
    ...call(7, 'resource.read', { kind: 'content', title: '등대지기 미라' }),
    ...call(9, 'data.search'),
    ...call(11, 'resource.patch', { kind: 'content', title: '등대지기 미라' }),
    ...call(13, 'resource.read', { kind: 'content', title: '등대지기 미라' }),
  ]);
  expect(result.map((row) => row.kind)).toEqual(['reads', 'stage', 'stage']);
  expect(result[0]).toMatchObject({
    state: 'completed',
    summary: { scenes: 2, resources: 1, lookups: 1 },
  });
  expect(result[0]!.kind === 'reads' && result[0]!.stages.map((stage) => stage.target)).toEqual([
    '첫 장면',
    '첫 장면',
    '둘째 장면',
    '등대지기 미라',
    undefined,
  ]);
  expect(result[1]).toMatchObject({ stage: { events: [{ name: 'resource.patch' }] } });
});

test('a running read joins its group, a failed read stands alone and finishing pairs by call id', () => {
  const running = rows([
    ...call(1, 'resource.read', { kind: 'content', title: 'A' }),
    ...call(3, 'resource.read', { count: 3 }, null),
  ]);
  expect(running).toMatchObject([
    { kind: 'reads', state: 'running', summary: { resources: 4, scenes: 0, lookups: 0 } },
  ]);
  const settled = rows(
    [
      ...call(1, 'resource.read', { kind: 'content', title: 'A' }),
      ...call(3, 'resource.read', { count: 3 }, null),
      { seq: 9, kind: 'tool.finished', callId: 'call-3', name: 'resource.read' },
      ...call(10, 'resource.read', undefined, { error: 'NOT_FOUND' }),
      ...call(12, 'data.search'),
    ],
    'completed'
  );
  expect(settled).toMatchObject([
    { kind: 'reads', state: 'completed', stages: [{ id: 1 }, { id: 3 }] },
    { kind: 'stage', stage: { state: 'issue' } },
    { kind: 'stage', stage: { id: 12 } },
  ]);
  const interrupted = rows(
    [
      ...call(1, 'scene.read', { kind: 'scene' }),
      ...call(3, 'scene.read', { kind: 'scene' }, null),
    ],
    'cancelled'
  );
  expect(interrupted).toMatchObject([{ kind: 'reads', state: 'stopped', summary: { scenes: 2 } }]);
});
