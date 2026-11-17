/** Parse first so authored braces cannot escape the surface's selector scope. */
export function scopedStoryUiCss(css: string, id: string): string {
  if (!css.trim() || typeof CSSStyleSheet === 'undefined') return '';
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const rules = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
  return `@scope ([data-story-ui-custom=${JSON.stringify(id)}]) {
    :scope[data-story-ui-custom][data-story-ui-style] { ${rules} }
  }`;
}
