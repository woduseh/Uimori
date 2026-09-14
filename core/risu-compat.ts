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
  partial?: 'variable-write' | 'unsupported-names' | 'error';
  error?: string;
};
export type RisuCompatReceipt = { version: 1; entries: RisuCompatEntry[] };
export const RISU_COMPAT_LIMITS = { entries: 500, textChars: 200_000, sourceChars: 200_000 };

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
    const entry = record(raw, ['key', 'inputHash', 'text', 'unsupported', 'partial', 'error']);
    text(entry.key, 400);
    keys.push(entry.key);
    if (typeof entry.inputHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.inputHash))
      fail('RISU_COMPAT_INPUT_HASH');
    text(entry.text, RISU_COMPAT_LIMITS.textChars);
    if (!Array.isArray(entry.unsupported) || entry.unsupported.length > 200)
      fail('RISU_COMPAT_UNSUPPORTED_LIMIT');
    for (const name of entry.unsupported as unknown[]) text(name, 200);
    if (entry.partial !== undefined && !PARTIAL.includes(entry.partial as string))
      fail('RISU_COMPAT_PARTIAL');
    if (entry.error !== undefined) text(entry.error, 400);
  }
  if (new Set(keys).size !== keys.length) fail('RISU_COMPAT_DUPLICATE_KEY');
  return structuredClone(value) as RisuCompatReceipt;
}
