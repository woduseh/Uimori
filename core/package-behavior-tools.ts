import { ContentPackageError, validateContentPackage } from './content-package.js';
import { BehaviorError, type BehaviorSchema } from './package-behavior.js';
import { packageInstanceId } from './execution-context.js';
import type { Json, ProviderTool } from './transport.js';
import type { RunSnapshot } from './types.js';

export type BehaviorToolBinding = { tool: ProviderTool; instanceId: string; actionId: string };
export const MAX_MODEL_BEHAVIOR_ACTIONS = 20;

/** Deterministic identity only, not an authorization token. Browser and server use the same name. */
function toolName(instanceId: string, actionId: string): string {
  const text = JSON.stringify([instanceId, actionId]);
  let first = 0x811c9dc5,
    second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    first = Math.imul(first ^ text.charCodeAt(i), 0x01000193);
    second = Math.imul(second ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return `behavior_${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** Schema constraints are advisory to the provider; the host validates every actual input again. */
export function behaviorInputJsonSchema(schema: BehaviorSchema): Json {
  const label = {
    ...(schema.label ? { title: schema.label } : {}),
    ...(schema.description ? { description: schema.description } : {}),
  };
  switch (schema.type) {
    case 'number':
      return {
        ...label,
        type: schema.integer ? 'integer' : 'number',
        minimum: schema.min,
        maximum: schema.max,
      };
    case 'string':
      return { ...label, type: 'string', maxLength: schema.maxLength };
    case 'boolean':
      return { ...label, type: 'boolean' };
    case 'enum': {
      const types = [...new Set(schema.values.map((value) => typeof value))];
      return {
        ...label,
        ...(types.length === 1 ? { type: types[0] } : {}),
        enum: [...schema.values],
      };
    }
    case 'list':
      return {
        ...label,
        type: 'array',
        items: behaviorInputJsonSchema(schema.items),
        maxItems: schema.maxItems,
      };
    case 'record':
      return {
        ...label,
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([key, child]) => [
            key,
            behaviorInputJsonSchema(child),
          ])
        ),
        required: Object.keys(schema.properties),
        additionalProperties: false,
      };
  }
}

/** Frozen main attachments alone grant action tools. Read tools and auxiliary roles grant no such permission. */
export function listBehaviorTools(snapshot: RunSnapshot): BehaviorToolBinding[] {
  const profile = snapshot.profile,
    bindings: BehaviorToolBinding[] = [],
    names = new Set<string>();
  for (const ref of profile?.packageAttachments ?? []) {
    const pkg = profile?.packages?.find(
      (item) => item.id === ref.id && item.revision === ref.revision
    );
    if (!pkg) throw new ContentPackageError('PACKAGE_SNAPSHOT_REVISION_MISSING', ref.id);
    validateContentPackage(pkg);
    if (ref.role === 'persona' && profile?.personaReference === false) continue;
    for (const action of pkg.behavior?.actions ?? []) {
      if (!action.triggers?.includes('model')) continue;
      if (action.inputSchema.type !== 'record')
        throw new BehaviorError(400, 'BEHAVIOR_MODEL_INPUT_ROOT');
      const instanceId = packageInstanceId(ref),
        name = toolName(instanceId, action.id);
      if (names.has(name)) throw new BehaviorError(400, 'BEHAVIOR_TOOL_NAME_COLLISION');
      names.add(name);
      bindings.push({
        instanceId,
        actionId: action.id,
        tool: {
          name,
          description: `${pkg.title}: ${(action.label ?? action.id).slice(0, 200)}. ${action.description ?? 'Resolve the configured story action.'} The host validates eligibility and records the outcome. One opportunity per action in this run; repeated requests reuse its outcome.`,
          inputSchema: behaviorInputJsonSchema(action.inputSchema),
        },
      });
      if (bindings.length > MAX_MODEL_BEHAVIOR_ACTIONS)
        throw new BehaviorError(400, 'BEHAVIOR_MODEL_ACTION_LIMIT');
    }
  }
  return bindings;
}

/** Known unsupported routes fail before any provider attempt; unknown capabilities stay unknown. */
export function assertBehaviorToolCapability(
  snapshot: RunSnapshot,
  bindings = listBehaviorTools(snapshot)
): void {
  if (!bindings.length) return;
  const target = snapshot.profile?.models.main;
  if (
    target &&
    (target.userOverrides?.tools === false ||
      target.connection.catalog.find((model) => model.id === target.modelId)?.capabilities.tools ===
        false)
  ) {
    throw new BehaviorError(400, 'BEHAVIOR_MODEL_TOOLS_UNSUPPORTED');
  }
}
