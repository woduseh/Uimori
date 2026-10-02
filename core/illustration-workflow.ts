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

/** Validation and substitution must inspect the same input values, never keys or metadata. */
function mapInputStrings(value: Json, visit: (input: string) => Json): Json {
  return typeof value === 'string'
    ? visit(value)
    : Array.isArray(value)
      ? value.map((item) => mapInputStrings(item, visit))
      : isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, mapInputStrings(item, visit)])
          )
        : value;
}

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
  let hasPrompt = false;
  for (const node of Object.values(value) as ComfyWorkflowNode[])
    mapInputStrings(node.inputs, (input) => {
      hasPrompt ||= input.includes(COMFY_PLACEHOLDERS.prompt);
      return input;
    });
  if (!hasPrompt) throw new IllustrationError('COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING');
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
  return Object.fromEntries(
    Object.entries(structuredClone(workflow)).map(([id, node]) => [
      id,
      { ...node, inputs: mapInputStrings(node.inputs, replaceString) as Record<string, Json> },
    ])
  );
}
export function randomComfySeed(random: () => number = Math.random): number {
  return Math.floor(random() * 2_147_483_647);
}
