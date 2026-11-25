import { createHash } from 'node:crypto';
import { splitSource } from '../core/auxiliary.js';
import { parseStoryUi } from '../core/story-ui.js';
import { RisuContentError } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeRisuContext } from './risu-native-context.js';
import { executeRisuNative } from './risu-native-runtime.js';
import type { NativeRisuRenderInput, NativeRisuRenderResult } from './risu-native-render.js';
import { createNativeRisuWorkerSession } from './risu-native-worker.js';
import type { NativeRisuCbsContext } from './risu-native-cbs.js';
import { ByteBoundedCache } from './byte-bounded-cache.js';
import { trackNativeRisuEntropy } from './risu-native-entropy.js';

export type PackagePresentationSource = {
  id: string;
  chatId: string;
  hash: string;
  text: string;
  translation?: { text: string; sourceRevision: string; sourceHash: string };
};
const PRESENTATION_RENDER_TIMEOUT_MS = 10_000;
export const PACKAGE_PRESENTATION_RENDERER_VERSION = 2;
type DisplayPart = NativeRisuRenderResult & { text: string; changed: true; applied: string[] };
const displayParts = new ByteBoundedCache<DisplayPart>({
  maxBytes: 48 * 1024 * 1024,
  maxEntries: 4000,
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function clearPackagePresentationRenderCache() {
  displayParts.clear();
}

export async function buildPackagePresentation(
  snapshot: RunSnapshot,
  source: PackagePresentationSource,
  options: {
    viewport?: NativeRisuCbsContext['viewport'];
    snapshotDigest?: string;
    nativeMessageIndex?: number;
    nativeDisplayText?: string;
    nativeTranslationText?: string;
    nativeMessages?: {
      text: string;
      index: number;
      role: 'user' | 'assistant';
      primary: boolean;
    }[];
  } = {}
) {
  if (
    source.chatId !== snapshot.chatId ||
    createHash('sha256').update(source.text).digest('hex') !== source.hash
  )
    throw new RisuContentError('PACKAGE_PRESENTATION_SOURCE_MISMATCH');
  if (
    source.translation &&
    (source.translation.sourceRevision !== source.id ||
      source.translation.sourceHash !== source.hash)
  )
    throw new RisuContentError('PACKAGE_PRESENTATION_TRANSLATION_MISMATCH');
  const native = nativeRisuContext(snapshot);
  if (native) {
    let renderer:
      | ReturnType<
          typeof createNativeRisuWorkerSession<NativeRisuRenderInput, NativeRisuRenderResult>
        >
      | undefined;
    const contextDigest = digest(
      JSON.stringify([
        PACKAGE_PRESENTATION_RENDERER_VERSION,
        source.chatId,
        source.id,
        options.viewport ?? null,
        options.snapshotDigest ?? native,
      ])
    );
    try {
      const index =
        options.nativeMessageIndex ??
        (snapshot.packageStart?.mode === 'authored' || snapshot.nativeRisuAuthored?.greeting
          ? -1
          : native.messages.length);
      const render = async (value: string, index: number, canonical?: string) => {
        const edited = await executeRisuNative({
          ...native,
          viewport: options.viewport,
          event: 'editDisplay',
          text: value,
          meta: { index },
        });
        const editedText = edited.text ?? value;
        const originalSegments =
          canonical === undefined
            ? []
            : parseStoryUi(value).filter((part) => part.kind !== 'prose');
        const segments =
          canonical === undefined
            ? []
            : parseStoryUi(editedText).filter((part) => part.kind !== 'prose');
        let nextOriginal = 0;
        const replacements = segments.flatMap((part) => {
          const raw = editedText.slice(part.start, part.end);
          const ordinal = originalSegments.findIndex(
            (original, at) =>
              at >= nextOriginal && value.slice(original.start, original.end) === raw
          );
          if (ordinal < 0) return [];
          nextOriginal = ordinal + 1;
          const replacement = `\n\n<div data-uimori-story-ui=${ordinal}></div>\n\n`;
          return [
            {
              start: part.start,
              end: part.end,
              replacement,
              delta: replacement.length - (part.end - part.start),
            },
          ];
        });
        let displayText = editedText;
        for (const replacement of [...replacements].reverse())
          displayText =
            displayText.slice(0, replacement.start) +
            replacement.replacement +
            displayText.slice(replacement.end);
        renderer ??= createNativeRisuWorkerSession<NativeRisuRenderInput, NativeRisuRenderResult>(
          new URL('./risu-native-render.js', import.meta.url),
          'renderNativeRisuMessageInWorker',
          PRESENTATION_RENDER_TIMEOUT_MS
        );
        const result = await renderer.run({
          native: native.native,
          text: displayText,
          illustrationBlocks:
            canonical === value && editedText === value
              ? splitSource({
                  ...source,
                  text: value,
                  hash: createHash('sha256').update(value).digest('hex'),
                }).map(({ anchor, end }) => ({
                  anchor,
                  end:
                    end +
                    replacements.reduce(
                      (sum, replacement) => sum + (replacement.end <= end ? replacement.delta : 0),
                      0
                    ),
                }))
              : undefined,
          context: {
            ...native,
            viewport: options.viewport,
            variables: edited.variables,
            messageIndex: index,
            displaying: true,
          },
        });
        return {
          text: value,
          changed: true as const,
          applied: [] as string[],
          ...result,
          issues: [...new Set([...result.issues, ...edited.warnings])],
        };
      };
      const display = async (value: string, index: number, canonical?: string) => {
        const key = digest(
          JSON.stringify([
            contextDigest,
            value,
            index,
            canonical === undefined ? 0 : canonical === value ? 1 : 2,
          ])
        );
        const cached = displayParts.get(key);
        if (cached) return cached;
        const { value: part, entropyUsed } = await trackNativeRisuEntropy(() =>
          render(value, index, canonical)
        );
        if (!entropyUsed)
          displayParts.set(key, part, (part.text.length + part.html.length + part.css.length) * 2);
        return part;
      };
      const messages = options.nativeMessages ?? [
        {
          text: options.nativeDisplayText ?? source.text,
          index,
          role: 'assistant' as const,
          primary: true,
        },
      ];
      const parts: Awaited<ReturnType<typeof display>>[] = [];
      for (const message of messages)
        parts.push(
          await display(message.text, message.index, message.primary ? source.text : undefined)
        );
      const combine = (values: typeof parts) =>
        values.length === 1
          ? values[0]!
          : {
              text: values.map((value) => value.text).join('\n\n'),
              changed: true,
              applied: [] as string[],
              html: values
                .map(
                  (value, at) =>
                    `<section data-risu-message-index="${messages[at]!.index}" data-risu-message-role="${messages[at]!.role}">${value.html}</section>`
                )
                .join('\n'),
              css: values.map((value) => value.css).join('\n'),
              issues: [...new Set(values.flatMap((value) => value.issues))],
            };
      const original = combine(parts);
      const primary = messages.findIndex((message) => message.primary);
      let translation: ReturnType<typeof combine> | undefined;
      if (source.translation && primary !== -1) {
        const translated = [...parts];
        translated[primary] = await display(
          options.nativeTranslationText ?? source.translation.text,
          messages[primary]!.index,
          source.translation.text
        );
        translation = combine(translated);
      }
      return {
        sourceRevision: source.id,
        sourceHash: source.hash,
        format: 'risu-html' as const,
        original,
        ...(translation ? { translation } : {}),
        issues: [...original.issues, ...(translation?.issues ?? [])],
        request: { text: snapshot.request, changed: false, applied: [] as string[] },
      };
    } finally {
      await renderer?.close();
    }
  }
  return {
    sourceRevision: source.id,
    sourceHash: source.hash,
    format: 'plain-text' as const,
    original: { text: source.text, changed: false, applied: [] as string[] },
    ...(source.translation
      ? { translation: { text: source.translation.text, changed: false, applied: [] as string[] } }
      : {}),
    request: { text: snapshot.request, changed: false, applied: [] as string[] },
    issues: [] as string[],
  };
}
