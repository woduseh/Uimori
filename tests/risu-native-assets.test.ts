import { expect, test } from 'vitest';
import type { PackageImage } from '../core/package-images.js';
import {
  addNativeRisuImage,
  nativeImageNames,
  removeNativeRisuImage,
  replaceNativeRisuImage,
  unmappedNativeAssetCount,
} from '../core/risu-native-assets.js';
import { nativeContent } from './fixtures/native-content.js';

const image = (id: string, title: string): PackageImage => ({
  id,
  title,
  description: '',
  blobHash: 'a'.repeat(64),
  mime: 'image/png',
  allowedUse: 'both',
});
const opaque = {
  name: 'sound',
  type: 'audio',
  uri: 'embeded://assets/sound.ogg',
  custom: { preserve: true },
};
function document() {
  const pkg = nativeContent(
    {
      name: 'Synthetic',
      description: '{{image::Harper.png}}',
      assets: [
        {
          name: 'Harper',
          type: 'x-risu-asset',
          uri: 'embeded://assets/harper.png',
          ext: 'png',
          custom: 42,
        },
        opaque,
      ],
      extensions: {
        risuai: {
          backgroundHTML: '<img src="{{raw::Harper}}">',
          triggerscript: [{ effect: [{ type: 'triggerlua', code: 'return "Harper"' }] }],
        },
      },
    },
    { images: [image('original-image', 'Display label')], portraitImageId: 'original-image' }
  );
  pkg.nativeRisu.assets = [
    { name: 'Harper', uri: 'embeded://assets/harper.png', imageId: 'original-image' },
  ];
  return pkg;
}

test('replacement preserves authored identifiers, unknown asset metadata and references while changing bytes', () => {
  const original = document(),
    before = structuredClone(original);
  const uploaded = {
    ...image('new-upload-id', 'Different file name'),
    mime: 'image/webp' as const,
    blobHash: 'b'.repeat(64),
  };
  const result = replaceNativeRisuImage(original, 'original-image', uploaded);
  expect(result.nativeRisu).toEqual(before.nativeRisu);
  expect(result.images![0]).toEqual({
    ...before.images![0],
    mime: 'image/webp',
    blobHash: 'b'.repeat(64),
  });
  expect(result.portraitImageId).toBe('original-image');
  expect(nativeImageNames(result, 'original-image')).toEqual(['Harper']);
  expect(original).toEqual(before);
});

test('new images get synchronized portable metadata and collision-free names including opaque asset names', () => {
  const original = document(),
    before = structuredClone(original);
  const first = addNativeRisuImage(original, image('added', 'harper'));
  const second = addNativeRisuImage(first, image('added-2', 'sound'));
  expect(second.nativeRisu.assets.at(-2)).toEqual({
    name: 'harper-2',
    uri: 'embeded://assets/uimori/added.png',
    imageId: 'added',
  });
  expect(second.nativeRisu.assets.at(-1)?.name).toBe('sound-2');
  expect(second.nativeRisu.card.assets).toContainEqual({
    name: 'harper-2',
    type: 'x-risu-asset',
    uri: 'embeded://assets/uimori/added.png',
    ext: 'png',
  });
  expect(second.nativeRisu.card.assets).toContainEqual(opaque);
  expect(unmappedNativeAssetCount(second)).toBe(1);
  expect(original).toEqual(before);
});

test('confirmed removal drops only known mappings and portrait, leaving authored references and unavailable assets untouched', () => {
  const original = document(),
    result = removeNativeRisuImage(original, 'original-image');
  expect(result.nativeRisu.card.assets).toEqual([opaque]);
  expect(result.nativeRisu.assets).toEqual([]);
  expect(result.images).toEqual([]);
  expect(result.portraitImageId).toBeUndefined();
  expect(result.nativeRisu.card.description).toBe(original.nativeRisu.card.description);
  expect(result.nativeRisu.card.extensions).toEqual(original.nativeRisu.card.extensions);
});

test('module removal preserves remaining original URIs and opaque metadata; standalone additions update module assets', () => {
  const pkg = nativeContent({}, { images: [image('first', 'first'), image('second', 'second')] });
  pkg.nativeRisu.card = {};
  pkg.nativeRisu.module = {
    name: 'Module',
    assets: [
      ['first', 'old-path-a', 'png'],
      ['second', 'old-path-b', 'png'],
      ['sound', 'sound.ogg', 'ogg'],
    ],
    custom: true,
  };
  pkg.nativeRisu.assets = [
    { name: 'first', uri: 'embeded://module-assets/0', imageId: 'first' },
    { name: 'second', uri: 'embeded://module-assets/1', imageId: 'second' },
  ];
  const removed = removeNativeRisuImage(pkg, 'first');
  expect(removed.nativeRisu.module!.assets).toEqual([
    ['second', 'old-path-b', 'png'],
    ['sound', 'sound.ogg', 'ogg'],
  ]);
  expect(removed.nativeRisu.assets[0].uri).toBe('embeded://module-assets/1');
  const added = addNativeRisuImage(removed, image('new', 'new'));
  expect(added.nativeRisu.card).toEqual({});
  expect(added.nativeRisu.module!.assets).toContainEqual([
    'new',
    'embeded://module-assets/new.png',
    'png',
  ]);
  expect(added.nativeRisu.module!.custom).toBe(true);
});
