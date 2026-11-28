import { z } from 'zod/v4';
import type { NativeTransferReceipt } from '../import-receipt.js';
import { defineCommandOperation } from '../../split-operation.js';
import { nonBlank } from '../text.js';

export const risuPresetOperations = {
  apply: defineCommandOperation<{ receipt: NativeTransferReceipt; preset: { id: string } }>()({
    name: 'risuPreset.import.apply',
    head: z.strictObject({
      idempotencyKey: nonBlank(100),
      digest: nonBlank(100),
      allowPartial: z.boolean(),
    }),
    body: z.strictObject({
      source: z.unknown(),
    }),
  }),
};
