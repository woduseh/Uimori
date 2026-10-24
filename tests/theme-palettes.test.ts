import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import {
  savePalette,
  deletePalette,
  selectTheme,
  themeCatalog,
  themePreferences,
  themeRoutes,
} from '../server/themes.js';
import { paletteFile, parsePaletteFile, validatePalette } from '../core/palette-files.js';
import { resolveTheme, resolvePaletteId } from '../core/themes.js';
const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-palettes-'));
  const store = new Store(join(directory, 'app.sqlite'));
  owned.push({ store, directory });
  return store;
}
const model = {
  title: '밤의 종이',
  description: '공유 색상',
  colors: { light: { bg: '#fafafa', accent: '#123456' }, dark: { bg: '#111111' } },
};
test('portable palettes strip identity and reject executable or unknown colors', () => {
  expect(
    parsePaletteFile({ ...paletteFile(model), palette: { ...model, id: 'elsewhere', revision: 5 } })
  ).toEqual(model);
  expect(() =>
    parsePaletteFile({ format: 'uimori-palette', version: 2, palette: model })
  ).toThrow();
  expect(() =>
    validatePalette({ ...model, colors: { light: { accent: 'red;display:none' } } })
  ).toThrow();
  expect(() => validatePalette({ ...model, colors: { light: { unknown: '#123' } } })).toThrow();
});
test('custom palettes persist independently, select with CAS, and deletion restores inheritance', () => {
  const store = database();
  const first = savePalette(store, model);
  const copy = savePalette(store, parsePaletteFile(paletteFile(first)));
  expect(copy.id).not.toBe(first.id);
  selectTheme(store, {
    dimension: 'palette',
    scope: 'global',
    paletteId: first.id,
    expectedRevision: 0,
  });
  expect(resolvePaletteId(themeCatalog(store), {})).toBe(first.id);
  expect(resolveTheme(themeCatalog(store), {}).colors.light.bg).toBe('#fafafa');
  const selected = themePreferences(store);
  expect(selected.defaultThemeId).toBe('builtin:forest');
  expect(() =>
    selectTheme(store, {
      dimension: 'palette',
      scope: 'global',
      paletteId: copy.id,
      expectedRevision: 0,
    })
  ).toThrow();
  const edited = savePalette(store, { ...model, title: '편집됨' }, first.id, 1);
  expect(edited.revision).toBe(2);
  expect(() => savePalette(store, model, first.id, 1)).toThrow();
  expect(() => deletePalette(store, first.id, 1)).toThrow();
  deletePalette(store, first.id, 2);
  expect(resolvePaletteId(themeCatalog(store), {})).toBe('theme');
  expect(themeCatalog(store).palettes?.some((p) => p.id === copy.id)).toBe(true);
  expect(() => savePalette(store, model, 'forest', 1)).toThrow();
});

test('HTTP palette create, update and export preserve portable colors and reject stale deletion', async () => {
  const store = database();
  const app = Fastify();
  themeRoutes(app, store);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/palettes', payload: { model } });
    expect(created.statusCode).toBe(200);
    const saved = created.json();
    const before = await app.inject({ method: 'GET', url: '/api/themes' });
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/palettes/${saved.id}`,
      payload: { model: { ...model, title: '새 이름' }, expectedRevision: 1 },
    });
    expect(updated.json().revision).toBe(2);
    const after = await app.inject({
      method: 'GET',
      url: '/api/themes',
      headers: { 'if-none-match': before.headers.etag! },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().palettes.find((p: { id: string }) => p.id === saved.id).title).toBe(
      '새 이름'
    );
    const exported = await app.inject({ method: 'GET', url: `/api/palettes/${saved.id}/export` });
    expect(parsePaletteFile(exported.json())).toEqual({ ...model, title: '새 이름' });
    const stale = await app.inject({
      method: 'DELETE',
      url: `/api/palettes/${saved.id}`,
      payload: { expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
