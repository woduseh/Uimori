import { expect, test } from 'vitest';
import { createComposerDraft } from '../web/composer-draft.js';

test('composer draft notifies subscribers only when its text changes', () => {
  const draft = createComposerDraft();
  const seen: string[] = [];
  const unsubscribe = draft.subscribe(() => seen.push(draft.read()));
  draft.write('다음 장면');
  draft.write('다음 장면');
  draft.write('');
  unsubscribe();
  draft.write('구독 해제 후');
  expect(seen).toEqual(['다음 장면', '']);
  expect(draft.read()).toBe('구독 해제 후');
});
