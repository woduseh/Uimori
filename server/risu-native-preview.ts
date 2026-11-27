import {
  assertRisuContentSource,
  nativeRisuAssetNameResolver,
  nativeRisuSources,
  type RisuContentSource,
} from '../core/risu-native.js';
import { declaredToggleVariables } from '../core/risu-effective-controls.js';
import type { Content } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { ValidationError } from '../core/validation-error.js';
import { validationAppError } from './app-errors.js';
import type { Store } from './store.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import { executeRisuNative } from './risu-native-runtime.js';
import { renderNativeRisuMessage } from './risu-native-render.js';
import { readDisplayViewport } from './display-viewport.js';
import { importRisuVariableDefaults } from './risu-variable-defaults.js';

type PreviewRequest = {
  revision?: unknown;
  userName?: unknown;
  viewportWidth?: unknown;
  viewportHeight?: unknown;
};

const EVALUATION_MESSAGE_MAX_CHARS = 500;

function savedPackage(store: Store, id: string, revision: unknown) {
  const content = store.product.get<Content>(
    'content',
    id,
    number(Number(revision), 'content revision')
  );
  if (!content.package?.nativeRisu) throw new HttpError(400, 'Native Risu content required');
  return { content, pkg: content.package as RisuContent };
}

export type NativeRisuPreviewOptions = { toggleValues?: Record<string, string> };

async function renderStart(
  content: Content,
  pkg: RisuContent,
  native: RisuContentSource,
  variables: Record<string, string>,
  start: string,
  query: PreviewRequest,
  signal?: AbortSignal,
  options: NativeRisuPreviewOptions = {}
) {
  const assetNames = nativeRisuAssetNameResolver(native);
  const blobHashes = new Map<string, string>();
  for (const image of pkg.images ?? [])
    if (!blobHashes.has(image.id)) blobHashes.set(image.id, image.blobHash);
  const name = native.card.name;
  const userName = query.userName ? text(query.userName, 'user name', 200) : '사용자';
  const viewport = readDisplayViewport(query);
  try {
    const context = {
      viewport,
      native,
      variables,
      globalVariables: declaredToggleVariables(
        nativeRisuSources(native).toggles.text,
        options.toggleValues ?? {}
      ),
      messages: [],
      charName: typeof name === 'string' && name.trim() ? name : content.title,
      userName,
      assetUrls: Object.fromEntries(
        native.assets.flatMap((asset) => {
          const blobHash = blobHashes.get(asset.imageId);
          const url = blobHash !== undefined && `/api/package-image-blobs/${blobHash}`;
          return url ? assetNames(asset).map((name) => [name, url]) : [];
        })
      ),
    };
    const edited = await executeRisuNative(
      { ...context, event: 'editDisplay', text: start, meta: { index: -1 } },
      { signal }
    );
    signal?.throwIfAborted();
    const rendered = await renderNativeRisuMessage(
      {
        native,
        text: edited.text ?? start,
        context: { ...context, variables: edited.variables, messageIndex: -1, displaying: true },
      },
      signal
    );
    return { ...rendered, issues: [...new Set([...edited.warnings, ...rendered.issues])] };
  } catch (error) {
    if (error instanceof HttpError || signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { failure: message.slice(0, EVALUATION_MESSAGE_MAX_CHARS) };
  }
}

export async function nativeRisuStartPreview(
  store: Store,
  id: string,
  query: PreviewRequest & { startId?: string },
  signal?: AbortSignal,
  options: NativeRisuPreviewOptions = {}
) {
  const { content, pkg } = savedPackage(store, id, query.revision);
  const start = pkg.starts?.find((item) => item.id === text(query.startId, 'start ID', 64));
  if (!start || start.mode !== 'authored') throw new HttpError(404, 'Authored start not found');
  return renderStart(
    content,
    pkg,
    structuredClone(pkg.nativeRisu),
    structuredClone(pkg.variableDefaults?.values ?? {}),
    start.text,
    query,
    signal,
    options
  );
}

export async function nativeRisuPreview(
  store: Store,
  id: string,
  query: PreviewRequest & { startId?: string }
) {
  const result = await nativeRisuStartPreview(store, id, query);
  if ('failure' in result) throw new HttpError(422, 'RISU_PREVIEW_EVALUATION_FAILED');
  return result;
}

export async function nativeRisuDraftPreview(
  store: Store,
  id: string,
  body: unknown,
  signal?: AbortSignal,
  options: NativeRisuPreviewOptions = {}
) {
  const input = record(body);
  fields(input, ['revision', 'nativeRisu', 'text', 'userName', 'viewportWidth', 'viewportHeight']);
  const { content, pkg } = savedPackage(store, id, input.revision);
  const start = text(input.text, 'start text', SOURCE_TEXT_MAX_CHARS, true);
  try {
    assertRisuContentSource(input.nativeRisu);
  } catch (error) {
    if (error instanceof ValidationError) throw validationAppError(error);
    throw new HttpError(
      400,
      error instanceof Error ? error.message : 'PACKAGE_NATIVE_RISU_INVALID'
    );
  }
  const native = structuredClone(input.nativeRisu);
  let variables: Record<string, string> = {};
  try {
    variables = { ...importRisuVariableDefaults(nativeRisuSources(native).defaultVariables.text) };
  } catch {
    throw new HttpError(400, 'RISU_VARIABLE_DEFAULTS_INVALID');
  }
  return renderStart(content, pkg, native, variables, start, input, signal, options);
}
