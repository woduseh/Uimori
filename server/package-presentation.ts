import { createHash } from 'node:crypto';
import { RisuContentError } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import { nativeRisuContext } from './risu-native-context.js';
import { executeRisuNative } from './risu-native-runtime.js';
import type { NativeRisuRenderInput, NativeRisuRenderResult } from './risu-native-render.js';
import { createNativeRisuWorkerSession } from './risu-native-worker.js';

export type PackagePresentationSource = {
  id: string;
  chatId: string;
  hash: string;
  text: string;
  translation?: { text: string; sourceRevision: string; sourceHash: string };
};
/** Render the selected source against the caller's current authored context. */
export async function buildPackagePresentation(
  snapshot: RunSnapshot,
  source: PackagePresentationSource,
  options: {
    nativeMessageIndex?: number;
    nativeDisplayText?: string;
    nativeTranslationText?: string;
    /** One immutable source may own additional script-authored user/character messages. */
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
    const renderer = createNativeRisuWorkerSession<NativeRisuRenderInput, NativeRisuRenderResult>(
      new URL('./risu-native-render.js', import.meta.url),
      'renderNativeRisuMessageInWorker'
    );
    try {
      const index =
        options.nativeMessageIndex ??
        (snapshot.packageStart?.mode === 'authored' || snapshot.nativeRisuAuthored?.greeting
          ? -1
          : native.messages.length);
      const display = async (value: string, index: number) => {
        const edited = await executeRisuNative({
          ...native,
          event: 'editDisplay',
          text: value,
          meta: { index },
        });
        const result = await renderer.run({
          native: native.native,
          text: edited.text ?? value,
          context: {
            ...native,
            variables: edited.variables,
            messageIndex: index,
            displaying: true,
          },
        });
        return {
          text: value,
          changed: true,
          applied: [] as string[],
          ...result,
          issues: [...new Set([...result.issues, ...edited.warnings])],
        };
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
      for (const message of messages) parts.push(await display(message.text, message.index));
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
        // A translation and its image anchors belong only to the stored canonical source body.
        // Extra script messages retain their original content in either reading mode.
        const translated = [...parts];
        translated[primary] = await display(
          options.nativeTranslationText ?? source.translation.text,
          messages[primary]!.index
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
      await renderer.close();
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
