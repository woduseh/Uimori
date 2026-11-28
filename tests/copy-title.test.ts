import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { copyTitle } from '../core/copy-title.js';
import {
  emptyIllustrationPreset,
  validateIllustrationPreset,
} from '../core/illustration-presets.js';
import type { PromptPreset } from '../core/product.js';
import { resourceRoutes } from '../server/resource-routes.js';
import { Store } from '../server/store.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const suffixes = [' 사본', ' copy', 'のコピー', ' 副本'];

test('a copied title keeps its whole suffix within the limit for every UI language', () => {
  for (const limit of [100, 200])
    for (const suffix of suffixes)
      for (const title of [
        'a'.repeat(limit),
        '가'.repeat(limit),
        `${'a'.repeat(limit - 2)}😀😀`,
        `${'a'.repeat(limit - 7)}      b`,
        'Short',
      ]) {
        const copied = copyTitle(title, suffix, limit);
        expect(copied.endsWith(suffix), `${limit} ${suffix} ${title}`).toBe(true);
        expect(copied.length, `${limit} ${suffix} ${title}`).toBeLessThanOrEqual(limit);
        expect(copied).not.toMatch(/[\uD800-\uDBFF]$/u);
      }
  expect(copyTitle('Short', ' copy', 100)).toBe('Short copy');
});

test('a maximum-length title copied in English is accepted where the copy is saved', async () => {
  const preset = emptyIllustrationPreset('a'.repeat(100));
  expect(
    validateIllustrationPreset({ ...preset, title: copyTitle(preset.title, ' copy', 100) }).title
  ).toHaveLength(100);

  const path = mkdtempSync(join(tmpdir(), 'uimori-copy-title-'));
  const store = new Store(join(path, 'test.sqlite'));
  const app = Fastify();
  try {
    resourceRoutes(app, store, () => {});
    const source = store.product.promptPreset({
      title: 'p'.repeat(200),
      role: 'main',
      program: nativePrompt('Body.'),
      values: {},
    }) as PromptPreset;
    const response = await app.inject({
      method: 'POST',
      url: '/api/resources/clone',
      payload: {
        kind: 'prompt-preset',
        sourceId: source.id,
        expectedSourceRevision: source.revision,
        title: copyTitle(source.title, ' copy', 200),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().saved.title).toBe(`${'p'.repeat(195)} copy`);
  } finally {
    await app.close();
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
