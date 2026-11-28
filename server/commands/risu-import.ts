import { risuOperations } from '#contracts/operations';
import { AppError, HttpError } from '../app-errors.js';
import { defineCommand } from '../command.js';
import type { AppPorts } from '../store-ports.js';

export const applyRisuCommand = defineCommand<
  Pick<AppPorts, 'tx' | 'importReceipt' | 'risuImport'>
>()(risuOperations.apply, {
  receipt: {
    store: (ports) => ports.importReceipt,
    scope: () => 'risu-result:',
    key: (head) => head.idempotencyKey,
    serialize: ({ receipt, chat }) => ({ receipt, chatId: chat?.id }),
    onReplay: (_tx, ports, record) => ({
      receipt: { ...record.receipt, created: false },
      chat: ports.risuImport.chat(record.chatId),
    }),
  },
  prepare(ports, head, { idempotencyKey: _key, digest: _digest, ...rawBody }) {
    const body = risuOperations.apply.body.safeParse(rawBody);
    if (!body.success) {
      const issue = body.error.issues[0];
      if (issue?.code === 'unrecognized_keys')
        throw new HttpError(400, `Unknown request field: ${issue.keys.join(', ')}`);
      const field = issue?.path[0];
      if (field === 'imageHandoffIds')
        throw new HttpError(400, 'RISU_IMPORT_IMAGE_HANDOFF_SELECTION');
      if (
        field === 'preparedId' ||
        field === 'createChat' ||
        field === 'allowPartial' ||
        field === 'kind'
      )
        throw new AppError(400, 'RISU_IMPORT_INVALID_FILE');
      throw new AppError(400, 'INVALID_REQUEST');
    }
    return ports.risuImport.prepareCard(head.digest, body.data);
  },
  guard: () => {},
  apply(tx, ports, input, _guarded, prepared) {
    return ports.risuImport.persistCard(
      tx,
      prepared,
      input.createChat !== false,
      input.idempotencyKey
    );
  },
  afterCommit(ports, _output, _input, _guarded, prepared) {
    ports.risuImport.consume(prepared.manifest?.id, prepared.uploadId);
  },
});
