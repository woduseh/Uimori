import { expect, test } from 'vitest';
import { storyUiDraftChanges } from '../web/story-ui-draft.js';

test('repeated-row input drafts preserve separately translated labels', () => {
  expect(
    storyUiDraftChanges(
      {
        people: [
          { name: 'Alice', note: '' },
          { name: 'Bob', note: '' },
        ],
      },
      {
        people: [
          { name: 'Alice', note: 'Meet at noon' },
          { name: 'Bob', note: '' },
        ],
      }
    )
  ).toEqual([{ path: '/people/0/note', value: 'Meet at noon' }]);
});
