import { TextTransformError } from '../core/text-transform.js';
import { applyTextTransforms } from './text-transforms.js';

export type RegexRule = { pattern: string; flags: string; replacement: string };
export const PRESENTATION_LIMITS = Object.freeze({
  input: 65_536,
  output: 65_536,
  pattern: 512,
  replacement: 2_048,
  rules: 8,
  timeoutMs: 500,
  concurrent: 4,
});
export type PresentationResult =
  | { ok: true; text: string }
  | { ok: false; text: string; error: string };
let active = 0;

/** Plain text only. Replacement is literal (including $1); source storage is never accessed.
 * Worker isolation limits regex CPU stalls; it is not a security sandbox. */
export async function presentText(source: string, rules: unknown): Promise<PresentationResult> {
  const fail = (error: string): PresentationResult => ({
    ok: false,
    text: typeof source === 'string' ? source : '',
    error,
  });
  if (typeof source !== 'string' || source.length > PRESENTATION_LIMITS.input)
    return fail('INPUT_LIMIT');
  if (!Array.isArray(rules) || rules.length > PRESENTATION_LIMITS.rules) return fail('RULE_LIMIT');
  const safe: RegexRule[] = [];
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.pattern !== 'string' ||
      typeof rule.flags !== 'string' ||
      typeof rule.replacement !== 'string'
    )
      return fail('INVALID_RULE');
    if (
      !rule.pattern.length ||
      rule.pattern.length > PRESENTATION_LIMITS.pattern ||
      rule.replacement.length > PRESENTATION_LIMITS.replacement
    )
      return fail('RULE_SIZE_LIMIT');
    if (!/^[gimsu]*$/.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length)
      return fail('INVALID_FLAGS');
    safe.push({ pattern: rule.pattern, flags: rule.flags, replacement: rule.replacement });
  }
  if (!safe.length) return { ok: true, text: source };
  if (active >= PRESENTATION_LIMITS.concurrent) return fail('PRESENTATION_BUSY');
  active++;
  try {
    const result = await applyTextTransforms(
      source,
      safe.map((rule, index) => ({
        ...rule,
        id: `presentation-${index}`,
        // The legacy presentation API treats every dollar token literally.
        replacement: rule.replacement.replaceAll('$', '$$$$'),
      })),
      { timeoutMs: PRESENTATION_LIMITS.timeoutMs, maxOutputChars: PRESENTATION_LIMITS.output }
    );
    return { ok: true, text: result.text };
  } catch (error) {
    if (error instanceof TextTransformError) {
      if (error.code === 'TEXT_TRANSFORM_TIMEOUT') return fail('REGEX_TIMEOUT');
      if (error.code === 'TEXT_TRANSFORM_OUTPUT_LIMIT') return fail('OUTPUT_LIMIT');
      if (error.code === 'TEXT_REGEX_INVALID') return fail('INVALID_PATTERN');
      if (error.code === 'TEXT_TRANSFORM_WORKER_EXIT') return fail('REGEX_WORKER_EXIT');
    }
    return fail('REGEX_WORKER_ERROR');
  } finally {
    active--;
  }
}
