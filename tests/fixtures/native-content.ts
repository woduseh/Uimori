import { createHash } from 'node:crypto';
import type { RisuContent } from '../../core/risu-content.js';
import type { ContentKind } from '../../core/product.js';
import type { ContentDraftModel, EditDraftModel } from '../../core/edit-drafts.js';
import { projectNativeRisuPackage } from '../../server/risu-native-projection.js';

/** Synthetic Risu authorship: the same projection used by actual card imports. */
export function nativeContent(
  card: Record<string, unknown> = {},
  metadata: Partial<
    Pick<RisuContent, 'id' | 'revision' | 'images' | 'portraitImageId' | 'modules' | 'imageHandoff'>
  > = {},
  kind: ContentKind = 'bot'
): RisuContent {
  const source = { name: 'Synthetic Risu card', description: '', creator_notes: '', ...card };
  return projectNativeRisuPackage(
    {
      version: 2,
      id: metadata.id ?? 'synthetic-risu',
      revision: metadata.revision ?? 1,
      title: String(source.name),
      description: '',
      lore: [],
      ...metadata,
      nativeRisu: {
        version: 1,
        card: source,
        assets: [],
        sourceHash: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
      },
    },
    kind
  ).pkg;
}

/** Edit the authored card name, then derive the list/editor projection from it. */
export function nativeDraftTitle(model: EditDraftModel, title: string): ContentDraftModel {
  const content = model as ContentDraftModel;
  const pkg = nativeContent(
    { ...content.package.nativeRisu.card, name: title },
    content.package,
    content.kind
  );
  return { ...content, title: pkg.title, package: pkg };
}
