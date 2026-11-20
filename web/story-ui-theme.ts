const scoped = (rules: string, attribute: string, id: string) =>
  `@scope ([${attribute}=${JSON.stringify(id)}]) {
    :scope[${attribute}][data-story-ui-style] { ${rules} }
  }`;

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
        if (rule.constructor.name === 'CSSNestedDeclarations')
          return clean((rule as unknown as { style: CSSStyleDeclaration }).style);
        return '';
      })
      .join('\n');
  return scoped(write(sheet.cssRules), 'data-story-ui-authored', id);
}
