import { nativeRisuRegex } from '../core/risu-native.js';
import {
  renderNativeRisuMessageInWorker,
  type NativeRisuRenderInput,
} from './risu-native-render.js';
import { runNativeRisuWorker } from './risu-native-worker.js';

type TagInput = Omit<NativeRisuRenderInput, 'text'> & {
  name: string;
  url: string;
  templates: string[];
  guidance?: string;
};

/** A candidate is accepted only when the original display rules resolve it to this exact asset. */
export function nativeImageTagInWorker(input: TagInput): string | null {
  const native = structuredClone(input.native);
  const extensions = native.card.extensions as Record<string, unknown> | undefined;
  native.card.extensions = {
    ...extensions,
    risuai: { ...(extensions?.risuai as Record<string, unknown> | undefined), backgroundHTML: '' },
  };
  const rules = nativeRisuRegex(native).filter(
    (rule) => rule.type === 'editdisplay' && /img/iu.test(rule.in)
  );
  const name = input.name.replace(/\.(?:png|jpe?g|webp|avif|gif)$/iu, '');
  const names = new Set([input.name, name]);
  const prefixes = new Set(
    rules.flatMap((rule) =>
      [...rule.in.matchAll(/[A-Za-z][A-Za-z0-9]*_/gu)].map((match) => match[0])
    )
  );
  for (const suffix of name
    .split('_')
    .map((_, index, all) => all.slice(index).join('_'))
    .slice(0, 5))
    for (const prefix of prefixes) if (names.size < 48) names.add(prefix + suffix);
  const orderedNames = [...names].sort(
    (a, b) =>
      Number([...prefixes].some((prefix) => b.startsWith(prefix))) -
      Number([...prefixes].some((prefix) => a.startsWith(prefix)))
  );
  for (const candidateName of orderedNames) {
    // A generic NPC rule may also accept outfit names (daily_smiling), but the authored format
    // requires an NPC name (Harper_smiling). Require the character stem to occur in its guidance.
    if (
      input.guidance &&
      rules.some((rule) => rule.out.includes('getvar::')) &&
      ![...prefixes].some((prefix) => candidateName.startsWith(prefix))
    ) {
      const stem = candidateName.split('_')[0];
      if (!input.guidance.toLowerCase().includes(stem.toLowerCase())) continue;
    }
    if (/["'<>`{}\r\n]/u.test(candidateName)) continue;
    for (const template of input.templates.slice(0, 8)) {
      const tag = template.replace('{asset}', candidateName);
      if (
        !rules.some((rule) => {
          try {
            return new RegExp(
              rule.in,
              rule.ableFlag ? (rule.flag ?? '').replace(/[^imsu]/gu, '') : ''
            ).test(tag);
          } catch {
            return false;
          }
        })
      )
        continue;
      const rendered = renderNativeRisuMessageInWorker({ ...input, native, text: tag });
      if (rendered.html.includes(input.url) && !rendered.html.includes(tag)) return tag;
    }
  }
  return null;
}

export function nativeImageTag(input: TagInput): Promise<string | null> {
  return runNativeRisuWorker(
    new URL('./risu-native-image-tags.js', import.meta.url),
    'nativeImageTagInWorker',
    input,
    5000
  );
}
