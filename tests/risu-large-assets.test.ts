import { expect, test } from 'vitest';
import { validateRisuContent } from '../core/risu-content.js';
import { nativeRisuAssetNameResolver } from '../core/risu-native.js';
import { unmappedNativeAssetCount } from '../core/risu-native-assets.js';
import { nativeContent } from './fixtures/native-content.js';
import type { PackageImage } from '../core/package-images.js';

function largePackage(count: number) {
  const images: PackageImage[] = Array.from({ length: count }, (_, index) => ({
    id: 'image-' + index,
    title: 'Image ' + index,
    description: '',
    blobHash: index.toString(16).padStart(64, '0'),
    mime: 'image/webp',
    allowedUse: 'both',
  }));
  const assets = images.map((image) => ({
    name: image.title,
    uri: 'embeded://assets/' + image.id + '.webp',
    imageId: image.id,
  }));
  const pkg = nativeContent(
    { assets: assets.map(({ name, uri }) => ({ type: 'x-risu-asset', name, uri, ext: 'webp' })) },
    { images }
  );
  pkg.nativeRisu.assets = assets;
  return pkg;
}

test('a full 12,288-asset card validates, preserves references, and rejects overflow', () => {
  const pkg = largePackage(12_288);
  const validated = validateRisuContent(pkg);
  expect(validated.images).toHaveLength(12_288);
  expect(unmappedNativeAssetCount(validated)).toBe(0);
  const resolve = nativeRisuAssetNameResolver(validated.nativeRisu);
  expect(resolve(validated.nativeRisu.assets[12_287])).toContain('Image 12287.webp');
  expect(() => validateRisuContent(largePackage(12_289))).toThrow();
  pkg.nativeRisu.assets[12_287].imageId = 'missing-image';
  expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_NATIVE_RISU_ASSET_REFERENCE');
});

test('indexed aliases retain the first authored extension for duplicate URI and name', () => {
  const pkg = largePackage(1);
  (pkg.nativeRisu.card.assets as Record<string, unknown>[]).push({
    name: 'Image 0',
    uri: 'embeded://assets/image-0.webp',
    ext: 'png',
  });
  expect(nativeRisuAssetNameResolver(pkg.nativeRisu)(pkg.nativeRisu.assets[0])).toEqual([
    'Image 0',
    'embeded://assets/image-0.webp',
    'Image 0.webp',
  ]);
});
