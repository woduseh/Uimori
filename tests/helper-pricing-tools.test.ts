import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import type { ModelPreset } from '../core/product.js';
import { invokeHelperSettingsTool as call } from '../server/helper-settings-tools.js';
import { describeHelperTools } from '../server/helper-app-tools.js';

const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const { path, store } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-helper-pricing-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-pricing-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ path, store });
  const connection = store.product.connection({
    title: 'Direct provider',
    protocol: 'openai-chat-v1',
    endpoint: 'https://private.example/v1',
    credentialRef: 'PRIVATE_KEY_REF',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Author model',
    connectionId: connection.id,
    modelId: 'author-model',
    maxOutputTokens: 1024,
    temperature: null,
  }) as ModelPreset;
  return { store, model, connection };
}
const pricing = {
  mode: 'manual',
  rates: { input: 2, output: 8, cacheRead: 0, cacheWrite: null },
  sourceUrl: 'https://example.com/official-prices',
  checkedAt: '2026-10-18',
};

test('helper pricing discovery and narrow revision update preserve model settings and frozen snapshots', () => {
  const { store, model, connection } = fixture();
  expect(
    describeHelperTools({ names: ['model.pricing.read', 'model.pricing.update'] }).tools.map(
      (t) => t.name
    )
  ).toEqual(['model.pricing.read', 'model.pricing.update']);
  const before = call(store, 'model.pricing.read', { modelId: model.id });
  expect(before).toMatchObject({ revision: model.revision, effective: null });
  expect(JSON.stringify(before)).not.toContain(connection.endpoint);
  expect(JSON.stringify(before)).not.toContain('PRIVATE_KEY_REF');
  const updated = call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: model.revision,
    pricing,
  });
  expect(updated).toMatchObject({
    revision: model.revision + 1,
    effective: { source: 'manual', rates: pricing.rates, checkedAt: pricing.checkedAt },
  });
  const saved = store.product.get<ModelPreset>('model', model.id);
  expect(saved).toEqual({ ...model, revision: model.revision + 1, pricing });
  const frozen = store.product.modelSnapshot(model.id).pricingSnapshot!;
  expect(() =>
    call(store, 'model.pricing.update', {
      modelId: model.id,
      expectedRevision: model.revision,
      pricing: { ...pricing, rates: { ...pricing.rates, input: 100 } },
    })
  ).toThrow('Revision conflict');
  call(store, 'model.pricing.update', {
    modelId: model.id,
    expectedRevision: saved.revision,
    pricing: { ...pricing, rates: { ...pricing.rates, input: 7 } },
  });
  expect(frozen.rates.input).toBe(2);
  expect(store.product.modelSnapshot(model.id).pricingSnapshot?.rates.input).toBe(7);
});

test('helper rejects missing source, unsafe metadata and unrelated writable model/credential fields', () => {
  const { store, model } = fixture();
  for (const body of [
    { pricing: { mode: 'manual', rates: pricing.rates } },
    { pricing: { ...pricing, sourceUrl: 'http://bad.example' } },
    { pricing: { ...pricing, checkedAt: '2026-02-30' } },
    { pricing, credentialRef: 'EVIL' },
    { pricing, maxOutputTokens: 1 },
    { pricing: { ...pricing, endpoint: 'https://elsewhere.example' } },
  ])
    expect(() =>
      call(store, 'model.pricing.update', {
        modelId: model.id,
        expectedRevision: model.revision,
        ...body,
      })
    ).toThrow();
  expect(store.product.get<ModelPreset>('model', model.id)).toEqual(model);
});
