// Locators and steps shared by the screen gallery and the journey capture.
//
//   { click: { label | role+name | testid | text | css, nth?, within? } }
//   { fill: { <locator>, text } }
//   { menu: 'chat' | 'scene' | 'app' | '<aria-label>', which?: 'first' | 'last' }   opens an ActionMenu
//   { visible: <locator> }   waits for the element
//   { press: 'Escape' }   { wait: 300 }
//
// Any step may carry `when: 'compact' | 'wide'` to run only at one width (760px like
// `useCompactLayout`). `$name` in names, labels and texts is replaced from the seed ids.

const menuLabels = { chat: '채팅 메뉴', scene: '장면 작업 메뉴', app: '앱 메뉴' };
const kinds = ['click', 'fill', 'menu', 'press', 'visible', 'wait'];
/** Steps that count as a user interaction when a journey is measured. */
const interactive = new Set(['click', 'fill', 'menu', 'press']);

function substitute(value, ids) {
  return String(value).replaceAll(/\$([a-z]+(?:\.[a-z]+)*)/gu, (_, key) => {
    if (!(key in ids)) throw new Error(`Seed value missing: ${key}`);
    return ids[key];
  });
}
export function resolveUrl(baseUrl, params, ids) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, substitute(value, ids));
  return url.toString();
}
export function locatorFor(page, spec, ids) {
  const scope = spec.within ? locatorFor(page, spec.within, ids) : page;
  const name = spec.name === undefined ? undefined : substitute(spec.name, ids);
  let locator;
  if (spec.testid) locator = scope.getByTestId(spec.testid);
  else if (spec.label) locator = scope.getByLabel(spec.label, { exact: spec.exact ?? true });
  else if (spec.role) locator = scope.getByRole(spec.role, { name, exact: spec.exact ?? true });
  else if (spec.text) locator = scope.getByText(spec.text, { exact: spec.exact ?? false });
  else if (spec.css) locator = scope.locator(spec.css);
  else throw new Error(`Unknown locator ${JSON.stringify(spec)}`);
  if (spec.nth === 'last') return locator.last();
  return locator.nth(typeof spec.nth === 'number' ? spec.nth : 0);
}
function isCompact(page) {
  return (page.viewportSize()?.width ?? 0) <= 760;
}
/** Runs one step; returns 1 when it counts as a user interaction, otherwise 0. */
export async function runStep(page, step, ids) {
  if (step.when && step.when !== (isCompact(page) ? 'compact' : 'wide')) return 0;
  const kind = kinds.find((key) => key in step);
  const counts = interactive.has(kind) ? 1 : 0;
  if (kind === 'wait') await page.waitForTimeout(step.wait);
  else if (step.press) await page.keyboard.press(step.press);
  else if (step.visible)
    await locatorFor(page, step.visible, ids).waitFor({ state: 'visible', timeout: 15_000 });
  else if (step.fill) {
    // `text` is the value to type here, never the getByText locator.
    const { text, ...locator } = step.fill;
    await locatorFor(page, locator, ids).fill(substitute(text, ids));
  } else if (step.click) {
    const target = locatorFor(page, step.click, ids);
    await target.scrollIntoViewIfNeeded();
    await target.click();
  } else if (step.menu) {
    const label = menuLabels[step.menu] ?? substitute(step.menu, ids);
    const summary = page.getByLabel(label, { exact: true });
    const target = step.which === 'last' ? summary.last() : summary.first();
    // Sidebar rows reveal their ⋯ on hover and re-render while the chat loads, so a resolved
    // element can detach between two calls; a detach is retried from the lookup, twice at most.
    for (let attempt = 0; ; attempt++) {
      try {
        await target.waitFor({ state: 'attached', timeout: 10_000 });
        await target.scrollIntoViewIfNeeded();
        // Row actions sit under `pointer-events: none` until the row is hovered, so move the mouse
        // there without the actionability wait; the hover itself reveals them.
        await target.hover({ force: true });
        if (!(await target.evaluate((node) => node.closest('details')?.open))) await target.click();
        break;
      } catch (error) {
        if (attempt >= 2 || !/not attached|detached/iu.test(error.message)) throw error;
      }
    }
    await page.locator('details[open] .action-menu-body').first().waitFor();
  } else throw new Error(`Unknown step ${JSON.stringify(step)}`);
  return counts;
}
