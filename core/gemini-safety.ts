/** Gemini generateContent API's configurable content-category thresholds. */
export const GEMINI_SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_JAILBREAK',
] as const;
export const GEMINI_SAFETY_THRESHOLDS = [
  'OFF',
  'BLOCK_NONE',
  'BLOCK_ONLY_HIGH',
  'BLOCK_MEDIUM_AND_ABOVE',
  'BLOCK_LOW_AND_ABOVE',
] as const;
export type GeminiSafetyCategory = (typeof GEMINI_SAFETY_CATEGORIES)[number];
export type GeminiSafetyThreshold = (typeof GEMINI_SAFETY_THRESHOLDS)[number];
/** Omitted categories use the provider default. */
export type GeminiSafetySettings = Partial<Record<GeminiSafetyCategory, GeminiSafetyThreshold>>;
