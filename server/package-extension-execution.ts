import type { PackageAttachment } from '../core/content-package.js';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import type { ProfileSnapshot } from '../core/product.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import { createPackageExtensionHost } from './extension-materials.js';
import { executeExtensionProgram, type ExtensionHostHandler } from './extension-runtime.js';

export type PackageExtensionModelServices = {
  modelGenerate: (args: RuntimeValue, signal: AbortSignal) => Promise<RuntimeValue>;
  assertModelAccess: () => void | Promise<void>;
  hostWaitMs: number;
};

type ExecutionResult = Awaited<ReturnType<typeof executeExtensionProgram>>;
type Options = {
  profile: ProfileSnapshot | undefined;
  attachment: PackageAttachment;
  assertCurrent: () => void;
  modelServices?: PackageExtensionModelServices;
  responseHost?: ExtensionHostHandler;
  waitForSlot?: boolean;
  hostWaitMs?: number;
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
  const materials = createPackageExtensionHost(
    program,
    options.profile,
    options.attachment,
    options.assertCurrent
  );
  let modelResultRead = false;
  const result = await executeExtensionProgram(program, input, signal, {
    waitForSlot: options.waitForSlot,
    hostWaitMs: options.hostWaitMs ?? services?.hostWaitMs,
    // A model-capable guest must wait for paid Host work to settle even when it is cancelled.
    awaitHostSettlement: usesModel,
    host: async (method, args, hostSignal) => {
      if (method === 'model.generate') {
        if (!services) throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_DENIED');
        options.assertCurrent();
        const value = await services.modelGenerate(args, hostSignal);
        modelResultRead = true;
        return value;
      }
      return method.startsWith('response.') && options.responseHost
        ? options.responseHost(method, args, hostSignal)
        : materials(method, args, hostSignal);
    },
  });
  options.onExecuted?.(result);
  // A caught denied/unavailable call may still produce a valid local fallback state.
  if (modelResultRead) await services!.assertModelAccess();
  return result;
}
