import type { Content, ProfileSnapshot } from './product.js';

export type PackageIdentityContext = { bot: { name: string }; user: { name: string } };
type IdentityContent = Pick<Content, 'title' | 'package'>;

/** Identity substitutions read the selected data only; names never become template source. */
export function packageIdentityFromContents(
  bot?: IdentityContent | null,
  persona?: IdentityContent | null
): PackageIdentityContext {
  const name = (content: IdentityContent | null | undefined, fallback: string) =>
    content?.package?.identity?.name ?? content?.package?.title ?? content?.title ?? fallback;
  return { bot: { name: name(bot, 'Character') }, user: { name: name(persona, 'User') } };
}

/** Frozen profile lookup keeps historical openings independent of later library revisions. */
export function packageIdentityFromProfile(profile: ProfileSnapshot): PackageIdentityContext {
  const content = (role: 'bot' | 'persona'): IdentityContent | undefined => {
    if (role === 'persona' && profile.personaReference === false) return undefined;
    const ref = profile.packageAttachments?.find((item) => item.role === role);
    const pkg =
      ref && profile.packages?.find((item) => item.id === ref.id && item.revision === ref.revision);
    return pkg
      ? { title: pkg.title, package: pkg }
      : profile.contents.find((item) => item.kind === role);
  };
  return packageIdentityFromContents(content('bot'), content('persona'));
}
