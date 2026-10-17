import { test, expect } from '@playwright/test';
import type { UsageReport, UsageTotals } from '../core/usage-report.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

const empty: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  unknownInputCalls: 0,
  unknownOutputCalls: 0,
  reportedUsd: 0,
  estimatedUsd: 0,
  partialUsd: 0,
  partialCalls: 0,
  unknownCostCalls: 0,
  runningCalls: 0,
};
test('SPUI01 usage dashboard keeps partial bills honest, filters atomically, and fits dark/light desktop and mobile', async ({
  page,
}, info) => {
  const requests: string[] = [];
  let fail = true;
  let pendingResponse: Promise<void> | undefined;
  let releaseResponse: (() => void) | undefined;
  await page.route('**/api/usage?*', async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get('from')!,
      to = url.searchParams.get('to')!;
    requests.push(`${from}:${to}`);
    if (pendingResponse) await pendingResponse;
    if (fail) {
      await route.fulfill({ status: 503, json: { error: '사용량을 불러오지 못했어요.' } });
      return;
    }
    const days = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10)
    ).filter((day) => day <= to);
    const rows = days.map((day, i) => ({
      ...empty,
      day,
      calls: 4,
      inputTokens: 250000,
      outputTokens: 150000,
      reportedUsd: i === 0 ? 2.58 : 0,
      estimatedUsd: i === 1 ? 1.69 : 0,
      partialUsd: i === 2 ? 0.005 : 0,
      partialCalls: i === 2 ? 1 : 0,
      unknownCostCalls: i === 3 ? 4 : 0,
      unknownInputCalls: i === 3 ? 1 : 0,
    }));
    const totals = rows.reduce(
      (sum, row) => {
        for (const key of Object.keys(empty) as (keyof UsageTotals)[]) sum[key] += row[key];
        return sum;
      },
      { ...empty }
    );
    const data: UsageReport = {
      from,
      to,
      timeZone: 'Asia/Seoul',
      totals,
      days: rows,
      models: [
        { ...empty, ...rows[0], connectionId: 'fixture', modelId: 'writing-model' },
        ...(rows[1]
          ? [{ ...empty, ...rows[1], connectionId: 'fixture', modelId: 'translation-model' }]
          : []),
        ...(rows[2]
          ? [{ ...empty, ...rows[2], connectionId: 'fixture', modelId: 'tiny-partial-model' }]
          : []),
        ...(rows[3]
          ? [{ ...empty, ...rows[3], connectionId: 'fixture', modelId: 'unknown-bill-model' }]
          : []),
      ],
      kinds: [{ ...totals, kind: 'writing' }],
      undated: empty,
      coverageSince: `${from}T00:00:00Z`,
    };
    await route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '사용량');
  const panel = page.getByRole('region', { name: '작업실 사용량', exact: true });
  const retry = panel.getByRole('button', { name: '다시 불러오기', exact: true });
  await expect(panel.getByRole('alert')).toContainText('(503)');
  await expect(panel.locator('.usage-results')).toHaveCount(0);
  await expect(retry).toBeEnabled();
  pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(panel.getByRole('alert')).toContainText('(503)');
  fail = false;
  pendingResponse = undefined;
  releaseResponse!();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: '7일', exact: true }).click();
  await expect(panel.getByRole('region', { name: '사용 비용', exact: true })).toContainText(
    '미확인 4'
  );
  const unknown = panel.locator('.usage-chart-column').nth(3);
  await unknown.focus();
  await expect(panel.locator('.usage-chart-caption')).toContainText('비용 미확인');
  await expect(panel.getByRole('region', { name: '모델별 비용', exact: true })).toContainText(
    '<US$0.01'
  );
  for (const theme of ['dark', 'light']) {
    await selectSettingsSection(page, '일반');
    await page.getByLabel('앱 화면 테마', { exact: true }).selectOption(theme);
    await selectSettingsSection(page, '사용량');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.settings-page[data-settings-section="usage"]').evaluate((element) => {
        element.scrollTop = 0;
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
      const meters = await panel.locator('.usage-model-meter').evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right };
        })
      );
      expect(meters.length).toBeGreaterThan(1);
      for (const meter of meters.slice(1)) {
        expect(Math.abs(meter.left - meters[0].left)).toBeLessThanOrEqual(1);
        expect(Math.abs(meter.right - meters[0].right)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: info.outputPath(`usage-dashboard-${theme}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await panel.getByRole('button', { name: '직접 선택', exact: true }).click();
  const before = requests.length;
  await panel.getByLabel('시작일').fill('2099-12-31');
  await panel.getByLabel('종료일').focus();
  await expect(panel.getByRole('alert')).toContainText('시작일과 종료일');
  expect(requests.length).toBe(before);
  await panel.getByLabel('종료일').fill('2099-12-31');
  await expect.poll(() => requests.at(-1)).toBe('2099-12-31:2099-12-31');
  await expect(panel.locator('.usage-chart-column')).toHaveCount(1);
  const totals = panel.locator('.usage-cards strong');
  await expect(totals).toHaveText(['US$2.58', '4', '400K']);
  pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await panel.getByRole('button', { name: '사용량 새로고침', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('사용량을 새로 불러오는 중');
  await expect(panel.locator('.usage-results')).toHaveAttribute('aria-busy', 'true');
  await expect(totals).toHaveText(['US$2.58', '4', '400K']);
  await expect(panel.locator('.usage-chart-column')).toHaveCount(1);
  await expect(panel.getByRole('region', { name: '모델별 비용', exact: true })).toContainText(
    'writing-model'
  );
  fail = true;
  pendingResponse = undefined;
  releaseResponse!();
  await expect(panel.getByRole('alert')).toContainText('(503)');
  await expect(panel.getByRole('alert')).toContainText('이전 결과를 표시해요.');
  await expect(totals).toHaveText(['US$2.58', '4', '400K']);
  await expect(panel.locator('.usage-chart-column')).toHaveCount(1);
  await expect(panel.locator('summary[aria-label="CSV 내보내기"]')).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.getByRole('alert').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('usage-refresh-error-' + width + '.png') });
  }
  pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(panel.getByRole('alert')).toContainText('(503)');
  await expect(totals).toHaveText(['US$2.58', '4', '400K']);
  fail = false;
  pendingResponse = undefined;
  releaseResponse!();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('.usage-results')).toHaveAttribute('aria-busy', 'false');
  await expect(panel.locator('.usage-chart-column')).toHaveCount(1);
  await expect(panel.locator('summary[aria-label="CSV 내보내기"]')).toHaveCount(1);
  pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const beforeChangingRange = requests.length;
  await panel.getByRole('button', { name: '오늘', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(beforeChangingRange);
  await expect(panel.locator('.usage-results')).toHaveCount(0);
  await expect(panel.getByRole('status')).toContainText('사용량을 불러오는 중');
  fail = true;
  pendingResponse = undefined;
  releaseResponse!();
  await expect(panel.getByRole('alert')).toContainText('(503)');
  await expect(panel.locator('.usage-results')).toHaveCount(0);
  fail = false;
  await retry.click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('.usage-chart-column')).toHaveCount(1);
});

test('SPUI03 usage keeps no-call periods compact without hiding free or unconfirmed calls', async ({
  page,
}, info) => {
  let state: 'empty' | 'free' | 'unknown' | 'unconfirmed' = 'empty';
  let fail = false;
  let pendingResponse: Promise<void> | undefined;
  let releaseResponse: (() => void) | undefined;
  await page.route('**/api/usage?*', async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get('from')!,
      to = url.searchParams.get('to')!;
    if (pendingResponse) await pendingResponse;
    if (fail) {
      await route.fulfill({ status: 503, json: { error: '사용량을 불러오지 못했어요.' } });
      return;
    }
    const totals: UsageTotals =
      state === 'free'
        ? { ...empty, calls: 1, inputTokens: 12, outputTokens: 8 }
        : state === 'unknown'
          ? {
              ...empty,
              calls: 1,
              unknownInputCalls: 1,
              unknownOutputCalls: 1,
              unknownCostCalls: 1,
            }
          : state === 'unconfirmed'
            ? {
                ...empty,
                calls: 2,
                unknownInputCalls: 2,
                unknownOutputCalls: 2,
                unknownCostCalls: 1,
                partialCalls: 1,
              }
            : { ...empty };
    const data: UsageReport = {
      from,
      to,
      timeZone: 'Asia/Seoul',
      totals,
      days: totals.calls ? [{ ...totals, day: from }] : [],
      models: totals.calls
        ? [{ ...totals, connectionId: 'fixture', modelId: `${state}-model` }]
        : [],
      kinds: totals.calls ? [{ ...totals, kind: 'writing' }] : [],
      undated: { ...empty, calls: 3, reportedUsd: 0.03 },
      coverageSince: '2026-04-01T00:00:00Z',
    };
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '사용량');
  const panel = page.getByRole('region', { name: '작업실 사용량', exact: true });
  const emptyMessage = panel.getByText('선택한 기간에 기록이 없어요.', { exact: true });
  const totals = panel.locator('.usage-cards strong');
  await expect(totals).toHaveText(['US$0.00', '0', '0']);
  await expect(emptyMessage).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '이번 달', exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: '비용 추이', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('region', { name: '모델별 비용', exact: true })).toHaveCount(0);
  await expect(panel.locator('summary').filter({ hasText: '모델별 상세' })).toHaveCount(0);
  await expect(panel.locator('summary').filter({ hasText: '일별·용도별 상세' })).toHaveCount(0);
  await expect(panel).toContainText('시각 미확인 3회 · US$0.03는 기간 합계에서 제외했어요.');
  await panel.getByText('집계 기준', { exact: true }).click();
  await expect(panel.locator('.usage-help')).toContainText('상세 집계 시작: 2026. 4. 1.');
  await panel.getByText('집계 기준', { exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await selectSettingsSection(page, '일반');
    await page.getByLabel('앱 화면 테마', { exact: true }).selectOption(theme);
    await selectSettingsSection(page, '사용량');
    for (const width of [1440, 412]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.settings-page[data-settings-section="usage"]').evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(emptyMessage).toHaveCount(1);
      expect(
        await emptyMessage.evaluate((element) => element.getBoundingClientRect().height)
      ).toBeLessThan(80);
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`usage-empty-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await panel.getByRole('button', { name: '사용량 새로고침', exact: true }).click();
  await expect(panel.locator('.usage-results')).toHaveAttribute('aria-busy', 'true');
  await expect(emptyMessage).toHaveCount(1);
  await expect(totals).toHaveText(['US$0.00', '0', '0']);
  fail = true;
  pendingResponse = undefined;
  releaseResponse!();
  await expect(panel.getByRole('alert')).toContainText('이전 결과를 표시해요.');
  await expect(emptyMessage).toHaveCount(1);
  await expect(panel.locator('summary[aria-label="CSV 내보내기"]')).toHaveCount(0);
  fail = false;
  await panel.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('summary[aria-label="CSV 내보내기"]')).toHaveCount(1);
  for (const next of ['free', 'unknown', 'unconfirmed'] as const) {
    state = next;
    await panel.getByRole('button', { name: '사용량 새로고침', exact: true }).click();
    await expect(panel.getByRole('region', { name: '모델별 비용', exact: true })).toContainText(
      `${next}-model`
    );
    await expect(emptyMessage).toHaveCount(0);
    await expect(panel.getByRole('region', { name: '비용 추이', exact: true })).toBeVisible();
    await expect(totals).toHaveText(
      next === 'free'
        ? ['US$0.00', '1', '20']
        : next === 'unknown'
          ? ['미확인', '1', '미확인']
          : ['US$0.00', '2', '미확인']
    );
    if (next === 'unknown') {
      await panel.locator('.usage-chart-column').first().focus();
      await expect(panel.locator('.usage-chart-caption')).toContainText('비용 미확인');
    }
    if (next === 'unconfirmed') {
      await expect(panel.getByRole('region', { name: '사용 비용', exact: true })).toContainText(
        '미확인 1 · 부분 추정 1회'
      );
      await panel.locator('.usage-chart-column').first().focus();
      await expect(panel.locator('.usage-chart-caption')).toContainText('부분 추정 1회');
      await expect(panel.locator('.usage-chart-caption')).toContainText('미확인 1회');
    }
  }
});

