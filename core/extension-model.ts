import { behaviorActionTriggers } from './package-behavior.js';
import { packageInstanceId } from './execution-context.js';
import { ExtensionProgramError } from './extension-program.js';
import { historicalPersonaExcluded } from './persona-scope.js';
import type { RunSnapshot } from './types.js';

export type ExtensionModelBinding = {
  instanceId: string;
  actionId: string;
  /** Omitted preserves the original model-triggered tool contract. */
  trigger?: 'model' | 'before-turn';
};
export type ExtensionModelAttribution = Pick<ExtensionModelBinding, 'instanceId' | 'actionId'> & {
  packageId: string;
  packageRevision: number;
  /** Only deferred automatic execution needs a marker; legacy model receipts stay unchanged. */
  trigger?: 'before-turn';
};

/** Author capability requests do not grant access to a user's model connection. */
export function extensionModelTarget(snapshot: RunSnapshot, binding: ExtensionModelBinding) {
  const trigger = binding.trigger ?? 'model';
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
    !['model', 'before-turn'].includes(trigger) ||
    !behaviorActionTriggers(action).includes(trigger) ||
    (trigger === 'before-turn' && snapshot.behaviorExecution?.deferredAutomatic !== true) ||
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
      ...(trigger === 'before-turn' ? { trigger } : {}),
    } satisfies ExtensionModelAttribution,
  };
}

/** Shared by live attempt admission and archive validation; never executes extension code. */
export function validateExtensionModelAttribution(snapshot: RunSnapshot, value: unknown) {
  const requiredKeys = ['instanceId', 'actionId', 'packageId', 'packageRevision'] as const;
  const allowedKeys = [...requiredKeys, 'trigger'] as const;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    ![requiredKeys.length, requiredKeys.length + 1].includes(Reflect.ownKeys(value).length) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowedKeys.includes(key as (typeof allowedKeys)[number])
    ) ||
    requiredKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    }) ||
    (Object.hasOwn(value, 'trigger') &&
      (() => {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'trigger');
        return (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          descriptor.value !== 'before-turn'
        );
      })())
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  const attribution = value as ExtensionModelAttribution;
  if (
    typeof attribution.instanceId !== 'string' ||
    typeof attribution.actionId !== 'string' ||
    typeof attribution.packageId !== 'string' ||
    !Number.isSafeInteger(attribution.packageRevision)
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  const resolved = extensionModelTarget(snapshot, attribution);
  if (
    allowedKeys.some(
      (key) => attribution[key as keyof ExtensionModelAttribution] !== resolved.attribution[key]
    ) ||
    Reflect.ownKeys(attribution).length !== Reflect.ownKeys(resolved.attribution).length
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  return resolved;
}
