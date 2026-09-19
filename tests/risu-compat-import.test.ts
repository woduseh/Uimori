import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import type { Content } from '../core/product.js';

// New imports preserve all CBS in native Risu fields; the legacy compat projection is no longer authored.

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-compat-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-compat-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ directory, store });
  return store;
}
const sourceOf = (description: string) => ({
  name: 'synthetic-card.json',
  base64: Buffer.from(
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'Synthetic Pilot', description, first_mes: 'The pilot waits.' },
    })
  ).toString('base64'),
});
function imported(description: string, key: string, allowPartial = false) {
  const store = database();
  const source = sourceOf(description);
  const preview = prepareRisuImport({ source });
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial,
    idempotencyKey: key,
  });
  const bot = store.product.get<Content>('content', saved.receipt.items[0].id);
  return { preview, bot };
}

test('new imports preserve stateful CBS in the native document without a compat conversion', () => {
  const description = '{{#if 1}}{{getvar::hp}} left{{/if}} and {{calc::1+2}}';
  const { preview, bot } = imported(description, 'compat-body', true);
  const levels = Object.fromEntries(preview.findings.map((item) => [item.code, item.level]));
  expect(levels['compat-evaluation']).toBeUndefined();
  expect(levels['dynamic-text']).toBeUndefined();
  expect(levels['compat-unsupported-names']).toBeUndefined();
  expect(bot.package!.compat).toBeUndefined();
  expect(bot.package!.bodyTemplate).toBeUndefined();
  expect(bot.package!.nativeRisu!.card.description).toBe(description);
  expect(bot.package!.body).toBe(description);
});

test('new imports retain display CBS for the native renderer without the old function blacklist', () => {
  const { preview, bot } = imported('{{char}} shows {{asset::sunset}}.', 'compat-asset', true);
  const finding = preview.findings.find((item) => item.code === 'compat-unsupported-names');
  expect(finding).toBeUndefined();
  expect(bot.package!.compat).toBeUndefined();
  expect(bot.package!.nativeRisu!.card.description).toBe('{{char}} shows {{asset::sunset}}.');
});

test('simple names also remain native CBS instead of a second template program', () => {
  const { preview, bot } = imported('{{char}} greets {{user}}.', 'compat-plain');
  expect(preview.findings.map((item) => item.code)).not.toContain('compat-evaluation');
  expect(bot.package!.compat).toBeUndefined();
  expect(bot.package!.bodyTemplate).toBeUndefined();
  expect(bot.package!.nativeRisu!.card.description).toBe('{{char}} greets {{user}}.');
});
