import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import type { DiagnosticReport } from '../core/diagnostic-report.js';

for (const width of DEFAULT_WIDTHS) {
  test(`DIAG01 report preview/download excludes private content and preserves Run Inspector at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const privateMarker = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_MANUSCRIPT';
    const created = await postFixtureChat(request, { data: { title: privateMarker } });
    expect(created.ok()).toBe(true);
    const chat = await created.json();
    const queued = await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: privateMarker,
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: `diagnostics:${chat.id}`,
      },
    });
    expect(queued.ok(), await queued.text()).toBe(true);
    const run = await queued.json();
    await expect
      .poll(async () => (await (await request.get(`/api/runs/${run.id}`)).json()).status)
      .toBe('completed');
    await page.goto(`/?chat=${chat.id}`);
    await navigationAction(page, '작업 현황');
    await expect(
      page.getByRole('button', { name: '문제 보고용 진단 만들기', exact: true })
    ).toHaveCount(0);
    const inspector = page.getByText('실행과 실제 입력 확인', { exact: true }).first();
    await inspector.click();
    await page
      .getByRole('button', { name: '문제 보고용 진단 만들기', exact: true })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: '진단 보고서 미리보기', exact: true });
    await expect(dialog.getByRole('status')).toContainText('선택한 실행');
    const coverage = dialog.locator('details').filter({ hasText: '보고서에 담기는 정보' });
    await expect(coverage).toHaveJSProperty('open', false);
    await coverage.locator('summary').click();
    await expect(coverage).toContainText('서버·브라우저 로그는 포함하지 않아요');
    await coverage.locator('summary').click();
    await dialog.getByText('파일 내용 확인', { exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('uimori-diagnostic-report');
    await expect(dialog.locator('pre')).not.toContainText(privateMarker);
    const runPath = `/api/runs/${run.id}`;
    let refreshing = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${runPath}`, async (route) => {
      refreshing = true;
      await held;
      await route.continue();
    });
    const refreshed = page.waitForResponse((response) => response.url().endsWith(runPath));
    try {
      const current = await (await request.get(`/api/chats/${chat.id}`)).json();
      const renamed = await request.patch(`/api/chats/${chat.id}/title`, {
        data: {
          title: `${privateMarker} updated`,
          expectedTitleRevision: current.chat.titleRevision,
        },
      });
      expect(renamed.ok(), await renamed.text()).toBe(true);
      await expect.poll(() => refreshing).toBe(true);
      // A reader event reloads the open inspector, but must not remove its independent report.
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('status')).toContainText('선택한 실행');
    } finally {
      release();
      await refreshed;
      await page.unrouteAll({ behavior: 'wait' });
    }
    expect(
      await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`diagnostics-${width}.png`) });
    const downloadEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '진단 파일 다운로드', exact: true }).click();
    const download = await downloadEvent;
    const bytes = await readFile((await download.path())!);
    const report = JSON.parse(bytes.toString()) as DiagnosticReport;
    expect(download.suggestedFilename()).toBe('uimori-diagnostic-report.json');
    expect(report.scope).toBe('run');
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].sourceCommitted).toBe(true);
    for (const privateValue of [privateMarker, chat.id, run.id])
      expect(bytes.toString()).not.toContain(privateValue);
    await page.keyboard.press('Escape');
    await expect(inspector.locator('..')).toHaveJSProperty('open', true);
    await expect(page.locator('.run-task-details pre').first()).toContainText(privateMarker);
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    await page.getByText('문제 보고용 진단', { exact: true }).click();
    await page.getByRole('button', { name: '시스템 진단 만들기', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('시스템 정보 · 실행 0개');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '선택 채팅 진단 만들기', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('선택한 채팅 · 실행 1개');
  });

  test(`DIAG02 failed report remains retryable and cancelled late response cannot reopen preview at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    await page.getByText('문제 보고용 진단', { exact: true }).click();
    const pattern = '**/api/diagnostics/report';
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'PRIVATE_ERROR_MUST_NOT_DISPLAY' }),
      })
    );
    const dialog = page.getByRole('dialog', { name: '진단 보고서 미리보기', exact: true });
    try {
      await page.getByRole('button', { name: '시스템 진단 만들기', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('만들지 못했어요');
      await expect(dialog).not.toContainText('PRIVATE_ERROR_MUST_NOT_DISPLAY');
      await expect(dialog.getByRole('button', { name: '진단 파일 다운로드' })).toHaveCount(0);
      await page.unroute(pattern);
      await dialog.getByRole('button', { name: '다시 시도', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('시스템 정보');
      await page.keyboard.press('Escape');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(pattern, async (route) => {
        await gate;
        await route.continue().catch(() => undefined);
      });
      try {
        await page.getByRole('button', { name: '시스템 진단 만들기', exact: true }).click();
        await expect(dialog.getByRole('status')).toContainText('만드는 중');
        await page.keyboard.press('Escape');
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await expect(dialog).not.toBeVisible();
      } finally {
        release();
      }
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
