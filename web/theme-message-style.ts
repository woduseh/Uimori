const sheets = new WeakMap<Document, CSSStyleSheet>();
/** Every mounted message shares this sheet. Updating a theme never replaces message HTML. */
export function themeMessageSheet(document: Document): CSSStyleSheet {
  let sheet = sheets.get(document);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheets.set(document, sheet);
  }
  return sheet;
}
export function updateMessageTheme(document: Document, css: string) {
  // Author-owned unlayered rules and explicit reading preferences take precedence.
  themeMessageSheet(document).replaceSync(css ? `@layer uimori-message-theme { ${css}\n }` : '');
}