test('SPUI02 lore reset is an unsaved form action and incomplete backup input never changes server settings', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '로어 컨텍스트');
  const lore = page.getByRole('region', { name: '로어 컨텍스트 기본값', exact: true });
  const before = await (await request.get('/api/lore-context-defaults')).json();
  await lore.getByText('선별 기준과 용량', { exact: true }).click();
  await lore.getByLabel('조회 로어 토큰 한도', { exact: true }).fill('');
  await expect(lore.getByRole('button', { name: '로어 컨텍스트 기본값 저장' })).toBeDisabled();
  await lore.getByRole('button', { name: '초기값으로 되돌리기', exact: true }).click();
  await expect(lore.getByLabel('조회 로어 토큰 한도', { exact: true })).toHaveValue('16000');
  expect(await (await request.get('/api/lore-context-defaults')).json()).toEqual(before);
  await lore.getByText('단위와 예산 설명', { exact: true }).click();
  await lore.locator('.settings-form-footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('lore-footer-desktop.png') });
  await selectSettingsSection(page, '데이터 관리');
  const backup = page.getByRole('region', { name: '자동 백업', exact: true });
  const initial = await (await request.get('/api/backups')).json();
  await backup.getByRole('switch', { name: '매일 자동 백업' }).check();
  await expect(backup.getByLabel('백업 시간', { exact: true })).toBeVisible();
  await backup.getByLabel('성공본 보관 개수').fill('');
  await expect(backup.getByRole('button', { name: '백업 설정 저장' })).toBeDisabled();
  expect((await (await request.get('/api/backups')).json()).settings).toEqual(initial.settings);
  await backup.getByLabel('성공본 보관 개수').fill('7');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await backup.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`backup-polish-${width}.png`) });
  }
});
