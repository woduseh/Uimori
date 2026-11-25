import { afterEach, expect, test, vi } from 'vitest';
import {
  readFontSize,
  readPresentationChoice,
  readPresentationSetting,
  watchPresentationWriteFailure,
  writePresentationSetting,
} from '../web/presentation-settings.js';
import { fitSidePanelWidth, readSidePanelWidth } from '../web/side-panel.js';

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

test('the right panel width keeps a stored preset, clamps other values and survives refused storage', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  expect(readSidePanelWidth()).toBe(384);
  for (const [value, expected] of [
    ['480', 480],
    ['10', 360],
    ['9999', 960],
    ['oops', 384],
    ['', 384],
  ] as const) {
    values.set('uimori:panel-width', value);
    expect(readSidePanelWidth()).toBe(expected);
  }
  expect(fitSidePanelWidth(600, 360, 500)).toBe(500);
  expect(fitSidePanelWidth(300, 400, 616)).toBe(400);
  expect(fitSidePanelWidth(480, 360, 276)).toBe(480);
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('Storage disabled');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
  });
  expect(readSidePanelWidth()).toBe(384);
});

test('a refused write is reported once storage refuses it and an unset numeric choice keeps its fallback', () => {
  const values = new Map<string, string>([['uimori:sidebar-width', '400']]);
  let full = true;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full && !values.has(key)) throw new Error('Quota exceeded');
      values.set(key, value);
    },
  });
  const failures = vi.fn();
  const stop = watchPresentationWriteFailure(failures);
  writePresentationSetting('uimori:sidebar-width', '320');
  expect(failures).not.toHaveBeenCalled();
  writePresentationSetting('uimori:new-setting', '1');
  expect(failures).toHaveBeenCalledTimes(1);
  full = false;
  writePresentationSetting('uimori:new-setting', '1');
  expect(failures).toHaveBeenCalledTimes(1);
  stop();
  expect(readPresentationChoice('uimori:unset', [0, 1], 1)).toBe(1);
  values.set('uimori:unset', '0');
  expect(readPresentationChoice('uimori:unset', [0, 1], 1)).toBe(0);
});
