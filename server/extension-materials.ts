import { createHash } from 'node:crypto';
import { projectChatPackageCompilation } from '../core/chat-overrides.js';
import { packageControlKey, type PackageAttachment } from '../core/content-package.js';
import type { ExtensionProgram } from '../core/extension-program.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import { pageSlice, pageText } from '../core/paging.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { ProfileSnapshot } from '../core/product.js';
import {
  createHostDispatcher,
  failHost as fail,
  hostArguments,
  type HostMethodOf,
} from './extension-host-methods.js';
import type { ExtensionHostHandler } from './extension-runtime.js';

/**
 * Creates a read-only broker bound by the caller, never by guest-supplied chat/package IDs.
 * The captured profile is the user-action view or immutable Run profile. No live library lookup,
 * transcript, notes, credentials, DOM or network client is reachable through this closure.
 */
export function createPackageExtensionHost(
  program: ExtensionProgram,
  profile: ProfileSnapshot | undefined,
  attachment: PackageAttachment,
  assertCurrent: () => void
): ExtensionHostHandler {
  const permitted = program.capabilities?.includes('materials.read.self') === true;
  // Private copies prevent in-flight changes from changing an invocation's read set.
  const captured = permitted && profile ? structuredClone(profile) : undefined;
  const ref = structuredClone(attachment);
  /** The captured attachment this program owns, refused when the fixed profile no longer holds it. */
  const owned = () => {
    if (
      !captured ||
      historicalPersonaExcluded(captured, ref.role) ||
      !captured.packageAttachments?.some(
        (item) => item.id === ref.id && item.revision === ref.revision && item.role === ref.role
      )
    )
      fail('BEHAVIOR_HOST_DENIED');
    const pkg = captured.packages?.find(
      (item) => item.id === ref.id && item.revision === ref.revision
    );
    if (!pkg) fail('BEHAVIOR_HOST_DENIED');
    return { profile: captured, pkg };
  };
  const materials = () => {
    const { profile: owner, pkg } = owned();
    const identity = packageIdentityFromProfile(owner, 'main');
    const compiled = compilePackageAttachment(pkg, ref, {
      chatId: owner.chatId,
      target: 'main',
      values: owner.packageValues?.[packageControlKey(ref)],
      identity,
      resourcesOnly: true,
    });
    return projectChatPackageCompilation(
      owner,
      ref,
      pkg,
      compiled,
      (role) => !historicalPersonaExcluded(owner, role),
      identity
    ).compiled.resources.map((resource) => ({
      metadata: {
        id: resource.id,
        title: resource.title.slice(0, 256),
        description: resource.description.slice(0, 512),
        kind: resource.sourceKind ?? 'lore',
        revision: resource.revision,
        contentHash: createHash('sha256').update(resource.text).digest('hex'),
        totalChars: resource.text.length,
      },
      text: resource.text,
    }));
  };
  let frozen: ReturnType<typeof materials> | undefined;
  const read = () => (frozen ??= materials());
  return createHostDispatcher<HostMethodOf<'materials'>>({
    denied: 'BEHAVIOR_HOST_DENIED',
    granted: (entry) => program.capabilities?.includes(entry.capability) === true,
    screen: hostArguments,
    // Recheck the action owner before each disclosure, including cached reads.
    gate: () => assertCurrent(),
    handlers: {
      // The same projected names the body and lore templates substitute; no other profile field.
      'identity.read': async () => {
        const identity = packageIdentityFromProfile(owned().profile, 'main');
        return { botName: identity.bot.name, userName: identity.user.name };
      },
      'materials.list': async ({ offset, limit }) => {
        const items = read();
        if (offset > items.length) fail('BEHAVIOR_HOST_ARGUMENTS');
        const page = pageSlice(items, offset, limit);
        return { items: page.items.map((item) => item.metadata), nextOffset: page.nextOffset };
      },
      'materials.read': async ({ args, offset, limit }) => {
        if (typeof args.id !== 'string' || args.id.length > 1000) fail('BEHAVIOR_HOST_ARGUMENTS');
        // Absent and out-of-scope IDs intentionally have the same result.
        const material = read().find((item) => item.metadata.id === args.id);
        if (!material) fail('BEHAVIOR_HOST_MATERIAL_UNAVAILABLE');
        if (offset > material.text.length) fail('BEHAVIOR_HOST_ARGUMENTS');
        const page = pageText(material.text, offset, limit);
        return {
          ...material.metadata,
          text: page.text,
          offset: page.offset,
          nextOffset: page.nextOffset,
        };
      },
    },
  });
}
