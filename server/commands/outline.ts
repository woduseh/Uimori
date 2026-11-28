import type { OutlineCreatedNode } from '#contracts';
import { outlineOperations } from '#contracts/operations';
import { canonicalPayloadHash, defineCommand } from '../command.js';
import type { AppPorts } from '../store-ports.js';

type FocusPorts = Pick<AppPorts, 'tx' | 'events' | 'chatGuard' | 'outline'>;
type ApplyPorts = Pick<AppPorts, 'tx' | 'outlineReceipt' | 'events' | 'chatGuard' | 'outline'>;
type OutlineApplied = { readonly created: OutlineCreatedNode[] };

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

export const applyOutlineCommand = defineCommand<ApplyPorts, OutlineApplied>()(
  outlineOperations.apply,
  {
    receipt: {
      store: (ports) => ports.outlineReceipt,
      scope: (head) => head.chatId,
      key: (head) => head.idempotencyKey,
      digest: (_head, raw) => {
        const { chatId: _chatId, idempotencyKey: _idempotencyKey, ...body } = raw;
        return canonicalPayloadHash(body);
      },
      conflictMessage: 'Outline idempotency key was used for a different batch',
      serialize: (applied, input) => ({
        authority: 'user' as const,
        operations: input.operations,
        created: applied.created,
      }),
      onReplay: (_tx, _ports, record) => ({
        created: [...record.created],
      }),
    },
    guard(tx, ports, head) {
      ports.chatGuard.writableChat(tx, head.chatId);
    },
    apply(tx, ports, input) {
      return { created: ports.outline.applyBatch(tx, input.chatId, input.operations) };
    },
    project(_tx, ports, applied, head) {
      return { detail: ports.outline.detail(head.chatId), created: applied.created };
    },
    afterCommit(ports, _output, input) {
      ports.events.publish(input.chatId);
    },
  }
);
