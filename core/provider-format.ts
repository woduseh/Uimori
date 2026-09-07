import type { Json } from './transport.js';

export const TRANSLATION_FORMAT_INSTRUCTION = 'The final translation must be one JSON object matching the specified schema, with no Markdown fences or commentary. In segments.text, copy each supplied [[p_...]] protected token exactly once in source order, leaving its spelling unchanged. Outside those tokens, do not introduce digits, code fences, inline code, machine identifiers, enum codes, asset/resource references or JSON-like syntax. Express quantities written as words in the source using Korean number words (for example, "forty years" becomes "사십 년"); do not convert them to Arabic numerals. Preserve the exact sourceRevision, sourceHash, chunkId and anchors in their JSON fields; this prose-only restriction does not change those identifiers or the JSON syntax.';


/** Structural host requirements only; editable prompts own language and writing choices. */
export const CUSTOM_TRANSLATION_FORMAT_INSTRUCTION = 'Return one JSON object matching the specified schema, with no Markdown fences or commentary. Preserve the exact sourceRevision, sourceHash, chunkId and anchors in their JSON fields. Include every requested anchor exactly once in order; adjacent anchors may share one segment. In segments.text, copy each supplied [[p_...]] protected token exactly once in source order without changing its spelling. Outside those tokens, do not introduce digits, code fences, inline code, machine identifiers, enum codes, asset/resource references or JSON-like syntax; the host rejects unprotected machine syntax. This restriction does not change identifiers or JSON syntax in their specified fields.';

/** Shared JSON Schema; provider encoders decide whether the selected model accepts structured output. */
export function translationJsonSchema(source: Json | undefined): Json {
  if (!source || typeof source !== 'object' || Array.isArray(source) || ['sourceRevision', 'sourceHash', 'chunkId'].some(key => typeof source[key] !== 'string' || !source[key])) throw new Error('INVALID_TRANSLATION_SOURCE');
  return { type: 'object', additionalProperties: false,
    properties: { sourceRevision: { type: 'string', enum: [source.sourceRevision] }, sourceHash: { type: 'string', enum: [source.sourceHash] }, chunkId: { type: 'string', enum: [source.chunkId] },
      segments: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
        properties: { anchors: { type: 'array', minItems: 1, items: { type: 'string' } }, text: { type: 'string' } }, required: ['anchors', 'text'] } } },
    required: ['sourceRevision', 'sourceHash', 'chunkId', 'segments'] };
}