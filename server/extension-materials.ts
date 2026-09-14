import { createHash } from 'node:crypto';
import { projectChatPackageCompilation } from '../core/chat-overrides.js';
import { packageControlKey, type PackageAttachment } from '../core/content-package.js';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import {
  HOST_LIST_PAGE_DEFAULT,
  HOST_LIST_PAGE_MAX,
  HOST_TEXT_PAGE_DEFAULT,
  HOST_TEXT_PAGE_MAX,
  pageSlice,
  pageText,
} from '../core/paging.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { ProfileSnapshot } from '../core/product.js';
import type { RuntimeValue } from '../core/prompt-values.js';

function fail(code: string): never {
  throw new ExtensionProgramError(code);
}

function argumentsFor(value: RuntimeValue, allowed: string[]): Record<string, RuntimeValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BEHAVIOR_HOST_ARGUMENTS');
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('BEHAVIOR_HOST_ARGUMENTS');
  return value as Record<string, RuntimeValue>;
}

function integer(value: RuntimeValue | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('BEHAVIOR_HOST_ARGUMENTS');
  return value as number;
}

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
): (method: string, args: RuntimeValue, signal: AbortSignal) => Promise<RuntimeValue> {
  const permitted = program.capabilities?.includes('materials.read.self') === true;
  // Private copies prevent in-flight changes from changing an invocation's read set.
  const captured = permitted && profile ? structuredClone(profile) : undefined;
  const ref = structuredClone(attachment);
  const materials = () => {
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
    const identity = packageIdentityFromProfile(captured, 'main');
    const compiled = compilePackageAttachment(pkg, ref, {
      chatId: captured.chatId,
      target: 'main',
      values: captured.packageValues?.[packageControlKey(ref)],
      identity,
      resourcesOnly: true,
    });
    return projectChatPackageCompilation(
      captured,
      ref,
      pkg,
      compiled,
      (role) => !historicalPersonaExcluded(captured, role),
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
  return async (method, value, signal): Promise<RuntimeValue> => {
    if (signal.aborted) fail('BEHAVIOR_HOST_ABORTED');
    if (!permitted || !['materials.list', 'materials.read'].includes(method))
      fail('BEHAVIOR_HOST_DENIED');
    // Recheck the action owner before each disclosure, including cached reads.
    assertCurrent();
    const args = argumentsFor(
      value,
      method === 'materials.list' ? ['offset', 'limit'] : ['id', 'offset', 'limit']
    );
    const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(
      args.limit,
      method === 'materials.list' ? HOST_LIST_PAGE_DEFAULT : HOST_TEXT_PAGE_DEFAULT,
      1,
      method === 'materials.list' ? HOST_LIST_PAGE_MAX : HOST_TEXT_PAGE_MAX
    );
    if (method === 'materials.read' && (typeof args.id !== 'string' || args.id.length > 1000))
      fail('BEHAVIOR_HOST_ARGUMENTS');
    frozen ??= materials();
    if (method === 'materials.list') {
      if (offset > frozen.length) fail('BEHAVIOR_HOST_ARGUMENTS');
      const page = pageSlice(frozen, offset, limit);
      return { items: page.items.map((item) => item.metadata), nextOffset: page.nextOffset };
    }
    // Absent and out-of-scope IDs intentionally have the same result.
    const material = frozen.find((item) => item.metadata.id === args.id);
    if (!material) fail('BEHAVIOR_HOST_MATERIAL_UNAVAILABLE');
    if (offset > material.text.length) fail('BEHAVIOR_HOST_ARGUMENTS');
    const page = pageText(material.text, offset, limit);
    return {
      ...material.metadata,
      text: page.text,
      offset: page.offset,
      nextOffset: page.nextOffset,
    };
  };
}
