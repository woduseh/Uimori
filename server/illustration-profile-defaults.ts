import { createHash } from 'node:crypto';
import type { IllustrationCharacterProfile } from '../core/illustration.js';
import { readIllustrationAppearanceProfiles } from '../core/illustration-profiles.js';
import { resolvePackageProfile } from './package-features.js';
import type { Store } from './store.js';

/** Resolve live shared defaults once at admission; reserved jobs already freeze the result. */
export function defaultIllustrationProfiles(
  store: Store,
  chatId: string
): IllustrationCharacterProfile[] {
  const resolved = resolvePackageProfile(store.product, store.product.profile(chatId));
  return (resolved.packageAttachments ?? []).flatMap((attachment) => {
    if (attachment.role !== 'bot' && attachment.role !== 'persona') return [];
    const pkg = resolved.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
    if (!pkg) return [];
    const native = pkg.nativeRisu;
    const document = Object.keys(native.card).length ? native.card : (native.module ?? {});
    return readIllustrationAppearanceProfiles(document).map(
      ({ id, name, appearance, referenceImageId }) => ({
        id: `default:${createHash('sha256').update(`${attachment.id}:${attachment.role}:${id}`).digest('hex')}`,
        name,
        appearance,
        ...(referenceImageId && pkg.images?.some((image) => image.id === referenceImageId)
          ? { referenceRef: `package:${pkg.id}:${attachment.role}:${referenceImageId}` }
          : {}),
      })
    );
  });
}
/** A chat-authored identity takes priority by stable ID or character name. */
export function inheritIllustrationProfiles(
  defaults: IllustrationCharacterProfile[],
  overrides: IllustrationCharacterProfile[]
): IllustrationCharacterProfile[] {
  const key = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  const ids = new Set(overrides.map((item) => item.id));
  const names = new Set(overrides.map((item) => key(item.name)));
  return [
    ...defaults.filter((item) => !ids.has(item.id) && !names.has(key(item.name))),
    ...overrides,
  ];
}

/** Retain storyboard identities on redraw while explicit current profiles remain authoritative. */
export function redrawIllustrationCanon(
  canon: { name: string; appearance: string }[] | undefined,
  profiles: IllustrationCharacterProfile[]
): { name: string; appearance: string }[] | undefined {
  if (!canon?.length) return undefined;
  const key = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  const authored = new Map(
    profiles.map(({ name, appearance }) => [key(name), { name, appearance }])
  );
  return canon.map((identity) => authored.get(key(identity.name)) ?? identity);
}
