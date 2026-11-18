const scoped = (rules: string, attribute: string, id: string) =>
  `@scope ([${attribute}=${JSON.stringify(id)}]) {
    :scope[${attribute}][data-story-ui-style] { ${rules} }
  }`;

/** Parse first so authored braces cannot escape the surface's selector scope. */
export function scopedStoryUiCss(css: string, id: string): string {
  if (!css.trim() || typeof CSSStyleSheet === 'undefined') return '';
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const rules = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
  return scoped(rules, 'data-story-ui-custom', id);
}

const STORED_IMAGE =
  /^url\("\/api\/(?:assets|package-image-blobs|illustration-images)\/[A-Za-z0-9_-]+"\)$/;
const URL_CALL = /url\([^)]*\)/gi;
const FETCHING = /(?:image-set|src|image|element|cross-fade)\(/i;
const ANIMATION = /^(?:-webkit-)?animation(?:-name)?$/;

/**
 * CSS written by the model for one block. Unlike a theme the user saved, it is generated
 * text: it may style the block freely, but it must not reach the network, define page-wide
 * names, or outrank the host's own guards. The block element clips what it paints.
 */
export function modelStoryUiCss(css: string, id: string): string {
  if (!css.trim() || typeof CSSStyleSheet === 'undefined') return '';
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  const prefix = `story-ui-${id.replace(/[^A-Za-z0-9_-]/g, '')}-`;
  const keyframes = new Set<string>();
  const collect = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSKeyframesRule) keyframes.add(rule.name);
      else if ('cssRules' in rule) collect(rule.cssRules as CSSRuleList);
    }
  };
  collect(sheet.cssRules);
  // A stored image is the only thing a declaration may load.
  const fetches = (value: string) =>
    FETCHING.test(value) || (value.match(URL_CALL) ?? []).some((url) => !STORED_IMAGE.test(url));
  const clean = (style: CSSStyleDeclaration): string => {
    for (const name of [...style]) {
      const value = style.getPropertyValue(name);
      if (fetches(value)) style.removeProperty(name);
      else if (ANIMATION.test(name))
        style.setProperty(
          name,
          value.replace(/[A-Za-z_][\w-]*/g, (word) => (keyframes.has(word) ? prefix + word : word)),
          style.getPropertyPriority(name)
        );
    }
    // A shorthand holding var() has no readable longhands, so the block's text is checked
    // as a whole. !important is dropped so the host's own guards keep the last word.
    const text = style.cssText;
    return fetches(text) ? '' : text.replace(/\s*!\s*important/gi, '');
  };
  const write = (rules: CSSRuleList): string =>
    [...rules]
      .map((rule) => {
        if (rule instanceof CSSKeyframesRule) {
          const frames = [...rule.cssRules]
            .map((frame) => {
              const { keyText, style } = frame as CSSKeyframeRule;
              return `${keyText} { ${clean(style)} }`;
            })
            .join(' ');
          return `@keyframes ${prefix}${rule.name} { ${frames} }`;
        }
        if (rule instanceof CSSStyleRule)
          return `${rule.selectorText} { ${clean(rule.style)} ${write(rule.cssRules)} }`;
        if (
          rule instanceof CSSMediaRule ||
          rule instanceof CSSSupportsRule ||
          rule instanceof CSSContainerRule
        )
          return `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{ ${write(rule.cssRules)} }`;
        // Declarations written after a nested rule arrive as a rule of their own.
        if (rule.constructor.name === 'CSSNestedDeclarations')
          return clean((rule as unknown as { style: CSSStyleDeclaration }).style);
        // @import, @font-face, @property and the rest would act on the whole page.
        return '';
      })
      .join('\n');
  return scoped(write(sheet.cssRules), 'data-story-ui-authored', id);
}
