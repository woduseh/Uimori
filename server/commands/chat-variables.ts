import { isDeepStrictEqual } from 'node:util';
import { chatSettingsOperations } from '#contracts/operations';
import { CHAT_VARIABLE_LIMITS, validateChatVariableValues } from '../../core/chat-variables.js';
import { AppError, assertRevision, HttpError } from '../app-errors.js';
import { canonicalPayloadHash, defineCommand } from '../command.js';
import type { AppPorts } from '../store-ports.js';

type Ports = Pick<AppPorts, 'tx' | 'receipt' | 'events' | 'chatGuard' | 'chatVariables'>;

function validateMergedVariables(values: Record<string, string>): Record<string, string> {
  try {
    return validateChatVariableValues(values);
  } catch {
    const error = new AppError(400, 'INVALID_REQUEST');
    error.message = `INVALID_REQUEST: At most ${CHAT_VARIABLE_LIMITS.maxEntries} variables, ${CHAT_VARIABLE_LIMITS.maxValueChars} characters per value and ${CHAT_VARIABLE_LIMITS.maxTotalChars} in total.`;
    throw error;
  }
}

export const updateChatVariablesCommand = defineCommand<Ports>()(
  chatSettingsOperations.writeVariables,
  {
    receipt: {
      adapter: 'chat-variables',
      scope: (head) => head.chatId,
      key: (head) => head.idempotencyKey,
      digest: (_head, raw) => {
        const { chatId: _chatId, ...command } = raw;
        return canonicalPayloadHash(command);
      },
      conflictMessage: 'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT',
      serialize: (output) => ({ revision: output.revision }),
      onReplay: (_tx, ports, _record, head) => ports.chatVariables.view(head.chatId),
    },
    guard(tx, ports, head) {
      const chat = ports.chatGuard.writableChat(tx, head.chatId);
      if (ports.chatGuard.hasActiveRun(tx, head.chatId))
        throw new HttpError(409, 'CHAT_VARIABLE_CHAT_BUSY');
      const current = ports.chatVariables.read(head.chatId);
      assertRevision(current.revision, head.expectedRevision);
      const sourceHash = ports.chatGuard.sourceHash(tx, chat);
      if (sourceHash !== head.expectedSourceHash) throw new AppError(409, 'REVISION_CONFLICT');
      return { current };
    },
    apply(tx, ports, input, guarded) {
      if ('values' in input) {
        const saved = ports.chatVariables.save(tx, input.chatId, {
          revision: guarded.current.revision + 1,
          values: validateMergedVariables(input.values),
        });
        return ports.chatVariables.view(input.chatId, saved);
      }
      const next: Record<string, string> = { ...guarded.current.values, ...(input.set ?? {}) };
      for (const name of input.unset ?? []) delete next[name];
      const validated = validateMergedVariables(next);
      if (isDeepStrictEqual(validated, guarded.current.values))
        return ports.chatVariables.view(input.chatId, guarded.current);
      const saved = ports.chatVariables.save(tx, input.chatId, {
        revision: guarded.current.revision + 1,
        values: validated,
      });
      return ports.chatVariables.view(input.chatId, saved);
    },
    afterCommit(ports, output, input, guarded) {
      if (output.revision !== guarded.current.revision) ports.events.publish(input.chatId);
    },
  }
);
