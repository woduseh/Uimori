import { SOURCE_TEXT_MAX_CHARS } from './content-limits.js';

/** Risu first_mes and alternate_greetings, without another authoring language. */
export type PackageStart = {
  id: string;
  title: string;
  description?: string;
  mode: 'authored';
  text: string;
};
export type PackageStartRef = { packageId: string; packageRevision: number; startId: string };
export type PackageStartSnapshot = PackageStartRef & {
  mode: 'authored';
  title: string;
  text: string;
};
export class PackageStartError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PackageStartError';
  }
}
const fail = (message: string): never => {
  throw new PackageStartError(message);
};
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail('PACKAGE_START_INVALID_FIELDS');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    fail('PACKAGE_START_INVALID_ID');
}
export function validatePackageStartRef(value: unknown): PackageStartRef {
  const ref = record(value, ['packageId', 'packageRevision', 'startId']);
  identifier(ref.packageId);
  identifier(ref.startId);
  if (!Number.isSafeInteger(ref.packageRevision) || Number(ref.packageRevision) < 1)
    fail('PACKAGE_START_INVALID_REVISION');
  return structuredClone(ref) as PackageStartRef;
}
export function validatePackageStarts(value: unknown): PackageStart[] {
  if (!Array.isArray(value)) fail('PACKAGE_START_LIST_LIMIT');
  const ids = new Set<string>();
  for (const raw of value as unknown[]) {
    const item = record(raw, ['id', 'title', 'description', 'mode', 'text']);
    identifier(item.id);
    if (ids.has(item.id)) fail('PACKAGE_START_DUPLICATE_ID');
    ids.add(item.id);
    if (
      item.mode !== 'authored' ||
      typeof item.title !== 'string' ||
      item.title.length > 200 ||
      typeof item.text !== 'string' ||
      (item.description !== undefined &&
        (typeof item.description !== 'string' || item.description.length > 2000))
    )
      fail('PACKAGE_START_INVALID_TEXT');
    // A selected greeting becomes a stored message without truncating its HTML/CSS.
    if ((item.text as string).length > SOURCE_TEXT_MAX_CHARS) fail('PACKAGE_START_TEXT_TOO_LONG');
  }
  return structuredClone(value) as PackageStart[];
}
export function resolvePackageStart(
  pkg: { id: string; revision: number; starts?: PackageStart[] },
  startId: string
): PackageStartSnapshot {
  const start = validatePackageStarts(pkg.starts ?? []).find((item) => item.id === startId);
  if (!start) return fail('PACKAGE_START_NOT_FOUND');
  return {
    packageId: pkg.id,
    packageRevision: pkg.revision,
    startId,
    mode: 'authored',
    title: start.title,
    text: start.text,
  };
}
