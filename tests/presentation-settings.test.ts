import { afterEach, expect, test, vi } from 'vitest';
import {
  readFontSize,
  readPresentationChoice,
  readPresentationSetting,
  writePresentationSetting,
} from '../web/presentation-settings.js';

afterEach(() => vi.unstubAllGlobals());

test('optional presentation storage can fail without losing a usable session', () => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('Storage disabled');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
  });
  expect(readPresentationSetting('uimori:font')).toBeNull();
  expect(readPresentationChoice('uimori:response-display', ['stream', 'complete'], 'stream')).toBe(
    'stream'
  );
  expect(readFontSize()).toBe(18);
  expect(() => writePresentationSetting('uimori:response-display', 'complete')).not.toThrow();
});

test('browser preferences restore supported values and repair invalid font sizes', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const mode = () =>
    readPresentationChoice('uimori:response-display', ['stream', 'complete'], 'stream');
  expect(mode()).toBe('stream');
  writePresentationSetting('uimori:response-display', 'complete');
  expect(mode()).toBe('complete');
  writePresentationSetting('uimori:response-display', 'unknown');
  expect(mode()).toBe('stream');
  for (const value of ['NaN', 'Infinity', 'oops', '', ' ']) {
    values.set('uimori:font-size', value);
    expect(readFontSize()).toBe(18);
  }
  for (const [value, expected] of [
    ['12', 12],
    ['4', 9],
    ['99', 28],
  ] as const) {
    values.set('uimori:font-size', value);
    expect(readFontSize()).toBe(expected);
  }
  values.set('uimori:reading-width', '1040');
  expect(readPresentationChoice('uimori:reading-width', [760, 880, 1040], 880)).toBe(1040);
  values.set('uimori:reading-width', 'bad');
  expect(readPresentationChoice('uimori:reading-width', [760, 880, 1040], 880)).toBe(880);
});
