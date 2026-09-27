import type { Json } from './transport.js';
import { IllustrationError } from './illustration-errors.js';

export type ComfyWorkflowNode = {
  class_type: string;
  inputs: Record<string, Json>;
  [key: string]: Json;
};
export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;
export const COMFY_PLACEHOLDERS = {
  prompt: '{{prompt}}',
  negative: '{{negative}}',
  seed: '{{seed}}',
} as const;
const isRecord = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parseComfyWorkflow(text: string): ComfyWorkflow {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    throw new IllustrationError('COMFYUI_WORKFLOW_INVALID');
  }
  if (!isRecord(value) || !Object.keys(value).length)
    throw new IllustrationError('COMFYUI_WORKFLOW_INVALID');
  // The UI-format export ({nodes:[],links:[]}) cannot be queued through /prompt.
  if (Array.isArray(value.nodes) || Array.isArray(value.links))
    throw new IllustrationError('COMFYUI_WORKFLOW_UI_FORMAT');
  for (const node of Object.values(value)) {
    if (!isRecord(node) || typeof node.class_type !== 'string' || !isRecord(node.inputs))
      throw new IllustrationError('COMFYUI_WORKFLOW_INVALID');
  }
  const serialized = JSON.stringify(value);
  if (!serialized.includes(COMFY_PLACEHOLDERS.prompt))
    throw new IllustrationError('COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING');
  return structuredClone(value) as ComfyWorkflow;
}
/** Replaces placeholders inside string inputs only; node ids, class types and links stay intact. */
export function fillComfyWorkflow(
  workflow: ComfyWorkflow,
  values: { prompt: string; negativePrompt: string; seed: number }
): ComfyWorkflow {
  if (!Number.isSafeInteger(values.seed) || values.seed < 0)
    throw new IllustrationError('COMFYUI_WORKFLOW_INVALID');
  const replaceString = (input: string): Json => {
    if (input === COMFY_PLACEHOLDERS.seed) return values.seed;
    return input
      .split(COMFY_PLACEHOLDERS.prompt)
      .join(values.prompt)
      .split(COMFY_PLACEHOLDERS.negative)
      .join(values.negativePrompt)
      .split(COMFY_PLACEHOLDERS.seed)
      .join(String(values.seed));
  };
  const fill = (value: Json): Json =>
    typeof value === 'string'
      ? replaceString(value)
      : Array.isArray(value)
        ? value.map(fill)
        : isRecord(value)
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]))
          : value;
  return Object.fromEntries(
    Object.entries(structuredClone(workflow)).map(([id, node]) => [
      id,
      { ...node, inputs: fill(node.inputs) as Record<string, Json> },
    ])
  );
}
export function randomComfySeed(random: () => number = Math.random): number {
  return Math.floor(random() * 2_147_483_647);
}
