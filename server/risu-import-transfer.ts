import { createHash } from 'node:crypto';
import type { ContentPackage } from '../core/content-package.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
} from '../core/native-transfer.js';
import type { RisuImportPreview } from '../core/risu-import.js';
import { prepareNativeTransfer } from './native-transfer.js';
import { string, type RisuCard, type RisuCardInput } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/**
 * Assembles the transfer file the import applies and the preview the import screen shows. The
 * digest covers everything the reader agreed to, so a file or a finding that changed invalidates it.
 */
export function buildRisuTransfer({
  input,
  card,
  pkg,
  title,
  images,
  lore,
  findings,
  plugin,
}: {
  /** Every reader that reaches this builder: a character card, a module, or a plugin file. */
  input: Pick<RisuCardInput, 'hash' | 'source' | 'kind'> & {
    format: RisuImportPreview['format'];
  };
  card: RisuCard;
  pkg: ContentPackage;
  title: string;
  images: NativeTransferFile['images'];
  lore: RisuImportPreview['lore'];
  findings: RisuImportFindings;
  plugin?: RisuImportPreview['plugin'];
}): { file: NativeTransferFile; preview: RisuImportPreview } {
  const { hash, source, kind } = input;
  const file: NativeTransferFile = {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: [{ kind: 'content', key: kind }],
    contents: [
      {
        key: kind,
        source: {
          id: pkg.id,
          revision: 1,
          kind,
          title,
          description: pkg.description,
          // The orchestrator fills in the body, starts and images before the file is assembled.
          text: pkg.body!,
          loading: 'pinned',
          relatedIds: [],
          package: pkg,
        },
        modules: [],
      },
    ],
    prompts: [],
    images,
    // A staged container stays outside the receipt; its identity is reported instead of copied.
    ...(source.base64 === undefined
      ? {}
      : {
          sourceFiles: [
            {
              entryKey: kind,
              name: source.name,
              mediaType:
                input.format === 'charx' || input.format === 'risu-module-project-zip'
                  ? 'application/zip'
                  : input.format === 'risu-module-binary'
                    ? 'application/octet-stream'
                    : input.format === 'risu-plugin-js'
                      ? 'text/javascript'
                      : 'application/json',
              hash,
              base64: source.base64,
            },
          ],
        }),
  };
  const transfer = prepareNativeTransfer({ file });
  const digest = createHash('sha256')
    .update(
      JSON.stringify({ version: 8, transfer: transfer.digest, kind, findings: findings.list, lore })
    )
    .digest('hex');
  const preview: RisuImportPreview = {
    kind,
    digest,
    title,
    description: string(card.creator_notes),
    format: input.format,
    summary: { lore: pkg.lore.length, starts: pkg.starts!.length, images: pkg.images!.length },
    ...(plugin ? { plugin } : {}),
    lore,
    findings: findings.list,
    ...(pkg.imageHandoff ? { imageHandoff: pkg.imageHandoff } : {}),
  };
  return { file, preview };
}
