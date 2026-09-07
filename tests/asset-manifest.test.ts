import { expect, test } from 'vitest';
import type { Asset } from '../core/product.js';
import { resolveAsset, searchAssets } from '../core/asset-manifest.js';

const asset: Asset = {
  id: 'asset-a',
  chatId: 'chat-a',
  revision: 2,
  hash: 'verified-content-hash',
  title: 'Author supplied harbor portrait',
  mime: 'image/png',
  description: 'Mira at the harbor.',
  actor: 'Mira',
  outfit: 'coat',
  location: 'harbor',
  allowedUse: 'inline',
  url: 'data:image/png;base64,PRIVATE_BYTES',
};
const selection = () => ({
  chatId: 'chat-a',
  ref: { id: asset.id, revision: asset.revision, hash: asset.hash },
  use: 'inline' as const,
  actor: 'Mira',
  outfit: 'coat',
  location: 'harbor',
});

test('S07 resolves exact stable metadata and rejects stale, missing, conflicting and denied combinations', () => {
  expect(resolveAsset([asset], selection())).toMatchObject({
    ok: true,
    asset: { id: asset.id, revision: 2, hash: asset.hash },
  });
  expect(resolveAsset([], selection())).toMatchObject({
    ok: false,
    fallback: 'no-image',
    error: 'ASSET_MISSING',
  });
  expect(resolveAsset([asset], { ...selection(), chatId: 'other-chat' })).toMatchObject({
    ok: false,
    error: 'ASSET_MISSING',
  });
  for (const ref of [
    { ...selection().ref, revision: 1 },
    { ...selection().ref, hash: 'old-hash' },
  ])
    expect(resolveAsset([asset], { ...selection(), ref })).toMatchObject({
      ok: false,
      error: 'ASSET_STALE',
    });
  expect(resolveAsset([asset], { ...selection(), use: 'profile' })).toMatchObject({
    ok: false,
    error: 'ASSET_USE_DENIED',
  });
  for (const change of [{ actor: 'Other' }, { outfit: 'dress' }, { location: 'palace' }])
    expect(resolveAsset([asset], { ...selection(), ...change })).toMatchObject({
      ok: false,
      error: 'ASSET_COMBINATION_MISMATCH',
    });
  expect(resolveAsset([asset, { ...asset, outfit: 'dress' }], selection())).toMatchObject({
    ok: false,
    error: 'ASSET_AMBIGUOUS',
  });
});

test('S07 metadata search is scoped, paginated and never transmits URL or asset bytes', () => {
  const all = Array.from({ length: 55 }, (_, index) => ({
    ...asset,
    id: `asset-${String(index).padStart(2, '0')}`,
  }));
  all.push({ ...asset, id: 'hidden', chatId: 'other-chat' });
  const first = searchAssets(all, {
    chatId: 'chat-a',
    query: 'harbor',
    outfit: 'coat',
    allowedUse: 'inline',
    limit: 20,
  });
  expect(first.items).toHaveLength(20);
  expect(first.total).toBe(55);
  expect(first.nextOffset).toBe(20);
  const second = searchAssets(all, { chatId: 'chat-a', offset: first.nextOffset!, limit: 20 });
  expect(second.items[0].id).toBe('asset-20');
  const last = searchAssets(all, { chatId: 'chat-a', offset: 40, limit: 20 });
  expect(last.items).toHaveLength(15);
  expect(last.nextOffset).toBeNull();
  expect(JSON.stringify(first)).not.toContain('PRIVATE_BYTES');
  expect(first.items[0]).not.toHaveProperty('url');
  const result = resolveAsset([asset], selection());
  expect(JSON.stringify(result)).not.toContain('PRIVATE_BYTES');
  expect(searchAssets(all, { chatId: 'chat-a', allowedUse: 'profile' }).items).toEqual([]);
  expect(searchAssets(all, { chatId: 'chat-a', query: 'PRIVATE_BYTES' }).items).toEqual([]);
  expect(() => searchAssets(all, { chatId: 'chat-a', limit: 51 })).toThrow('INVALID_ASSET_SEARCH');
  expect(() => searchAssets(all, { chatId: 'chat-a', offset: -1 })).toThrow('INVALID_ASSET_SEARCH');
});

test('S07 incomplete refs and oversized metadata have explicit fallback', () => {
  expect(
    resolveAsset([asset], { ...selection(), ref: { id: asset.id, revision: 0, hash: '' } })
  ).toMatchObject({ ok: false, error: 'INVALID_ASSET_SELECTION' });
  expect(resolveAsset([{ ...asset, description: 'x'.repeat(2049) }], selection())).toMatchObject({
    ok: false,
    error: 'INVALID_ASSET_METADATA',
  });
});
