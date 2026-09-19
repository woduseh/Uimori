import { nativeRisuAssetNames } from '../core/risu-native.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import { HttpError, number, text } from './request-validation.js';
import { executeRisuNative } from './risu-native-runtime.js';
import { renderNativeRisuMessage } from './risu-native-render.js';

/** Read-only preview: a fresh Lua VM, copied variables, no chat, no model/interaction host. */
export async function nativeRisuPreview(
  store: Store,
  id: string,
  query: { revision?: string; startId?: string; userName?: string }
) {
  const revision = number(Number(query.revision), 'content revision');
  const content = store.product.get<Content>('content', id, revision);
  const pkg = content.package;
  if (!pkg?.nativeRisu) throw new HttpError(400, 'Native Risu content required');
  const start = pkg.starts?.find((item) => item.id === text(query.startId, 'start ID', 64));
  if (!start || start.mode !== 'authored') throw new HttpError(404, 'Authored start not found');
  const context = {
    native: structuredClone(pkg.nativeRisu),
    variables: structuredClone(pkg.variableDefaults?.values ?? {}),
    messages: [],
    charName: content.title,
    userName: query.userName ? text(query.userName, 'user name', 200) : '사용자',
    assetUrls: Object.fromEntries(
      pkg.nativeRisu.assets.flatMap((asset) => {
        const image = pkg.images?.find((item) => item.id === asset.imageId);
        const url = image && `/api/package-image-blobs/${image.blobHash}`;
        return url ? nativeRisuAssetNames(pkg.nativeRisu!, asset).map((name) => [name, url]) : [];
      })
    ),
  };
  const edited = await executeRisuNative({
    ...context,
    event: 'editDisplay',
    text: start.text,
    meta: { index: -1 },
  });
  const rendered = await renderNativeRisuMessage({
    native: context.native,
    text: edited.text ?? start.text,
    context: { ...context, variables: edited.variables, messageIndex: -1, displaying: true },
  });
  return { ...rendered, issues: [...new Set([...edited.warnings, ...rendered.issues])] };
}
