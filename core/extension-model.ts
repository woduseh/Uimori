import { behaviorActionTriggers } from './package-behavior.js';
import { packageInstanceId } from './execution-context.js';
import { ExtensionProgramError } from './extension-program.js';
import { historicalPersonaExcluded } from './persona-scope.js';
import type { RunSnapshot } from './types.js';

export type ExtensionModelBinding = { instanceId: string; actionId: string };
export type ExtensionModelAttribution = ExtensionModelBinding & {
  packageId: string;
  packageRevision: number;
};

/** Author capability requests do not grant access to a user's model connection. */
export function extensionModelTarget(snapshot: RunSnapshot, binding: ExtensionModelBinding) {
  const profile = snapshot.profile;
  const ref = profile?.packageAttachments?.find(
    (item) => packageInstanceId(item) === binding.instanceId
  );
  const pkg =
    ref && profile?.packages?.find((item) => item.id === ref.id && item.revision === ref.revision);
  const action = pkg?.behavior?.actions.find((item) => item.id === binding.actionId);
  const grant = profile?.extensionGrants?.[binding.instanceId];
  if (
    !ref ||
    !pkg ||
    !action ||
    historicalPersonaExcluded(profile, ref.role) ||
    snapshot.packageBehaviorUnavailable?.some((item) => item.instanceId === binding.instanceId) ||
    !behaviorActionTriggers(action).includes('model') ||
    !action.program?.capabilities?.includes('model.generate') ||
    grant?.packageRevision !== ref.revision ||
    !grant.capabilities.includes('model.generate')
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_DENIED');
  const target = profile?.extensionModel;
  if (!target || target.enabled === false)
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_UNAVAILABLE');
  return {
    target,
    attribution: {
      instanceId: binding.instanceId,
      actionId: binding.actionId,
      packageId: ref.id,
      packageRevision: ref.revision,
    } satisfies ExtensionModelAttribution,
  };
}

/** Shared by live attempt admission and archive validation; never executes extension code. */
export function validateExtensionModelAttribution(snapshot: RunSnapshot, value: unknown) {
  const keys = ['instanceId', 'actionId', 'packageId', 'packageRevision'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  const attribution = value as ExtensionModelAttribution;
  if (typeof attribution.instanceId !== 'string' || typeof attribution.actionId !== 'string')
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  const resolved = extensionModelTarget(snapshot, attribution);
  if (
    keys.some(
      (key) =>
        attribution[key as keyof ExtensionModelAttribution] !==
        resolved.attribution[key as keyof ExtensionModelAttribution]
    )
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  return resolved;
}
