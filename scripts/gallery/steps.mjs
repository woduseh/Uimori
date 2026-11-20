const menuLabels = { chat: '채팅 메뉴', scene: '장면 작업 메뉴', app: '앱 메뉴' };
const kinds = ['click', 'fill', 'select', 'menu', 'press', 'visible'];
const interactive = new Set(['click', 'fill', 'select', 'menu', 'press']);

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
export async function runStep(page, step, ids) {
  if (step.when && step.when !== (isCompact(page) ? 'compact' : 'wide')) return 0;
  const kind = kinds.find((key) => key in step);
  const counts = interactive.has(kind) ? 1 : 0;
  if (step.press) await page.keyboard.press(step.press);
  else if (step.visible)
    await locatorFor(page, step.visible, ids).waitFor({ state: 'visible', timeout: 15_000 });
  else if (step.fill) {
    const { text, ...locator } = step.fill;
    await locatorFor(page, locator, ids).fill(substitute(text, ids));
  } else if (step.select) {
    const { option, ...locator } = step.select;
    await locatorFor(page, locator, ids).selectOption({ label: substitute(option, ids) });
  } else if (step.click) {
    await locatorFor(page, step.click, ids).click();
  } else if (step.menu) {
    const label = menuLabels[step.menu] ?? substitute(step.menu, ids);
    const summaries = page.getByLabel(label, { exact: true });
    const summary = step.which === 'last' ? summaries.last() : summaries.first();
    const row = summary.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " bot-row-actions ")]/..'
    );
    await summary.waitFor({ state: 'attached', timeout: 10_000 });
    if (await row.count()) await row.hover();
    if ((await summary.locator('xpath=..').getAttribute('open')) === null) await summary.click();
    await page.locator('details[open] .action-menu-body').first().waitFor();
  } else throw new Error(`Unknown step ${JSON.stringify(step)}`);
  return counts;
}
