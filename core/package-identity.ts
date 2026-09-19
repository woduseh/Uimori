import type { Content, ProfileSnapshot } from './product.js';
import {
  resolveTemplateVariableContext,
  type TemplateVariableContext,
} from './template-variables.js';

export type PackageIdentityContext = {
  bot: { name: string };
  user: { name: string };
} & TemplateVariableContext;
type IdentityContent = Pick<Content, 'title' | 'package'>;

/** Identity substitutions read the selected data only; names never become template source. */
export function packageIdentityFromContents(
  bot?: IdentityContent | null,
  persona?: IdentityContent | null,
  variables?: Record<string, string>
): PackageIdentityContext {
  const name = (content: IdentityContent | null | undefined, fallback: string) =>
    content?.package?.identity?.name ?? content?.package?.title ?? content?.title ?? fallback;
  return {
    bot: { name: name(bot, 'Character') },
    user: { name: name(persona, 'User') },
    ...(variables === undefined ? {} : { variables }),
  };
}

/** Frozen profile lookup keeps historical openings independent of later library revisions. */
export function packageIdentityFromProfile(profile: ProfileSnapshot): PackageIdentityContext {
  const content = (role: 'bot' | 'persona'): IdentityContent | undefined => {
    const ref = profile.packageAttachments?.find((item) => item.role === role);
    const pkg =
      ref && profile.packages?.find((item) => item.id === ref.id && item.revision === ref.revision);
    return pkg ? { title: pkg.title, package: pkg } : undefined;
  };
  return {
    ...packageIdentityFromContents(content('bot'), content('persona')),
    ...resolveTemplateVariableContext(profile),
  };
}
