import type { PackageAttachment } from '../core/content-package.js';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import type { ProfileSnapshot } from '../core/product.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import { createPackageExtensionHost } from './extension-materials.js';
import { executeExtensionProgram, type ExtensionHostHandler } from './extension-runtime.js';
import { createExtensionVariableSession } from './extension-variables.js';
import type { ChatVariableMutation } from '../core/chat-variables.js';
import {
  createConversationExtensionHost,
  extensionConversationViewHash,
  type FrozenExtensionConversation,
} from './extension-conversation.js';

export type PackageExtensionModelServices = {
  modelGenerate: (args: RuntimeValue, signal: AbortSignal) => Promise<RuntimeValue>;
  assertModelAccess: () => void | Promise<void>;
  hostWaitMs: number;
};

type ExecutionResult = Awaited<ReturnType<typeof executeExtensionProgram>> & {
  variables?: ChatVariableMutation;
  conversation?: { viewHash: string };
};
type Options = {
  profile: ProfileSnapshot | undefined;
  attachment: PackageAttachment;
  assertCurrent: () => void;
  assertVariableWriteAccess?: () => void;
  modelServices?: PackageExtensionModelServices;
  responseHost?: ExtensionHostHandler;
  conversation?: { read: () => FrozenExtensionConversation; assertReadAccess: () => void };
  waitForSlot?: boolean;
  hostWaitMs?: number;
  /** Raised only for host-owned edit hooks, whose result is one bounded text. */
  maxResultChars?: number;
  /** Preserve completed computation only; authorization and state adoption have not finished. */
  onExecuted?: (result: ExecutionResult) => void;
};

/** Phase owners retain deadlines, progress, cancellation, and transactional state adoption. */
export async function executePackageExtensionProgram(
  program: ExtensionProgram,
  input: { state: RuntimeValue; input: RuntimeValue },
  signal: AbortSignal | undefined,
  options: Options
): Promise<ExecutionResult> {
  const usesModel = program.capabilities?.includes('model.generate') === true;
  const services = usesModel ? options.modelServices : undefined;
  const variables = program.capabilities?.some((capability) => capability.startsWith('variables.'))
    ? createExtensionVariableSession(
        program,
        options.profile,
        options.attachment,
        options.assertCurrent,
        options.assertVariableWriteAccess
      )
    : undefined;
  let materialGeneration = variables?.generation ?? 0;
  let materials = createPackageExtensionHost(
    program,
    options.profile,
    options.attachment,
    options.assertCurrent
  );
  let modelResultRead = false;
  let conversationRead = false;
  let conversation: { host: ExtensionHostHandler; viewHash: string } | undefined;
  const computed = await executeExtensionProgram(program, input, signal, {
    waitForSlot: options.waitForSlot,
    ...(options.maxResultChars === undefined ? {} : { maxResultChars: options.maxResultChars }),
    hostWaitMs: options.hostWaitMs ?? services?.hostWaitMs,
    // A model-capable guest must wait for paid Host work to settle even when it is cancelled.
    awaitHostSettlement: usesModel,
    host: async (method, args, hostSignal) => {
      if (conversationRead) options.conversation!.assertReadAccess();
      if (method.startsWith('conversation.')) {
        if (!program.capabilities?.includes('conversation.read'))
          throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_DENIED');
        if (!options.conversation)
          throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE');
        if (!conversation) {
          options.conversation.assertReadAccess();
          const view = options.conversation.read();
          conversation = {
            host: createConversationExtensionHost(
              program,
              view,
              options.conversation.assertReadAccess,
              options.assertCurrent
            ),
            viewHash: extensionConversationViewHash(view),
          };
        }
        const result = await conversation.host(method, args, hostSignal);
        conversationRead = true;
        return result;
      }
      if (method.startsWith('variables.')) {
        if (!variables) throw new ExtensionProgramError('BEHAVIOR_HOST_VARIABLES_DENIED');
        return variables.host(method, args, hostSignal);
      }
      if (method === 'model.generate') {
        if (!services) throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_DENIED');
        options.assertCurrent();
        const value = await services.modelGenerate(args, hostSignal);
        modelResultRead = true;
        return value;
      }
      if (variables && materialGeneration !== variables.generation) {
        materials = createPackageExtensionHost(
          program,
          variables.profile(),
          options.attachment,
          options.assertCurrent
        );
        materialGeneration = variables.generation;
      }
      return method.startsWith('response.') && options.responseHost
        ? options.responseHost(method, args, hostSignal)
        : materials(method, args, hostSignal);
    },
  });
  const mutation = variables?.receipt();
  const result: ExecutionResult = {
    ...computed,
    ...(mutation ? { variables: mutation } : {}),
    ...(conversationRead ? { conversation: { viewHash: conversation!.viewHash } } : {}),
  };
  options.onExecuted?.(result);
  if (conversationRead) options.conversation!.assertReadAccess();
  variables?.assertWriteAccess();
  // A caught denied/unavailable call may still produce a valid local fallback state.
  if (modelResultRead) await services!.assertModelAccess();
  return result;
}
