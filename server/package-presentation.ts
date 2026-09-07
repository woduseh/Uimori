import { createHash } from 'node:crypto';
import { ContentPackageError } from '../core/content-package.js';
import { compiledPackages } from '../core/package-context.js';
import { renderPackageStateView } from '../core/package-runtime.js';
import type { RunSnapshot } from '../core/types.js';
import { applyPackageTransforms } from './package-transforms.js';

export type PackagePresentationSource = {
  id: string; chatId: string; hash: string; text: string;
  translation?: { text: string; sourceRevision: string; sourceHash: string };
};
/** The route supplies an exact source and its originating Run snapshot. No current library reads. */
export async function buildPackagePresentation(snapshot: RunSnapshot, source: PackagePresentationSource, state?: { sourceRevision: string; sourceHash: string; values: Record<string, unknown> }) {
  if (source.chatId !== snapshot.chatId || createHash('sha256').update(source.text).digest('hex') !== source.hash) throw new ContentPackageError('PACKAGE_PRESENTATION_SOURCE_MISMATCH');
  if (source.translation && (source.translation.sourceRevision !== source.id || source.translation.sourceHash !== source.hash)) throw new ContentPackageError('PACKAGE_PRESENTATION_TRANSLATION_MISMATCH');
  if (state && (state.sourceRevision !== source.id || state.sourceHash !== source.hash)) throw new ContentPackageError('PACKAGE_PRESENTATION_STATE_MISMATCH');
  // Presentation uses all attachments even when persona reference is disabled for main writing.
  const packages = compiledPackages(snapshot, 'status');
  const rules = packages.flatMap(p => p.transforms);
  const original = await applyPackageTransforms(source.text, rules, 'source');
  const translation = source.translation ? await applyPackageTransforms(source.translation.text, rules, 'translation') : undefined;
  const views = packages.filter(p => p.stateView).map(p => ({ packageId: p.package.id, revision: p.package.revision, role: p.attachment.role, ...renderPackageStateView(p.stateView!, state?.values ?? {}) }));
  return { sourceRevision: source.id, sourceHash: source.hash, format: 'plain-text' as const, original, ...(translation ? { translation } : {}), stateViews: views };
}
