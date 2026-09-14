import { CHAT_VARIABLE_LIMITS } from './chat-variables.js';
import {
  packageControlKey,
  type ContentPackage,
  type PackageAttachment,
} from './content-package.js';

/**
 * The frozen result of evaluating one package field's preserved Risu CBS. Inputs are read once at
 * reservation; a restore projects this receipt instead of evaluating anything again, so the text a
 * run sent stays the text a replay reconstructs.
 */
export type RisuCompatEntry = {
  key: string;
  inputHash: string;
  text: string;
  unsupported: string[];
  /**
   * The `setvar`/`addvar`/`setdefaultvar` calls this evaluation made, in call order; a later write to
   * the same key stays a later element. Present only when the evaluation wrote something.
   */
  writes?: { key: string; value: string }[];
  /**
   * `variable-write` means this entry wrote variables and they reach the branch shared variables at
   * source save, under the chat's own grant for this material revision - not that they were dropped.
   */
  partial?: 'variable-write' | 'unsupported-names' | 'error';
  error?: string;
};
export type RisuCompatReceipt = { version: 1; entries: RisuCompatEntry[] };
export const RISU_COMPAT_LIMITS = {
  entries: 500,
  textChars: 200_000,
  sourceChars: 200_000,
  writes: 200,
};

export class RisuCompatError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'RisuCompatError';
  }
}
const fail = (code: string): never => {
  throw new RisuCompatError(code);
};

/** One field of one attached revision. The attachment prefix is `packageControlKey`'s, unchanged. */
export function risuCompatKey(attachment: PackageAttachment, fieldId: string): string {
  return `${packageControlKey(attachment)}:${fieldId}`;
}

/** Resolves every declared field id to the text stored on the package, in declaration order. */
export function risuCompatFields(pkg: ContentPackage): { fieldId: string; text: string }[] {
  const stored = (fieldId: string): string | undefined => {
    if (fieldId === 'body') return pkg.body;
    const [kind, ...rest] = fieldId.split(':');
    const id = rest.join(':');
    if (kind === 'lore') return pkg.lore.find((item) => item.id === id)?.text;
    if (kind === 'instruction') return pkg.instructions.find((item) => item.id === id)?.text;
    if (kind === 'start') return pkg.starts?.find((item) => item.id === id)?.text;
    return undefined;
  };
  return (pkg.compat?.risuCbs.fields ?? []).flatMap((fieldId) => {
    const text = stored(fieldId);
    return text === undefined ? [] : [{ fieldId, text }];
  });
}

/**
 * The only CBS functions whose callback reaches `setChatVar`, read from the pinned snapshot
 * `third_party/risuai/cad8595a/cbs.ts` (`addvar` at line 808, `setvar` at 824, `setdefaultvar` at
 * 840); each registers an empty alias list, so these three names are the whole set.
 */
const RISU_COMPAT_WRITE_NAMES = ['addvar', 'setvar', 'setdefaultvar'];
/**
 * Risu resolves a token's function name by lowercasing it and dropping spaces, underscores and
 * hyphens, so `{{ set_var::hp::1 }}` calls `setvar`. The scan tolerates the same separators before and
 * inside the name. It is a declaration scan, not an evaluation: whether a branch actually runs is only
 * known once a reservation evaluates the field.
 */
const RISU_COMPAT_WRITE_TOKEN = new RegExp(
  `\\{\\{[\\s_-]*(?:${RISU_COMPAT_WRITE_NAMES.map((name) => [...name].join('[\\s_-]*')).join('|')})`,
  'iu'
);

/**
 * Whether a package asks the chat for 공유 변수 변경 허용 through preserved Risu CBS. A card that kept
 * its original code carries no program to declare the capability, so the request is a declared field
 * whose preserved text calls one of the write functions - the user still answers it, exactly as for a
 * program that declares `variables.write` without always using it.
 */
export const risuCompatRequestsVariableWrite = (pkg: ContentPackage | undefined): boolean =>
  !!pkg && risuCompatFields(pkg).some((field) => RISU_COMPAT_WRITE_TOKEN.test(field.text));

/** The projection `compilePackageAttachment` reads: the attachment's own entries, by field id. */
export function projectRisuCompatReceipt(
  receipt: RisuCompatReceipt,
  attachment: PackageAttachment
): Record<string, string> {
  const prefix = risuCompatKey(attachment, '');
  const result: Record<string, string> = {};
  for (const entry of receipt.entries)
    if (entry.key.startsWith(prefix)) result[entry.key.slice(prefix.length)] = entry.text;
  return result;
}

/**
 * Every entry's writes in entry order - attachment order, then field declaration order - flattened.
 * This is the single definition of the order the source-save commit applies them in, so a later write
 * to a key an earlier field already wrote wins.
 */
export function risuCompatWrites(receipt: RisuCompatReceipt): { key: string; value: string }[] {
  return receipt.entries.flatMap((entry) => entry.writes ?? []);
}

const PARTIAL = ['variable-write', 'unsupported-names', 'error'];
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail('RISU_COMPAT_INVALID_FIELDS');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) fail('RISU_COMPAT_INVALID_STRING');
}

/** Data-only validation. An archived receipt is read back through exactly this contract. */
export function validateRisuCompatReceipt(value: unknown): RisuCompatReceipt {
  const receipt = record(value, ['version', 'entries']);
  if (receipt.version !== 1) fail('RISU_COMPAT_VERSION_UNSUPPORTED');
  if (!Array.isArray(receipt.entries) || receipt.entries.length > RISU_COMPAT_LIMITS.entries)
    fail('RISU_COMPAT_ENTRY_LIMIT');
  const keys: string[] = [];
  for (const raw of receipt.entries as unknown[]) {
    const entry = record(raw, [
      'key',
      'inputHash',
      'text',
      'unsupported',
      'writes',
      'partial',
      'error',
    ]);
    text(entry.key, 400);
    keys.push(entry.key);
    if (typeof entry.inputHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.inputHash))
      fail('RISU_COMPAT_INPUT_HASH');
    text(entry.text, RISU_COMPAT_LIMITS.textChars);
    if (!Array.isArray(entry.unsupported) || entry.unsupported.length > 200)
      fail('RISU_COMPAT_UNSUPPORTED_LIMIT');
    for (const name of entry.unsupported as unknown[]) text(name, 200);
    if (entry.writes !== undefined) {
      if (!Array.isArray(entry.writes) || entry.writes.length > RISU_COMPAT_LIMITS.writes)
        fail('RISU_COMPAT_WRITE_LIMIT');
      for (const raw of entry.writes as unknown[]) {
        const write = record(raw, ['key', 'value']);
        text(write.key, 200);
        if (!write.key) fail('RISU_COMPAT_WRITE_KEY');
        // The value is admitted here on the chat variable writer's own limit; the commit still
        // projects the whole state through that writer before anything reaches the branch.
        text(write.value, CHAT_VARIABLE_LIMITS.maxValueChars);
      }
    }
    if (entry.partial !== undefined && !PARTIAL.includes(entry.partial as string))
      fail('RISU_COMPAT_PARTIAL');
    if (entry.error !== undefined) text(entry.error, 400);
  }
  if (new Set(keys).size !== keys.length) fail('RISU_COMPAT_DUPLICATE_KEY');
  return structuredClone(value) as RisuCompatReceipt;
}
