import type { Page } from '@playwright/test';

/** Every numeric target below is the one written in this section; change them there first. */
export const metricSource = 'docs/UI-PRINCIPLES-AI-PRODUCTS.md#4-적용-순서-제안';

export const metricNames = [
  'header-controls',
  'composer-dock',
  'body-share',
  'menu-in-viewport',
  'overflow',
  'touch-44',
  'min-font',
] as const;
export type MetricName = (typeof metricNames)[number];
export type InventoryName = 'font-size-values' | 'border-radius-values';
export type MetricResult = {
  metric: MetricName | InventoryName;
  value: number | boolean | null;
  target: string;
  /** `null` means recorded at this width but not scored there. */
  pass: boolean | null;
  detail?: unknown;
};

/** Mirrors `useCompactLayout` so a spec and the gallery agree on which targets apply. */
export const isCompactWidth = (width: number) => width <= 760;

// Runs inside the page, so it must not reference anything outside its own body.
function measureInPage({ names, compact }: { names: readonly string[]; compact: boolean }) {
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      (element as HTMLElement).checkVisibility({ checkVisibilityCSS: true })
    );
  };
  const label = (element: Element) =>
    (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40);
  const results: MetricResult[] = [];
  for (const name of names) {
    if (name === 'header-controls') {
      const header = document.querySelector('header.workspace-header');
      const controls = header
        ? [...header.querySelectorAll('button, [role=button], summary')].filter(visible)
        : [];
      results.push({
        metric: name,
        value: controls.length,
        target: '좁은 화면 헤더 제어 4개 이하',
        pass: header ? (compact ? controls.length <= 4 : null) : false,
        detail: controls.map(label),
      });
    } else if (name === 'composer-dock') {
      const dock = document.querySelector('.composer-dock');
      const height = dock ? Math.round(dock.getBoundingClientRect().height) : null;
      const target = compact ? 52 : 56;
      results.push({
        metric: name,
        value: height,
        target: `빈 입력창 ${target}px 이하`,
        pass: height === null ? false : height <= target,
      });
    } else if (name === 'body-share') {
      const body = document.querySelector('[data-testid=source-text]');
      let share = 0;
      if (body) {
        const box = body.getBoundingClientRect();
        share = Math.max(0, Math.min(innerHeight, box.bottom) - Math.max(0, box.top)) / innerHeight;
      }
      results.push({
        metric: name,
        value: Math.round(share * 100) / 100,
        target: '좁은 화면 첫 화면 본문 60% 이상',
        pass: body ? (compact ? share >= 0.6 : null) : false,
      });
    } else if (name === 'menu-in-viewport') {
      const bodies = [...document.querySelectorAll('details[open] .action-menu-body')].filter(
        visible
      );
      const outside: { label: string; top: number; bottom: number }[] = [];
      for (const body of bodies)
        for (const item of [body, ...body.querySelectorAll('button, [role=menuitem], a[href]')]) {
          if (!visible(item)) continue;
          const box = item.getBoundingClientRect();
          if (box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth)
            outside.push({
              label: label(item),
              top: Math.round(box.top),
              bottom: Math.round(box.bottom),
            });
        }
      results.push({
        metric: name,
        value: bodies.length ? outside.length === 0 : null,
        target: '열린 메뉴와 모든 항목이 뷰포트 안',
        pass: bodies.length ? outside.length === 0 : false,
        detail: outside,
      });
    } else if (name === 'overflow') {
      const value = document.documentElement.scrollWidth - innerWidth;
      results.push({ metric: name, value, target: '가로 넘침 1px 이하', pass: value <= 1 });
    } else if (name === 'touch-44') {
      const small = [
        ...document.querySelectorAll(
          'button, [role=button], summary, input[type=checkbox], input[type=radio]'
        ),
      ]
        .filter((element) => visible(element) && !element.closest('[data-testid=source-text]'))
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width < 44 || box.height < 44)
        .map(({ element, box }) => ({
          label: label(element),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }));
      results.push({
        metric: name,
        value: small.length,
        target: '좁은 화면에서 44px 미만 제어 0개',
        pass: compact ? small.length === 0 : null,
        detail: small.slice(0, 40),
      });
    } else if (name === 'min-font') {
      const small: { label: string; size: number }[] = [];
      for (const element of document.body.querySelectorAll('*')) {
        if (!visible(element)) continue;
        const hasText = [...element.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
        );
        if (!hasText) continue;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (size < 12) small.push({ label: label(element), size: Math.round(size * 10) / 10 });
      }
      results.push({
        metric: name,
        value: small.length,
        target: '11px 이하 글자 0곳 (캡션 12px)',
        pass: small.length === 0,
        detail: small.slice(0, 40),
      });
    }
  }
  return results;
}

// Also runs inside the page.
function inventoryInPage() {
  const fontSizes = new Set<string>();
  const radii = new Set<string>();
  const ignored = new Set(['', 'inherit', 'initial', 'unset', 'revert']);
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const size = rule.style.getPropertyValue('font-size').trim();
        if (!ignored.has(size)) fontSizes.add(size);
        const radius = rule.style.getPropertyValue('border-radius').trim();
        if (!ignored.has(radius)) radii.add(radius);
      } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      /* cross-origin sheet; the app ships none */
    }
  }
  // Radius "kinds" count scalar lengths only: composite values split into components, and the
  // three shapes (square 0, circle 50%, pill >= 999px) are listed separately.
  const scalars = new Set<string>();
  const shapes = new Set<string>();
  for (const declared of radii)
    for (const part of declared.split(/\s+/u)) {
      if (part === '/' || part === '') continue;
      if (/^0(?:px|rem|em|%)?$/u.test(part)) shapes.add('square');
      else if (/^50%$/u.test(part)) shapes.add('circle');
      else if (/^\d+px$/u.test(part) && Number.parseInt(part, 10) >= 999) shapes.add('pill');
      else scalars.add(part);
    }
  const results: MetricResult[] = [
    {
      metric: 'font-size-values',
      value: fontSizes.size,
      target: 'font-size 선언값 8종 이하',
      pass: fontSizes.size <= 8,
      detail: [...fontSizes].sort(),
    },
    {
      metric: 'border-radius-values',
      value: scalars.size,
      target: 'border-radius 길이 값 3종 이하 (모양 0·50%·알약 제외)',
      pass: scalars.size <= 3,
      detail: { scalars: [...scalars].sort(), shapes: [...shapes].sort(), raw: [...radii].sort() },
    },
  ];
  return results;
}

/** Measures the current screen. `compact` defaults to the page's viewport width. */
export async function measureScreen(
  page: Page,
  names: readonly MetricName[],
  options: { compact?: boolean } = {}
): Promise<MetricResult[]> {
  const compact = options.compact ?? isCompactWidth(page.viewportSize()?.width ?? 1440);
  return page.evaluate(measureInPage, { names, compact });
}

/** Counts declared `font-size` and `border-radius` values across the loaded stylesheets. */
export async function styleInventory(page: Page): Promise<MetricResult[]> {
  return page.evaluate(inventoryInPage);
}
