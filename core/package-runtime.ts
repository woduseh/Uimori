import {
  RisuContentError,
  validateRisuContent,
  validateContentAttachment,
  type RisuContent,
  type ContentAttachment,
  type ContentTarget,
} from './risu-content.js';
import type { Resource } from './types.js';

export type CompiledContentAttachment = {
  resources: Resource[];
  pinned: Resource[];
  instructions: { id: string; text: string; position?: string }[];
};
/** Host resources come from the frozen Risu projection. CBS/Lua run in the Risu runtime. */
export function compileContentAttachment(
  value: RisuContent,
  ref: ContentAttachment,
  context: {
    chatId: string;
    target: ContentTarget;
    resourcesOnly?: boolean;
    loreSelection?: ReadonlySet<string>;
  }
): CompiledContentAttachment {
  const pkg = validateRisuContent(value),
    attachment = validateContentAttachment(ref);
  if (pkg.id !== attachment.id || pkg.revision !== attachment.revision)
    throw new RisuContentError('PACKAGE_REVISION_MISMATCH');
  if (!context.chatId) throw new RisuContentError('PACKAGE_CHAT_REQUIRED');
  const prefix = `package:${pkg.id}:${attachment.role}`;
  const resource = (
    key: string,
    title: string,
    description: string,
    text: string,
    loading: 'pinned' | 'discoverable',
    sourceKind: string
  ): Resource => ({
    id: `${prefix}:${key}`,
    chatId: context.chatId,
    revision: pkg.revision,
    title,
    description,
    text,
    loading,
    sourceKind,
    kind: 'lore',
  });
  const groups = new Map<string, typeof pkg.lore>();
  for (const lore of pkg.lore) {
    const key = lore.loreContext?.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), lore]);
  }
  const chosen = pkg.loreActivation?.mode === 'model' ? context.loreSelection : undefined;
  const resources: Resource[] = [...groups.values()]
    .flatMap((group) =>
      [...group].sort((a, b) => (a.loreContext?.order ?? 0) - (b.loreContext?.order ?? 0))
    )
    .map((lore) => ({
      ...resource(
        `lore:${lore.id}`,
        lore.title,
        lore.description,
        lore.text,
        chosen?.has(lore.id) ? 'pinned' : lore.loading,
        'lore'
      ),
      ...(lore.loreContext ? { loreContext: structuredClone(lore.loreContext) } : {}),
      ...(lore.nativeRisuPosition
        ? { nativeRisuPosition: structuredClone(lore.nativeRisuPosition) }
        : {}),
      ...(lore.relatedIds
        ? { relatedIds: lore.relatedIds.map((id) => `${prefix}:lore:${id}`) }
        : {}),
    }));
  if (pkg.body !== undefined)
    resources.unshift(
      resource('body', pkg.title, pkg.description, pkg.body, 'pinned', attachment.role)
    );
  if (pkg.identity)
    resources.unshift(
      resource(
        'identity',
        pkg.identity.name,
        '',
        pkg.identity.description,
        'pinned',
        attachment.role
      )
    );
  const instructions = context.resourcesOnly
    ? []
    : pkg.instructions
        .filter(
          (item) =>
            item.target === context.target &&
            (!item.attachmentRoles || item.attachmentRoles.includes(attachment.role))
        )
        .map((item) => ({
          id: `${prefix}:instruction:${item.id}`,
          text: item.text,
          ...(item.position ? { position: item.position } : {}),
        }));
  return { resources, pinned: resources.filter((item) => item.loading === 'pinned'), instructions };
}
