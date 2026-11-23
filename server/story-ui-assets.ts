import { nativeRisuAssetNameResolver } from '../core/risu-native.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeRisuPackages } from './risu-native-context.js';
import { readStoredRunSnapshot } from './run-projections.js';
import type { Store } from './store.js';
import { compileStoryUiBlocks } from './story-ui.js';

function indexAssetUrls(snapshot: RunSnapshot) {
  const urls = new Map<string, string | null>();
  for (const { pkg, native } of nativeRisuPackages(snapshot)) {
    const images = new Map(pkg.images?.map((image) => [image.id, image]));
    const assetNames = nativeRisuAssetNameResolver(native);
    for (const asset of native.assets) {
      const image = images.get(asset.imageId);
      if (!image || image.allowedUse === 'profile') continue;
      const url = `/api/package-image-blobs/${image.blobHash}`;
      for (const alias of assetNames(asset)) {
        const key = alias.trim().toLowerCase();
        if (!key) continue;
        const previous = urls.get(key);
        urls.set(key, previous === undefined || previous === url ? url : null);
      }
    }
  }
  return urls;
}

export function storyUiAssetResolver(getSnapshot: () => RunSnapshot) {
  let urls: Map<string, string | null> | undefined;
  return (name: string) => {
    urls ??= indexAssetUrls(getSnapshot());
    return urls.get(name.trim().toLowerCase()) ?? undefined;
  };
}

export function compileEditedSourceText(store: Store, sourceId: string, text: string): string {
  const source = store.source(sourceId);
  return compileStoryUiBlocks(text, {
    previousText: source.text,
    resolveImage: storyUiAssetResolver(() => readStoredRunSnapshot(store, source.runId)),
  }).text;
}
