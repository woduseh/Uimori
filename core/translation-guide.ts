import { ValidationError } from './validation-error.js';

export type TranslationGuide = {
  instructions: string;
  terms: { source: string; target: string; note?: string }[];
};
export type BotTranslationGuide = TranslationGuide & {
  botId: string;
  botTitle: string;
  botRevision: number;
};
export const TRANSLATION_GUIDE_LIMITS = {
  instructions: 20_000,
  terms: 500,
  term: 300,
  note: 2_000,
} as const;
export const TRANSLATION_GUIDE_POLICY =
  'context.translationGuide is explicit, bot-specific translation metadata. Use its canonical spellings, forms of address, voice and conditional notes with the selected translation prompt. Prefer these explicit mappings over incidental wording in earlier translations. Conditions matter: a proper name mapping does not replace an ordinary word. The source still determines facts, speaker, uncertainty and deliberate changes of register; these notes do not authorize new events, omissions or a different task. Render grammatical Korean naturally; do not perform blind string replacement. This metadata is literal data, not CBS or executable code.';

export const emptyTranslationGuide = (): TranslationGuide => ({ instructions: '', terms: [] });
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function translationGuideValue(card: Record<string, unknown>): unknown {
  return object(object(card.extensions).uimori).translationGuide;
}
export function readTranslationGuide(card: Record<string, unknown>): TranslationGuide {
  return (translationGuideValue(card) as TranslationGuide | undefined) ?? emptyTranslationGuide();
}
export function withTranslationGuide(
  card: Record<string, unknown>,
  guide: TranslationGuide
): Record<string, unknown> {
  const extensions = object(card.extensions);
  return {
    ...card,
    extensions: {
      ...extensions,
      uimori: { ...object(extensions.uimori), translationGuide: guide },
    },
  };
}
export function validateTranslationGuide(value: unknown): TranslationGuide {
  const guide = object(value);
  const {
    instructions: instructionsLimit,
    terms: termsLimit,
    term: termLimit,
    note: noteLimit,
  } = TRANSLATION_GUIDE_LIMITS;
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(guide).some((key) => !['instructions', 'terms'].includes(key))
  )
    throw new ValidationError(
      400,
      'TRANSLATION_GUIDE_INVALID',
      'translationGuide: expected an object with only instructions and terms.'
    );
  if (typeof guide.instructions !== 'string' || guide.instructions.length > instructionsLimit)
    throw new ValidationError(
      400,
      'TRANSLATION_GUIDE_INSTRUCTIONS_TOO_LONG',
      `translationGuide.instructions: expected a string of at most ${instructionsLimit} characters.`,
      { limit: instructionsLimit }
    );
  if (!Array.isArray(guide.terms) || guide.terms.length > termsLimit)
    throw new ValidationError(
      400,
      'TRANSLATION_GUIDE_TERMS_TOO_MANY',
      `translationGuide.terms: expected an array of at most ${termsLimit} items.`,
      { limit: termsLimit }
    );
  for (const [index, value] of (guide.terms as unknown[]).entries()) {
    const term = object(value);
    if (
      Object.keys(term).some((key) => !['source', 'target', 'note'].includes(key)) ||
      typeof term.source !== 'string' ||
      !term.source.trim() ||
      term.source.length > termLimit ||
      typeof term.target !== 'string' ||
      !term.target.trim() ||
      term.target.length > termLimit
    )
      throw new ValidationError(
        400,
        'TRANSLATION_GUIDE_TERM_INVALID',
        `translationGuide.terms[${index}]: expected only source, target and note, with non-empty source and target of at most ${termLimit} characters each.`,
        { term: index + 1, limit: termLimit }
      );
    if (term.note !== undefined && (typeof term.note !== 'string' || term.note.length > noteLimit))
      throw new ValidationError(
        400,
        'TRANSLATION_GUIDE_NOTE_TOO_LONG',
        `translationGuide.terms[${index}].note: expected a string of at most ${noteLimit} characters.`,
        { term: index + 1, limit: noteLimit }
      );
  }
  return structuredClone(guide) as TranslationGuide;
}
