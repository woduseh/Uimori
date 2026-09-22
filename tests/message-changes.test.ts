import { expect, test } from 'vitest';
import { applyMessageChanges, messageChanges } from '../core/message-changes.js';
import type { PromptHistoryMessage } from '../core/risu-prompt.js';

const message = (id: string, text: string, hash = 'source-hash'): PromptHistoryMessage => ({
  id,
  text,
  role: 'assistant',
  sourceRevision: id,
  sourceHash: hash,
});

test('an unchanged native conversation stores no repeated message bodies', () => {
  const before = Array.from({ length: 300 }, (_, index) =>
    message(`source:${index}`, 'Long source '.repeat(1000))
  );
  expect(messageChanges(before, before, new Set(before.map((item) => item.id)))).toBeUndefined();
});

test('changed source text stores only the changed body and newer user edits win', () => {
  const before = [message('source:a', 'A'), message('source:b', 'B')];
  const changes = messageChanges(
    before,
    [before[0], { ...before[1], text: 'Lua changed B' }],
    new Set(['source:a', 'source:b'])
  )!;
  expect(changes.updated).toHaveLength(1);
  expect(changes.order).toBeUndefined();
  expect(applyMessageChanges(before, changes)[1].text).toBe('Lua changed B');
  const edited = [before[0], message('source:b', 'User corrected B', 'new-source-hash')];
  expect(applyMessageChanges(edited, changes)[1].text).toBe('User corrected B');
  const later = messageChanges(
    edited,
    [edited[0], { ...edited[1], text: 'New Lua edit' }],
    new Set(['source:b'])
  )!;
  expect(applyMessageChanges(edited, later)[1].text).toBe('New Lua edit');
});

test('Lua insertion, removal and reordering preserve roles without copying unchanged bodies', () => {
  const before = [message('source:a', 'A'), message('source:b', 'B'), message('source:c', 'C')];
  const added: PromptHistoryMessage = { id: 'native:new:1', role: 'user', text: 'Script reply' };
  const after = [before[2], added, before[0]];
  const changes = messageChanges(before, after, new Set(before.map((item) => item.id)))!;
  expect(changes.removed).toEqual(['source:b']);
  expect(changes.updated).toEqual([{ message: added }]);
  expect(applyMessageChanges(before, changes)).toEqual(after);
});
