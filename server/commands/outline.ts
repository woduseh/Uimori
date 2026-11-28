import { outlineOperations } from '#contracts/operations';
import { canonicalPayloadHash, defineCommand } from '../command.js';
import type { AppPorts } from '../store-ports.js';

type FocusPorts = Pick<AppPorts, 'tx' | 'events' | 'chatGuard' | 'outline'>;
type ApplyPorts = Pick<AppPorts, 'tx' | 'outlineReceipt' | 'events' | 'chatGuard' | 'outline'>;

export const setOutlineFocusCommand = defineCommand<FocusPorts>()(outlineOperations.setFocus, {
  guard(tx, ports, head) {
    ports.chatGuard.writableChat(tx, head.chatId);
  },
  apply(tx, ports, input) {
    return ports.outline.setFocus(tx, input.chatId, input.nodeId);
  },
  afterCommit(ports, _output, input) {
    ports.events.publish(input.chatId);
  },
});

export const applyOutlineCommand = defineCommand<ApplyPorts>()(outlineOperations.apply, {
  receipt: {
    store: (ports) => ports.outlineReceipt,
    scope: (head) => head.chatId,
    key: (head) => head.idempotencyKey,
    digest: (_head, raw) => {
      const { chatId: _chatId, idempotencyKey: _idempotencyKey, ...body } = raw;
      return canonicalPayloadHash(body);
    },
    conflictMessage: 'Outline idempotency key was used for a different batch',
    serialize: (output, input) => ({
      authority: 'user' as const,
      operations: input.operations,
      created: output.created,
    }),
    onReplay: (_tx, ports, record, head) => ({
      detail: ports.outline.detail(head.chatId),
      created: [...record.created],
    }),
  },
  guard(tx, ports, head) {
    ports.chatGuard.writableChat(tx, head.chatId);
  },
  apply(tx, ports, input) {
    const created = ports.outline.applyBatch(tx, input.chatId, input.operations);
    return { detail: ports.outline.detail(input.chatId), created };
  },
  afterCommit(ports, _output, input) {
    ports.events.publish(input.chatId);
  },
});
