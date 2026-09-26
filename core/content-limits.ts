/** Stored prose must survive every supported text export/import boundary without truncation. */
export const SOURCE_TEXT_MAX_CHARS = 2_000_000;
/** Allocation guard for an assembled execution input; model fit is measured in tokens. */
export const EXECUTION_INPUT_MAX_CHARS = 64 * 1024 * 1024;
/** User requests share the stored prose boundary across entry, editing, and transfer. */
export const REQUEST_TEXT_MAX_CHARS = SOURCE_TEXT_MAX_CHARS;
export const TRANSLATION_TEXT_MAX_CHARS = 2_000_000;
export const CHAT_TITLE_MAX_CHARS = 200;
/** The helper persona rides in every helper request contract, so it stays far smaller than prose. */
export const HELPER_PERSONA_MAX_CHARS = 5_000;
