import { z } from 'zod/v4';
import type { NativeTransferReceipt } from '../import-receipt.js';
import { defineCommandOperation } from '../../split-operation.js';
import { nonBlank } from '../text.js';

export const risuOperations = {
  apply: defineCommandOperation<{ receipt: NativeTransferReceipt; chat: { id: string } | null }>()({
    name: 'risu.import.apply',
    head: z.strictObject({
      idempotencyKey: nonBlank(100),
      digest: nonBlank(100),
    }),
    body: z.strictObject({
      preparedId: z.string().optional(),
      kind: z.enum(['bot', 'persona', 'module']).optional(),
      imageHandoffIds: z.array(z.string()).max(64).optional(),
      source: z.unknown(),
      createChat: z.boolean().optional(),
      allowPartial: z.boolean(),
    }),
  }),
};
