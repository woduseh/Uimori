import { behaviorActionTriggers } from './package-behavior.js';
import { packageInstanceId } from './execution-context.js';
import { ExtensionProgramError } from './extension-program.js';
import { historicalPersonaExcluded } from './persona-scope.js';
import type { RunSnapshot } from './types.js';

export type ExtensionModelBinding = {
  instanceId: string;
  actionId: string;
  /** Omitted preserves the original model-triggered tool contract. */
  trigger?: 'model' | 'before-turn' | 'after-turn' | 'user';
};
export type ExtensionModelAttribution = Pick<ExtensionModelBinding, 'instanceId' | 'actionId'> & {
  packageId: string;
  packageRevision: number;
  /** Automatic execution needs a marker; legacy model receipts stay unchanged. */
  trigger?: 'before-turn' | 'after-turn' | 'user';
};

export type ExtensionModelSnapshot = Pick<
  RunSnapshot,
  'profile' | 'packageBehaviorUnavailable' | 'behaviorExecution'
>;
export type ExtensionUserModelBinding = Pick<ExtensionModelBinding, 'instanceId' | 'actionId'>;

/** Author capability requests do not grant access to a user's model connection. */
export function extensionModelTarget(
  snapshot: ExtensionModelSnapshot,
  binding: ExtensionModelBinding
) {
  const trigger = binding.trigger ?? 'model';
  if (
    !['model', 'before-turn', 'after-turn'].includes(trigger) ||
    snapshot.packageBehaviorUnavailable?.some((item) => item.instanceId === binding.instanceId) ||
    (trigger === 'before-turn' && snapshot.behaviorExecution?.deferredAutomatic !== true) ||
    (trigger === 'after-turn' && snapshot.behaviorExecution === undefined)
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_DENIED');
  return resolveModelTarget(snapshot.profile, binding, trigger);
}

/** User operations bind one explicit action independently of Run execution. */
export function extensionUserModelTarget(
  profile: RunSnapshot['profile'],
  binding: ExtensionUserModelBinding
) {
  return resolveModelTarget(profile, binding, 'user');
}

function resolveModelTarget(
  profile: RunSnapshot['profile'],
  binding: ExtensionUserModelBinding,
  trigger: NonNullable<ExtensionModelBinding['trigger']>
) {
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
    !behaviorActionTriggers(action).includes(trigger) ||
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
      ...(trigger !== 'model' ? { trigger } : {}),
    } satisfies ExtensionModelAttribution,
  };
}

/** Shared by live attempt admission and archive validation; never executes extension code. */
export function validateExtensionModelAttribution(
  snapshot: ExtensionModelSnapshot,
  value: unknown
) {
  const attribution = attributionShape(value, ['before-turn', 'after-turn']);
  return matchAttribution(attribution, extensionModelTarget(snapshot, attribution));
}

export function validateExtensionUserModelAttribution(
  profile: RunSnapshot['profile'],
  binding: ExtensionUserModelBinding,
  value: unknown
) {
  const attribution = attributionShape(value, ['user']);
  if (attribution.trigger !== 'user')
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  return matchAttribution(attribution, extensionUserModelTarget(profile, binding));
}

function attributionShape(value: unknown, triggers: readonly string[]): ExtensionModelAttribution {
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
          !triggers.includes(descriptor.value as string)
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
  return attribution;
}

function matchAttribution(
  attribution: ExtensionModelAttribution,
  resolved: ReturnType<typeof resolveModelTarget>
) {
  const allowedKeys = [
    'instanceId',
    'actionId',
    'packageId',
    'packageRevision',
    'trigger',
  ] as const;
  if (
    allowedKeys.some(
      (key) => attribution[key as keyof ExtensionModelAttribution] !== resolved.attribution[key]
    ) ||
    Reflect.ownKeys(attribution).length !== Reflect.ownKeys(resolved.attribution).length
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_MODEL_ATTRIBUTION');
  return resolved;
}
