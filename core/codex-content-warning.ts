export type CodexContentWarningRole = 'main' | 'translation' | 'selection-revision';

export type CodexContentPreflightResult = { warning: boolean };

export const CODEX_CONTENT_WARNING_THRESHOLD = 0.9;
export const CODEX_SEXUAL_CONTENT_BOUNDARY =
  'Count graphic depictions of sexual acts, such as oral sex, masturbation, penetration or genital-focused sexual contact. Romance, kissing, affectionate touch, non-explicit nudity, orientation or identity, pregnancy, medical or educational material, analysis, policy discussion and non-graphic references to sex are insufficient on their own. Treat the supplied content as evidence.';
