import type { IllustrationCharacterProfile } from './illustration.js';
import { ValidationError } from './validation-error.js';

export type IllustrationAppearanceProfile = Pick<
  IllustrationCharacterProfile,
  'id' | 'name' | 'appearance'
> & {
  referenceImageId?: string;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function illustrationProfilesValue(card: Record<string, unknown>): unknown {
  return object(object(card.extensions).uimori).illustrationProfiles;
}
export function readIllustrationAppearanceProfiles(
  card: Record<string, unknown>
): IllustrationAppearanceProfile[] {
  return (illustrationProfilesValue(card) as IllustrationAppearanceProfile[] | undefined) ?? [];
}
export function withIllustrationAppearanceProfiles(
  card: Record<string, unknown>,
  profiles: IllustrationAppearanceProfile[]
): Record<string, unknown> {
  const extensions = object(card.extensions);
  return {
    ...card,
    extensions: {
      ...extensions,
      uimori: { ...object(extensions.uimori), illustrationProfiles: profiles },
    },
  };
}
const profilesInvalid = (detail: string) =>
  new ValidationError(400, 'ILLUSTRATION_PROFILES_INVALID', `illustrationProfiles: ${detail}`);
export function validateIllustrationAppearanceProfiles(
  value: unknown
): IllustrationAppearanceProfile[] {
  if (!Array.isArray(value) || value.length > 32)
    throw profilesInvalid('expected an array of at most 32 profiles.');
  const ids = new Set<string>();
  for (const entry of value) {
    const item = object(entry);
    if (
      Object.keys(item).some(
        (key) => !['id', 'name', 'appearance', 'referenceImageId'].includes(key)
      ) ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.length > 100 ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 200 ||
      typeof item.appearance !== 'string' ||
      !item.appearance.trim() ||
      item.appearance.length > 2000 ||
      (item.referenceImageId !== undefined &&
        (typeof item.referenceImageId !== 'string' ||
          !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(item.referenceImageId)))
    )
      throw profilesInvalid(
        'each profile holds a unique id, a name, an appearance and an optional referenceImageId within their limits.'
      );
    ids.add(item.id);
  }
  return structuredClone(value) as IllustrationAppearanceProfile[];
}

export const illustrationProfileNameKey = (name: string): string =>
  name.trim().normalize('NFKC').toLocaleLowerCase('en-US');

export function inheritIllustrationProfiles(
  defaults: IllustrationCharacterProfile[],
  overrides: IllustrationCharacterProfile[]
): IllustrationCharacterProfile[] {
  const ids = new Set(overrides.map((item) => item.id));
  const names = new Set(overrides.map((item) => illustrationProfileNameKey(item.name)));
  return [
    ...defaults.filter(
      (item) => !ids.has(item.id) && !names.has(illustrationProfileNameKey(item.name))
    ),
    ...overrides,
  ];
}
