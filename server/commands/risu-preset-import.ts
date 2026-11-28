import { risuPresetOperations } from '#contracts/operations';
import { AppError } from '../app-errors.js';
import { canonicalPayloadHash, defineCommand } from '../command.js';
import { analyzeRisuPreset } from '../risu-preset-analysis.js';
import type { AppPorts } from '../store-ports.js';

export const applyRisuPresetCommand = defineCommand<
  Pick<AppPorts, 'tx' | 'importReceipt' | 'risuImport'>
>()(risuPresetOperations.apply, {
  receipt: {
    store: (ports) => ports.importReceipt,
    scope: () => 'risu-preset:',
    key: (head) => head.idempotencyKey,
    digest: (_head, { digest: _previewDigest, ...request }) => canonicalPayloadHash(request),
    serialize: ({ receipt }) => ({ receipt }),
    onReplay: (_tx, ports, record) => ({
      receipt: { ...record.receipt, created: false },
      preset: ports.risuImport.preset(record.receipt),
    }),
  },
  async prepare(_ports, head, raw) {
    const { bundle, preview } = analyzeRisuPreset(raw.source);
    if (preview.digest !== head.digest) throw new AppError(409, 'RISU_IMPORT_DRAFT_CHANGED');
    if (!head.allowPartial && preview.findings.some((item) => item.level === 'unsupported'))
      throw new AppError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
    return bundle;
  },
  guard: () => {},
  apply(tx, ports, _input, _guarded, prepared) {
    const receipt = ports.risuImport.persistPreset(tx, prepared);
    return { receipt, preset: ports.risuImport.preset(receipt) };
  },
});
