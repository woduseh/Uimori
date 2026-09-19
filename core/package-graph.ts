import {
  validateRisuContent,
  validateContentAttachment,
  type RisuContent,
  type ContentAttachment,
} from './risu-content.js';
import type { ContentRef } from './product.js';

export type PackageGraphReader = {
  read(ref: ContentRef): RisuContent;
  latestRevision?(id: string): number;
};
export class PackageGraphError extends Error {
  readonly statusCode = 400;
}

/** Preserve declaration-order execution; persistence alone uses dependency-first order. */
export function resolvePackageGraph(
  reader: PackageGraphReader,
  roots: ContentAttachment[],
  options: { latest?: boolean; frozen?: ContentAttachment[] } = {}
): { attachments: ContentAttachment[]; packages: RisuContent[]; persistOrder: ContentRef[] } {
  const attachments: ContentAttachment[] = [],
    packages: RisuContent[] = [],
    persistOrder: ContentRef[] = [],
    persisted = new Set<string>(),
    seen = new Map<string, number>(),
    active = new Set<string>();
  const visit = (raw: ContentAttachment, depth: number) => {
    const validated = validateContentAttachment(raw);
    const captured = options.frozen?.find((r) => r.id === raw.id && r.role === raw.role);
    if (options.frozen && !captured)
      throw new PackageGraphError('Frozen module dependency missing');
    const ref = options.latest
        ? { ...validated, revision: reader.latestRevision!(raw.id) }
        : (captured ?? validated),
      key = `${ref.id}:${ref.role}`,
      identity = `${ref.id}@${ref.revision}`;
    if (active.has(identity)) throw new PackageGraphError('Package module dependency cycle');
    if (seen.has(key)) {
      if (seen.get(key) !== ref.revision)
        throw new PackageGraphError('Package module revision conflict');
      return;
    }
    if (depth > 20 || attachments.length >= 100)
      throw new PackageGraphError('Package module dependency limit');
    const pkg = validateRisuContent(reader.read(ref));
    if (pkg.id !== ref.id || pkg.revision !== ref.revision)
      throw new PackageGraphError('Package module revision conflict');
    seen.set(key, ref.revision);
    active.add(identity);
    attachments.push(ref);
    packages.push(pkg);
    for (const module of pkg.modules ?? []) visit({ ...module, role: 'module' }, depth + 1);
    active.delete(identity);
    if (!persisted.has(identity)) {
      persisted.add(identity);
      persistOrder.push({ id: ref.id, revision: ref.revision });
    }
  };
  for (const root of roots) visit(root, 0);
  return { attachments, packages, persistOrder };
}
