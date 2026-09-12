export const QUOTE_PAIRS = [
  { id: 'double', open: '"', close: '"', label: '"큰따옴표"' },
  { id: 'curlyDouble', open: '“', close: '”', label: '“큰따옴표”' },
  { id: 'single', open: "'", close: "'", label: "'작은따옴표'" },
  { id: 'curlySingle', open: '‘', close: '’', label: '‘작은따옴표’' },
  { id: 'corner', open: '「', close: '」', label: '「낫표」' },
  { id: 'doubleCorner', open: '『', close: '』', label: '『겹낫표』' },
] as const;

export type QuotePairId = (typeof QUOTE_PAIRS)[number]['id'];
export type QuoteRole = 'dialogue' | 'thought' | 'quote' | 'off';
export type ReadabilitySettings = {
  emphasis: 'off' | 'subtle' | 'strong';
  dialogueBreaks: boolean;
  thoughtBreaks: boolean;
  lineHeight: number | null;
  paragraphSpacing: number | null;
  quoteRoles: Record<QuotePairId, QuoteRole>;
};

export const DEFAULT_READABILITY: ReadabilitySettings = {
  emphasis: 'off',
  dialogueBreaks: false,
  thoughtBreaks: false,
  lineHeight: null,
  paragraphSpacing: null,
  quoteRoles: {
    double: 'dialogue',
    curlyDouble: 'dialogue',
    single: 'thought',
    curlySingle: 'thought',
    corner: 'dialogue',
    doubleCorner: 'quote',
  },
};

export const READABILITY_STORAGE_KEY = 'uimori:readability';

/** Browser preferences never enter saved prose, source anchors or model requests. */
export function normalizeReadability(value: unknown): ReadabilitySettings {
  const input = value && typeof value === 'object' ? (value as Partial<ReadabilitySettings>) : {};
  const choice = (number: unknown, values: readonly number[]) =>
    typeof number === 'number' && values.includes(number) ? number : null;
  return {
    emphasis: input.emphasis === 'subtle' || input.emphasis === 'strong' ? input.emphasis : 'off',
    dialogueBreaks: input.dialogueBreaks === true,
    thoughtBreaks: input.thoughtBreaks === true,
    lineHeight: choice(input.lineHeight, [1.6, 1.9, 2.2]),
    paragraphSpacing: choice(input.paragraphSpacing, [0.5, 1, 1.5, 2]),
    quoteRoles: Object.fromEntries(
      QUOTE_PAIRS.map(({ id }) => {
        const role = input.quoteRoles?.[id];
        return [
          id,
          role === 'dialogue' || role === 'thought' || role === 'quote' || role === 'off'
            ? role
            : DEFAULT_READABILITY.quoteRoles[id],
        ];
      })
    ) as Record<QuotePairId, QuoteRole>,
  };
}
