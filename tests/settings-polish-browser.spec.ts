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

test('SPUI03 usage keeps no-call periods compact without hiding free or unconfirmed calls', async ({
  page,
}) => {
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
      coverageSince: '2099-04-01T00:00:00Z',
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
  await expect(panel.locator('summary').filter({ hasText: '일별 및 용도별 상세' })).toHaveCount(0);
  await expect(panel).toContainText('시각 미확인 3회, US$0.03는 기간 합계에서 제외했어요.');
  await expect(panel.locator('.usage-note').filter({ hasText: '상세 집계 시작' })).toHaveText(
    '상세 집계 시작: 2099. 4. 1.'
  );
  pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await selectSettingsSection(page, '일반');
  await selectSettingsSection(page, '사용량');
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
    await selectSettingsSection(page, '일반');
    await selectSettingsSection(page, '사용량');
    await expect(panel.getByRole('region', { name: '모델별 비용', exact: true })).toContainText(
      `${next}-model`
    );
    await expect(emptyMessage).toHaveCount(0);
    await expect(panel.getByRole('region', { name: '비용 추이', exact: true })).toBeVisible();
    await expect(panel.locator('.usage-chart-column[aria-pressed="true"]')).toHaveCount(1);
    await expect(totals).toHaveText(
      next === 'free'
        ? ['US$0.00', '1', '20']
        : next === 'unknown'
          ? ['미확인', '1', '미확인']
          : ['US$0.00', '2', '미확인']
    );
    if (next === 'free') {
      await expect(panel.locator('.usage-chart-caption')).toContainText('US$0.00');
      await panel.locator('.usage-chart-column[aria-pressed="true"]').focus();
    }
    if (next === 'unknown') {
      await expect(panel.locator('.usage-chart-caption')).toContainText('비용 미확인');
    }
    if (next === 'unconfirmed') {
      await expect(panel.getByRole('region', { name: '사용 비용', exact: true })).toContainText(
        '미확인 1회, 부분 추정 1회'
      );
      await expect(panel.locator('.usage-chart-caption')).toContainText('부분 추정 1회');
      await expect(panel.locator('.usage-chart-caption')).toContainText('미확인 1회');
    }
  }
});
