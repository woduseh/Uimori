import type { FastifyInstance } from 'fastify';
import {
  validateContentPackage,
  validatePackageAttachment,
  type ContentPackage,
  type PackageAttachment,
} from '../core/content-package.js';
import type { ChatProfile, Content, ProfileSnapshot } from '../core/product.js';
import type { ProductStore } from './product-store.js';
import { fields, record } from './product-store.js';
import { HttpError, type Store } from './store.js';
import { assertPackageImages } from './package-images.js';

/** Live links follow IDs; a frozen closure resolves dependencies from its captured refs. */
export function resolvePackageModules(
  product: ProductStore,
  roots: PackageAttachment[],
  options: { latest?: boolean; frozen?: PackageAttachment[] } = {}
): { attachments: PackageAttachment[]; packages: ContentPackage[] } {
  const attachments: PackageAttachment[] = [],
    packages: ContentPackage[] = [],
    seen = new Map<string, number>(),
    active = new Set<string>();
  const visit = (raw: PackageAttachment, depth: number) => {
    const validated = validatePackageAttachment(raw);
    const captured = options.frozen?.find((r) => r.id === raw.id && r.role === raw.role);
    if (options.frozen && !captured) throw new HttpError(400, 'Frozen module dependency missing');
    const ref = options.latest
        ? { ...validated, revision: product.get<Content>('content', raw.id).revision }
        : (captured ?? validated),
      key = `${ref.id}:${ref.role}`,
      identity = `${ref.id}@${ref.revision}`;
    if (active.has(identity)) throw new HttpError(400, 'Package module dependency cycle');
    if (seen.has(key)) {
      if (seen.get(key) !== ref.revision)
        throw new HttpError(400, 'Package module revision conflict');
      return;
    }
    if (depth > 20 || attachments.length >= 100)
      throw new HttpError(400, 'Package module dependency limit');
    const content = product.get<Content>('content', ref.id, ref.revision);
    if (!content.package) throw new HttpError(400, 'Required module is not a package');
    const pkg = validateContentPackage(content.package);
    seen.set(key, ref.revision);
    active.add(identity);
    attachments.push(ref);
    packages.push(pkg);
    for (const module of pkg.modules ?? []) visit({ ...module, role: 'module' }, depth + 1);
    active.delete(identity);
  };
  for (const root of roots) visit(root, 0);
  return { attachments, packages };
}
export function assertPackageReferences(product: ProductStore, pkg: ContentPackage) {
  assertPackageImages(product, pkg);
  for (const module of pkg.modules ?? [])
    if (!product.get<Content>('content', module.id, module.revision).package)
      throw new HttpError(400, 'Required module is not a package');
}
export function resolvePackageProfile(
  product: ProductStore,
  profile: ChatProfile
): Pick<ProfileSnapshot, 'packageAttachments' | 'packages'> {
  const resolved = resolvePackageModules(product, profile.packageAttachments ?? [], {
    latest: true,
  });
  return profile.packageAttachments !== undefined
    ? { packageAttachments: resolved.attachments, packages: resolved.packages }
    : {};
}
export function packageFeatureRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/packages/resolve', async (request) => {
    const b = record(request.body);
    fields(b, ['attachments']);
    if (!Array.isArray(b.attachments) || b.attachments.length > 100)
      throw new HttpError(400, 'Invalid package attachments');
    const roots = b.attachments.map(validatePackageAttachment),
      resolved = resolvePackageModules(store.product, roots, { latest: true });
    return {
      ...resolved,
      required: resolved.attachments.filter(
        (ref) => !roots.some((root) => root.id === ref.id && root.role === ref.role)
      ),
    };
  });
}
