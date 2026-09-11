/** Stored prose must survive every supported text export/import boundary without truncation. */
export const SOURCE_TEXT_MAX_CHARS = 2_000_000;
export const TRANSLATION_TEXT_MAX_CHARS = 2_000_000;
export const CHAT_TITLE_MAX_CHARS = 200;
/** The helper persona rides in every helper request contract, so it stays far smaller than prose. */
export const HELPER_PERSONA_MAX_CHARS = 5_000;
