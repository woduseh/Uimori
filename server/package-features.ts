import { HttpError, fields, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import {
  validateContentAttachment,
  type RisuContent,
  type ContentAttachment,
} from '../core/risu-content.js';
import type { ChatProfile, Content, ProfileSnapshot } from '../core/product.js';
import type { ProductStore } from './product-store.js';
import type { Store } from './store.js';
import { assertPackageImages } from './package-images.js';
import { resolvePackageGraph } from '../core/package-graph.js';

/** Live links follow IDs; a frozen closure resolves dependencies from its captured refs. */
export function resolvePackageModules(
  product: ProductStore,
  roots: ContentAttachment[],
  options: { latest?: boolean; frozen?: ContentAttachment[] } = {}
): { attachments: ContentAttachment[]; packages: RisuContent[] } {
  const { attachments, packages } = resolvePackageGraph(
    {
      latestRevision: (id) => {
        const row = product.db
          .prepare(
            "SELECT revision FROM versions WHERE kind='content' AND id=? ORDER BY revision DESC LIMIT 1"
          )
          .get(id) as { revision: number } | undefined;
        if (!row) throw new HttpError(404, 'content revision not found');
        return row.revision;
      },
      read: (ref) => {
        const pkg = product.get<Content>('content', ref.id, ref.revision).package;
        if (!pkg) throw new HttpError(400, 'Required module is not a package');
        return pkg;
      },
    },
    roots,
    options
  );
  return { attachments, packages };
}
export function assertPackageReferences(product: ProductStore, pkg: RisuContent) {
  assertPackageImages(product, pkg);
  for (const module of pkg.modules ?? [])
    if (!product.get<Content>('content', module.id).package)
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
    const roots = b.attachments.map(validateContentAttachment),
      resolved = resolvePackageModules(store.product, roots, { latest: true });
    return {
      ...resolved,
      required: resolved.attachments.filter(
        (ref) => !roots.some((root) => root.id === ref.id && root.role === ref.role)
      ),
    };
  });
}
