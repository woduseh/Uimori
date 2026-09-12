import { expect, test } from 'vitest';
import { DEFAULT_READABILITY, normalizeReadability } from '../web/reading-preferences.js';

test('untrusted browser reading preferences fall back without enabling transformations', () => {
  for (const value of [
    null,
    false,
    'dialogue',
    [],
    {
      emphasis: 'html',
      dialogueBreaks: 'true',
      lineHeight: Infinity,
      paragraphSpacing: -1,
      quoteRoles: { corner: 'script' },
    },
  ]) {
    expect(normalizeReadability(value)).toEqual(DEFAULT_READABILITY);
  }
  const restored = normalizeReadability({
    emphasis: 'subtle',
    dialogueBreaks: true,
    thoughtBreaks: false,
    lineHeight: 2.2,
    paragraphSpacing: 1.5,
    quoteRoles: { doubleCorner: 'thought', single: 'off' },
  });
  expect(restored).toMatchObject({
    emphasis: 'subtle',
    dialogueBreaks: true,
    lineHeight: 2.2,
    paragraphSpacing: 1.5,
    quoteRoles: { doubleCorner: 'thought', single: 'off', corner: 'dialogue' },
  });
  restored.quoteRoles.corner = 'off';
  expect(normalizeReadability(null).quoteRoles.corner).toBe('dialogue');
  expect(normalizeReadability({ lineHeight: 1.75, paragraphSpacing: 0.75 })).toMatchObject({
    lineHeight: null,
    paragraphSpacing: null,
  });
});
