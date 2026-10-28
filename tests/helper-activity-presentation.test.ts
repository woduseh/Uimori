import { expect, test } from 'vitest';
import type { HelperActivity } from '../core/helper-activity.js';
import { helperActivityStages, helperActivitySummary } from '../web/helper-activity.js';

test('successful lookups group while each confirmed change keeps its own stage and original record', () => {
  const activity: HelperActivity = {
    taskId: 'observed-tools',
    status: 'running',
    hasEarlier: false,
    events: [
      { seq: 1, kind: 'tool.finished', name: 'resource.read' },
      { seq: 2, kind: 'tool.finished', name: 'data.search' },
      { seq: 3, kind: 'tool.finished', name: 'resource.patch' },
      { seq: 4, kind: 'tool.finished', name: 'resource.patch' },
    ],
  };
  const stages = helperActivityStages(activity);
  expect(stages.map((stage) => stage.events.map((event) => event.seq))).toEqual([[1, 2], [3], [4]]);
  expect(stages.flatMap((stage) => stage.events)).toEqual(activity.events);
  expect(stages.every((stage) => stage.state === 'completed')).toBe(true);
  expect(helperActivitySummary(activity)).toBeUndefined();
});
