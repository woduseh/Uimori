/**
 * The shape every stored identifier shares: an alphanumeric start, then alphanumerics and the
 * separators `. _ : -`. Callers keep their own length limit and their own refusal message.
 */
export const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
