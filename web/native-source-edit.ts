import {
  nativeRisuExtension,
  normalizeRisuContentSource,
  validateRisuContentSource,
  type RisuContentSource,
} from '../core/risu-native.js';
import { detectRisuImageHandoff } from '../core/risu-image-handoff.js';
import type { ContentEditModel, ResourceModel } from '../core/resource-editing.js';

export type NativeSourcePart = 'greetings' | 'lore' | 'regex' | 'triggers' | 'card' | 'module';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Parse only when Save or form preview is requested; incomplete JSON remains in the input. */
export function editNativeSource(
  native: RisuContentSource,
  part: NativeSourcePart,
  raw: string
): RisuContentSource {
  const parsed: unknown = JSON.parse(raw);
  const next = structuredClone(native);
  if (part === 'card' || part === 'module') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('JSON 객체를 입력해 주세요.');
    next[part] = parsed as Record<string, unknown>;
  } else {
    if (!Array.isArray(parsed)) throw new Error('JSON 배열을 입력해 주세요.');
    if (part === 'greetings') {
      if (parsed.some((item) => typeof item !== 'string'))
        throw new Error('시작문은 문자열 배열로 입력해 주세요.');
      next.card.alternate_greetings = parsed;
    } else {
      if (parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
        throw new Error('각 항목은 JSON 객체여야 해요.');
      if (part === 'lore') {
        if (next.module && Array.isArray(next.module.lorebook))
          next.module = { ...next.module, lorebook: parsed };
        else next.card.character_book = { ...object(next.card.character_book), entries: parsed };
      } else if (next.module) next.module[part === 'regex' ? 'regex' : 'trigger'] = parsed;
      else
        next.card.extensions = {
          ...object(next.card.extensions),
          risuai: {
            ...nativeRisuExtension(next),
            [part === 'regex' ? 'customScripts' : 'triggerscript']: parsed,
          },
        };
    }
  }
  return validateRisuContentSource(next);
}

export function resourceWithNativeSource(
  model: ResourceModel,
  source: RisuContentSource
): ContentEditModel {
  if (!('package' in model)) throw new Error('콘텐츠 편집기에서만 카드 원문을 저장할 수 있어요.');
  const native = normalizeRisuContentSource(source);
  const title = String(
    model.kind === 'module' ? (native.module?.name ?? native.card.name) : (native.card.name ?? '')
  );
  return {
    ...model,
    title,
    package: {
      ...model.package,
      title,
      nativeRisu: native,
      imageHandoff: detectRisuImageHandoff(native, model.package.imageHandoff),
    },
  };
}
