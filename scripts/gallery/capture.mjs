import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { measureScreen, styleInventory, metricSource } from '../../tests/fixtures/ui-metrics.ts';
import { defaultMetrics, screens as allScreens, themes, viewports } from './screens.mjs';

const menuLabels = { chat: '채팅 메뉴', scene: '장면 작업 메뉴', app: '앱 메뉴' };

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
function locatorFor(page, spec, ids) {
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
async function runStep(page, step, ids) {
  if (step.wait) return page.waitForTimeout(step.wait);
  if (step.press) return page.keyboard.press(step.press);
  if (step.click) {
    const target = locatorFor(page, step.click, ids);
    await target.scrollIntoViewIfNeeded();
    return target.click();
  }
  if (step.menu) {
    const label = menuLabels[step.menu];
    if (!label) throw new Error(`Unknown menu ${step.menu}`);
    const summary = page.getByLabel(label, { exact: true });
    const target = step.which === 'last' ? summary.last() : summary.first();
    await target.scrollIntoViewIfNeeded();
    if (!(await target.evaluate((node) => node.closest('details')?.open))) await target.click();
    return page.locator('details[open] .action-menu-body').first().waitFor();
  }
  throw new Error(`Unknown step ${JSON.stringify(step)}`);
}

const html = (value) =>
  String(value).replaceAll(
    /[&<>"]/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );

function contactSheet({ captures, metrics, screens, generatedAt }) {
  const columns = Object.keys(viewports).flatMap((vp) => themes.map((theme) => ({ vp, theme })));
  const rows = screens
    .map((screen) => {
      const cells = columns
        .map(({ vp, theme }) => {
          const shot = captures.find(
            (c) => c.screen === screen.id && c.viewport === vp && c.theme === theme
          );
          const scored = metrics.filter(
            (m) => m.screen === screen.id && m.viewport === vp && m.theme === theme
          );
          const badges = scored
            .map((m) => {
              const state = m.pass === null ? 'note' : m.pass ? 'pass' : 'fail';
              const value =
                typeof m.value === 'number' ? m.value : m.value === null ? '–' : m.value;
              return `<span class="badge ${state}" title="${html(m.target)}">${html(m.metric)} ${html(value)}</span>`;
            })
            .join('');
          if (!shot) return `<td class="missing">${html(`${vp} ${theme}`)} 없음</td>`;
          return `<td><a href="${html(shot.file)}"><img loading="lazy" src="${html(shot.file)}" alt="${html(`${screen.title} ${vp} ${theme}`)}"></a><div class="badges">${badges}</div></td>`;
        })
        .join('');
      return `<tr><th scope="row"><div>${html(screen.title)}</div><code>${html(screen.id)}</code><small>${html((screen.principles ?? []).join(' · '))}</small></th>${cells}</tr>`;
    })
    .join('\n');
  const head = columns
    .map((c) => `<th>${html(`${c.vp} ${viewports[c.vp].width}px · ${c.theme}`)}</th>`)
    .join('');
  const inventory = metrics
    .filter((m) => m.screen === '*')
    .map(
      (m) =>
        `<li><strong>${html(m.metric)}</strong> ${html(m.value)} (${html(m.target)}) ${m.pass ? '충족' : '미충족'}</li>`
    )
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Uimori 화면 갤러리</title>
<style>
body{font:14px system-ui,sans-serif;margin:16px;background:#f4f4f2;color:#222}
table{border-collapse:collapse}th,td{vertical-align:top;padding:8px;border-bottom:1px solid #ddd;text-align:left}
th[scope=row]{width:180px}th code{display:block;color:#666;font-size:12px}th small{color:#888}
td img{display:block;max-width:260px;height:auto;border:1px solid #ccc;background:#fff}
.badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;max-width:260px}
.badge{font-size:11px;padding:1px 6px;border-radius:10px;background:#e5e5e5}
.badge.pass{background:#d9efd9}.badge.fail{background:#f5d0d0}.badge.note{background:#e8e8f4}
td.missing{color:#a33}
</style></head><body>
<h1>Uimori 화면 갤러리</h1>
<p>${html(generatedAt)} · 수치 출처: <code>${html(metricSource)}</code> · 원본 수치는 <a href="metrics.json">metrics.json</a>. 배지 색은 기록이며 판정은 사람이 해요.</p>
<ul>${inventory}</ul>
<table><thead><tr><th>화면</th>${head}</tr></thead><tbody>
${rows}
</tbody></table></body></html>
`;
}

export function summarizeRubric(metrics) {
  const scored = metrics.filter((m) => m.pass !== null);
  return {
    recorded: metrics.length,
    scored: scored.length,
    met: scored.filter((m) => m.pass).length,
    unmet: scored.filter((m) => !m.pass).length,
    unscored: metrics.length - scored.length,
    unmetBy: scored
      .filter((m) => !m.pass)
      .reduce((acc, m) => {
        (acc[m.metric] ??= []).push(`${m.screen} ${m.viewport} ${m.theme}`);
        return acc;
      }, {}),
  };
}

export async function captureGallery({
  baseUrl,
  executablePath,
  ids,
  directory,
  screens = allScreens,
  log = () => {},
}) {
  const shots = path.join(directory, 'screens');
  await mkdir(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath, args: ['--no-proxy-server'] });
  const captures = [];
  const metrics = [];
  const failures = [];
  try {
    for (const screen of screens)
      for (const vp of screen.viewports ?? Object.keys(viewports))
        for (const theme of screen.themes ?? themes) {
          const viewport = viewports[vp];
          const file = `${screen.id}-${viewport.width}-${theme}.png`;
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            isMobile: viewport.isMobile,
            hasTouch: viewport.hasTouch,
            colorScheme: theme,
            locale: 'ko-KR',
          });
          const page = await context.newPage();
          const started = Date.now();
          try {
            await page.goto(resolveUrl(baseUrl, screen.url, ids), { waitUntil: 'load' });
            await locatorFor(page, screen.ready ?? { css: 'header.workspace-header' }, ids).waitFor(
              {
                state: 'visible',
                timeout: 10_000,
              }
            );
            for (const step of screen.steps ?? []) await runStep(page, step, ids);
            await page.waitForTimeout(screen.settle ?? 300);
            await page.screenshot({
              path: path.join(shots, file),
              fullPage: screen.fullPage ?? false,
            });
            const results = await measureScreen(page, screen.metrics ?? defaultMetrics, {
              compact: viewport.width <= 760,
            });
            for (const result of results)
              metrics.push({
                screen: screen.id,
                viewport: vp,
                width: viewport.width,
                theme,
                principles: screen.principles ?? [],
                ...result,
                source: metricSource,
              });
            captures.push({
              screen: screen.id,
              title: screen.title,
              viewport: vp,
              width: viewport.width,
              theme,
              file: `screens/${file}`,
              elapsedMs: Date.now() - started,
            });
            log(`captured ${file}`);
          } catch (error) {
            failures.push(`${screen.id} ${vp} ${theme}: ${String(error.message).split('\n')[0]}`);
            await page
              .screenshot({ path: path.join(shots, file.replace(/\.png$/u, '-failed.png')) })
              .catch(() => {});
          } finally {
            await context.close();
          }
        }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.locator('header.workspace-header').first().waitFor({ timeout: 10_000 });
      for (const result of await styleInventory(page))
        metrics.push({
          screen: '*',
          viewport: 'desktop',
          width: 1440,
          theme: 'light',
          principles: ['P5', 'F8'],
          ...result,
          source: metricSource,
        });
    } catch (error) {
      failures.push(`style inventory: ${String(error.message).split('\n')[0]}`);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const generatedAt = new Date().toISOString();
  const rubric = summarizeRubric(metrics);
  await writeFile(
    path.join(directory, 'metrics.json'),
    JSON.stringify({ source: metricSource, generatedAt, rubric, results: metrics }, null, 2) + '\n'
  );
  await writeFile(
    path.join(directory, 'captures.json'),
    JSON.stringify({ generatedAt, captures, failures }, null, 2) + '\n'
  );
  await writeFile(
    path.join(directory, 'index.html'),
    contactSheet({ captures, metrics, screens, generatedAt })
  );
  return { captures, metrics, failures, rubric };
}
