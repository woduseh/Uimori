import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { PromptPreset } from '../core/product.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';
import { Store } from '../server/store.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-resource-inspection-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-resource-inspection-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ store, path });
  return store;
}
const call = (store: Store, name: string, args: Record<string, unknown>) =>
  invokeResourceTool(store, name, args) as Record<string, any>;
const preset = (store: Store, title: string, text = 'Original {{getglobalvar::toggle_mode}}') =>
  store.product.promptPreset({
    title,
    role: 'main',
    program: nativePrompt(text, { customPromptTemplateToggle: 'mode=Mode=select=Story,Notes' }),
    values: { mode: '1' },
  }) as PromptPreset;

test('typed multi-resource reads preserve independent identities, missing fields and local errors without writes', () => {
  const store = fixture();
  const first = preset(store, 'RP');
  const second = preset(store, 'Novel');
  const before = store.db.prepare('SELECT * FROM versions ORDER BY kind,id').all();
  const result = call(store, 'resource.readMany', {
    items: [
      { kind: 'prompt-preset', id: first.id, path: '/values/mode' },
      {
        kind: 'prompt-preset',
        id: second.id,
        path: '/program/nativeRisuPreset/preset/promptTemplate',
      },
      { kind: 'prompt-preset', id: first.id, path: '/values/missing' },
      { kind: 'prompt-preset', id: second.id, paths: ['/values'] },
      { kind: 'prompt-preset', id: 'absent' },
    ],
  });
  expect(result.nextIndex).toBeNull();
  expect(result.items[0]).toMatchObject({
    requestIndex: 0,
    result: { id: first.id, revision: 1, text: '1' },
  });
  expect(result.items[1]).toMatchObject({
    requestIndex: 1,
    result: { id: second.id, revision: 1, type: 'array' },
  });
  expect(result.items[2].result).toMatchObject({ id: first.id, exists: false });
  expect(result.items[3]).toMatchObject({ requestIndex: 3, status: 400 });
  expect(result.items[4]).toMatchObject({ requestIndex: 4, status: 404 });
  expect(store.db.prepare('SELECT * FROM versions ORDER BY kind,id').all()).toEqual(before);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM resource_undo').get()).toEqual({ n: 0 });
});

test('multi-resource text pages share a bounded envelope and continue unread selections separately', () => {
  const store = fixture();
  const body = '"\\\n한글'.repeat(8000);
  const a = preset(store, 'RP', body);
  const b = preset(store, 'Novel', body);
  const items = [a, b].map((item) => ({
    kind: 'prompt-preset',
    id: item.id,
    path: '/program/nativeRisuPreset/preset/promptTemplate/0/text',
    textLimit: 10000,
  }));
  const first = call(store, 'resource.readMany', { items });
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(24000);
  expect(first.nextIndex).toBe(1);
  expect(first.items[0].result).toMatchObject({ id: a.id, textOffset: 0 });
  expect(first.items[0].result.nextOffset).toBeGreaterThan(0);
  expect(first.items[0].result.text).toBe(body.slice(0, first.items[0].result.nextOffset));
  const second = call(store, 'resource.readMany', { items: items.slice(first.nextIndex) });
  expect(second.nextIndex).toBeNull();
  expect(second.items[0].result.id).toBe(b.id);
  expect(JSON.stringify(second).length).toBeLessThanOrEqual(24000);
});

test('preset inspection compares retained option meaning without evaluating CBS or creating another revision', () => {
  const store = fixture();
  const saved = preset(store, 'Options', '{{setvar::do_not_execute::1}}{{#when broken');
  call(store, 'resource.patch', {
    kind: 'prompt-preset',
    id: saved.id,
    expectedRevision: 1,
    changes: [
      {
        op: 'set',
        path: '/program/nativeRisuPreset/preset/customPromptTemplateToggle',
        value: 'mode=Mode=select=Notes,Story',
      },
    ],
  });
  const before = store.product.get('prompt-preset', saved.id);
  const undo = store.db.prepare('SELECT * FROM resource_undo').all();
  const report = call(store, 'preset.validate', { id: saved.id, limit: 1 });
  expect(report).toMatchObject({
    id: saved.id,
    revision: 2,
    comparedWithPrevious: true,
    nextOffset: 1,
    coverage: { cbsSyntax: false, cbsComparisons: false, variables: false },
    diagnostics: [{ code: 'toggle_option_meaning_changed' }],
  });
  const rest = call(store, 'preset.validate', { id: saved.id, offset: report.nextOffset });
  expect(rest.nextOffset).toBeNull();
  expect(rest.diagnostics).toHaveLength(1);
  expect(store.product.get('prompt-preset', saved.id)).toEqual(before);
  expect(store.db.prepare('SELECT * FROM resource_undo').all()).toEqual(undo);
});
