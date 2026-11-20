const sheets = new WeakMap<Document, CSSStyleSheet>();
export function themeMessageSheet(document: Document): CSSStyleSheet {
  let sheet = sheets.get(document);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheets.set(document, sheet);
  }
  return sheet;
}
export function updateMessageTheme(document: Document, css: string) {
  themeMessageSheet(document).replaceSync(css ? `@layer uimori-message-theme { ${css}\n }` : '');
}
