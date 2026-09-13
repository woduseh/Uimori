import type { Content, ProfileSnapshot } from './product.js';
import { historicalPersonaExcluded } from './persona-scope.js';
import { validatePromptTemplate, type PromptTemplate } from './prompt-program.js';
import { PromptBudget } from './prompt-values.js';
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
export function packageIdentityFromProfile(
  profile: ProfileSnapshot,
  target = 'main'
): PackageIdentityContext {
  const content = (role: 'bot' | 'persona'): IdentityContent | undefined => {
    if (historicalPersonaExcluded(profile, role, target)) return undefined;
    const ref = profile.packageAttachments?.find((item) => item.role === role);
    const pkg =
      ref && profile.packages?.find((item) => item.id === ref.id && item.revision === ref.revision);
    return pkg
      ? { title: pkg.title, package: pkg }
      : profile.contents.find((item) => item.kind === role);
  };
  return {
    ...packageIdentityFromContents(content('bot'), content('persona')),
    ...resolveTemplateVariableContext(profile, target),
  };
}

/** Authored text reads selected names, declared variables and controls, without slots or ambient runtime. */
export function validatePackageIdentityTemplate(
  value: unknown,
  controls: Iterable<string>,
  invalid: (reason: 'SLOT' | 'CONTEXT') => never
): PromptTemplate {
  const result = validatePromptTemplate(value, controls, [], new PromptBudget({}, 'deterministic'));
  const pending: unknown[] = [result];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node)) {
      if (Object.hasOwn(node, 'literal')) continue;
      const record = node as Record<string, unknown>;
      if (record.kind === 'slot') invalid('SLOT');
      if (Object.hasOwn(record, 'context')) {
        const path = record.context;
        if (
          !Array.isArray(path) ||
          !(
            (path.length === 2 && ['bot', 'user'].includes(path[0]) && path[1] === 'name') ||
            (path.length === 1 && path[0] === 'variables')
          )
        )
          invalid('CONTEXT');
      }
    }
    pending.push(...Object.values(node));
  }
  return result;
}
