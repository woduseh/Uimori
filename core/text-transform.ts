/** Pure text replacement data shared by prompt and package adapters. */
export type TextTransformRule = {
  id: string;
  pattern: string;
  flags: string;
  replacement: string;
};
export type TextTransformResult = { text: string; applied: string[]; changed: boolean };
export class TextTransformError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    readonly itemId?: string
  ) {
    super(code);
    this.name = 'TextTransformError';
  }
}
/** Do not compile user patterns on the main thread. */
export function validateTextTransformRule(value: TextTransformRule): TextTransformRule {
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(value.id))
    throw new TextTransformError('TEXT_INVALID_ID');
  if (
    typeof value.pattern !== 'string' ||
    value.pattern.length > 4096 ||
    typeof value.flags !== 'string' ||
    value.flags.length > 8 ||
    typeof value.replacement !== 'string' ||
    value.replacement.length > 16_384
  )
    throw new TextTransformError('TEXT_INVALID_STRING', value.id);
  if (
    !value.pattern ||
    !/^[gimsuy]*$/u.test(value.flags) ||
    new Set(value.flags).size !== value.flags.length
  )
    throw new TextTransformError('TEXT_REGEX_FLAGS', value.id);
  return {
    id: value.id,
    pattern: value.pattern,
    flags: value.flags,
    replacement: value.replacement,
  };
}
