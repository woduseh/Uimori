import { createHash } from 'node:crypto';
import type { RisuContent } from '../core/risu-content.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
} from '../core/native-transfer.js';
import type { RisuImportPreview } from '../core/risu-import.js';
import { prepareNativeTransfer } from './native-transfer.js';
import {
  validatePreparedNativeTransfer,
  type PreparedNativeTransferFile,
} from '../core/native-transfer-validation.js';
import { string, type RisuCard, type RisuCardInput } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/**
 * Assembles the transfer file the import applies and the preview the import screen shows. The
 * digest covers everything the reader agreed to, so a file or a finding that changed invalidates it.
 */
type TransferInput = {
  input: Pick<RisuCardInput, 'hash' | 'source' | 'kind'> & { format: RisuImportPreview['format'] };
  card: RisuCard;
  pkg: RisuContent;
  title: string;
  lore: RisuImportPreview['lore'];
  findings: RisuImportFindings;
};
export function buildRisuTransfer(
  value: TransferInput & { images: PreparedNativeTransferFile['images']; prepared: true }
): { file: PreparedNativeTransferFile; preview: RisuImportPreview };
export function buildRisuTransfer(
  value: TransferInput & { images: NativeTransferFile['images']; prepared?: false }
): { file: NativeTransferFile; preview: RisuImportPreview };
export function buildRisuTransfer({
  input,
  card,
  pkg,
  title,
  images,
  lore,
  findings,
  prepared = false,
}: {
  /** Every reader that reaches this builder: a character card or a module. */
  input: Pick<RisuCardInput, 'hash' | 'source' | 'kind'> & {
    format: RisuImportPreview['format'];
  };
  card: RisuCard;
  pkg: RisuContent;
  title: string;
  images: PreparedNativeTransferFile['images'];
  lore: RisuImportPreview['lore'];
  findings: RisuImportFindings;
  prepared?: boolean;
}): { file: PreparedNativeTransferFile; preview: RisuImportPreview } {
  const { kind } = input;
  const file: PreparedNativeTransferFile = {
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
  };
  const transfer = prepared
    ? {
        digest: createHash('sha256')
          .update(JSON.stringify(validatePreparedNativeTransfer(file).file))
          .digest('hex'),
      }
    : prepareNativeTransfer({ file });
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
    lore,
    findings: findings.list,
    ...(pkg.imageHandoff ? { imageHandoff: pkg.imageHandoff } : {}),
  };
  return { file, preview };
}
