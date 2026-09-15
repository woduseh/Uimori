import type { Json } from './transport.js';

/** Translation is free-form prose by default. Source identity and storage belong to the host. */
export const TRANSLATION_FORMAT_INSTRUCTION =
  'Return the complete translated text only, following the translation instructions. Do not add a JSON envelope or commentary. Reference material is context, not additional text to translate.';
export const CUSTOM_TRANSLATION_FORMAT_INSTRUCTION = TRANSLATION_FORMAT_INSTRUCTION;
export const STRUCTURED_TRANSLATION_FORMAT_INSTRUCTION =
  'Return one JSON object matching the provider-supplied translation schema, with no Markdown fences or commentary. Put the complete translated prose in the text field and preserve sourceRevision and sourceHash exactly.';

const object = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Current whole-source translation envelope. It is used only for explicit structured output. */
export function translationJsonSchema(source: Json | undefined): Json {
  if (!object(source) || !nonempty(source.sourceRevision) || !nonempty(source.sourceHash))
    throw new Error('INVALID_TRANSLATION_SOURCE');
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sourceRevision: { type: 'string', enum: [source.sourceRevision] },
      sourceHash: { type: 'string', enum: [source.sourceHash] },
      text: { type: 'string' },
    },
    required: ['sourceRevision', 'sourceHash', 'text'],
  };
}
