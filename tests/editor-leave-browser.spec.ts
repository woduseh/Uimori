import { expect, test, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content, PromptPreset } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { isEditDraftSaveRequest, waitForEditDraftSave } from './fixtures/edit-draft-save.js';
import { editLibraryContent, navigationAction } from './ui-navigation.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const viewports = [
  { width: 2560, height: 1440 },
  { width: 412, height: 915 },
];
const flows = ['content-list', 'prompt-list', 'global-navigation'] as const;

async function expectDraftLeaveDialogLayout(guard: Locator, viewportWidth: number) {
  const dialog = await guard.boundingBox();
  expect(dialog).not.toBeNull();
  expect(dialog!.width).toBeCloseTo(Math.min(viewportWidth - 32, 620), 0);

  const bodyCopy = guard.locator('.dialog-body > p').first();
  const copyMetrics = await bodyCopy.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      height: node.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  if (viewportWidth > 760)
    expect(copyMetrics.height).toBeLessThanOrEqual(copyMetrics.lineHeight * 1.1);

  const buttons = guard.locator('.draft-discard-actions > button');
  await expect(buttons).toHaveCount(3);
  const boxes = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    })
  );
  if (viewportWidth <= 540) {
    expect(boxes[0].y).toBeLessThan(boxes[1].y);
    expect(boxes[1].y).toBeLessThan(boxes[2].y);
    for (const box of boxes) expect(box.width).toBeCloseTo(boxes[0].width, 0);
  } else {
    for (const box of boxes) expect(box.y).toBeCloseTo(boxes[0].y, 0);
  }
}

for (const viewport of viewports) {
  // Compact editor headers expose local list navigation only. Global navigation is
  // a desktop sidebar action; browser Back does not enter main's navigation guard.
  const reachableFlows =
    viewport.width === 412 ? flows.filter((flow) => flow !== 'global-navigation') : flows;
  for (const flow of reachableFlows) {
    test(`LEAVE ${flow} saves before leaving and retains failed or unapplied drafts at ${viewport.width}px`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize(viewport);
      const prompt = flow === 'prompt-list';
      const title = `Leave ${flow} ${randomUUID().slice(0, 8)}`;
      const endpoint = prompt ? '/api/prompt-presets' : '/api/content';
      const response = await request.post(endpoint, {
        data: prompt
          ? {
              title,
              role: 'main',
              program: nativePrompt('Synthetic leave instructions'),
              values: {},
            }
          : fixtureBotInput(title, 'Synthetic leave body'),
      });
      expect(response.ok(), await response.text()).toBe(true);
      const original = (await response.json()) as Content | PromptPreset;
      await page.goto('/');
      await navigationAction(page, prompt ? '프롬프트' : '서재');
      if (prompt) {
        await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
        await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      } else {
        await page.getByLabel('서재 검색', { exact: true }).fill(title);
        await editLibraryContent(page, title);
      }
      const editor = page.getByTestId(prompt ? 'prompt-editor' : 'library-panel');
      if (prompt) await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
      const name = editor.getByLabel(prompt ? '프롬프트 이름' : 'Risu 자료 이름', { exact: true });
      await name.fill(`${title} edited`);
      const guard = page.getByRole(flow === 'global-navigation' ? 'dialog' : 'alertdialog', {
        name:
          flow === 'global-navigation'
            ? '편집 중인 자료'
            : prompt
              ? '미저장 프롬프트 확인'
              : '미저장 자료 확인',
        exact: true,
      });
      const leave = async () => {
        if (flow === 'global-navigation') await navigationAction(page, '프롬프트');
        else
          await page
            .getByRole('button', { name: prompt ? '프롬프트 목록' : '서재 목록', exact: true })
            .click();
        await expect(guard).toBeVisible();
      };
      let raw: Locator;
      if (prompt) {
        await editor.getByRole('tab', { name: '정규식', exact: true }).click();
        await editor.getByText('고급 JSON 편집', { exact: true }).click();
        raw = editor.getByLabel('Risu 정규식 JSON', { exact: true });
      } else {
        await editor.getByRole('tab', { name: '고급 설정', exact: true }).click();
        await editor
          .getByRole('group', { name: '고급 설정 영역', exact: true })
          .getByRole('button', { name: '원문', exact: true })
          .click();
        raw = editor.getByLabel('Risu 원문 JSON', { exact: true });
      }
      await raw.fill('[{"unfinished":');
      const saves: string[] = [];
      page.on('request', (value) => {
        if (isEditDraftSaveRequest(value)) saves.push(value.url());
      });
      await leave();
      await expectDraftLeaveDialogLayout(guard, viewport.width);
      await page.screenshot({
        path: info.outputPath(`leave-${flow}-confirmation-${viewport.width}.png`),
      });
      await guard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
      await expect(guard.getByRole('alert')).toContainText('저장하지 못했어요');
      expect(saves).toHaveLength(0);
      expect((await (await request.get(`${endpoint}/${original.id}`)).json()).revision).toBe(
        original.revision
      );
      await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
      await expect(raw).toHaveValue('[{"unfinished":');
      await editor.getByRole('button', { name: '입력 되돌리기', exact: true }).click();

      const savePattern = '**/api/edit-drafts/*/save';
      await page.route(savePattern, (route) =>
        route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } })
      );
      await leave();
      await guard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
      await expect(guard.getByRole('alert')).toContainText('저장하지 못했어요');
      expect(saves).toHaveLength(1);
      expect((await (await request.get(`${endpoint}/${original.id}`)).json()).revision).toBe(
        original.revision
      );
      await page.screenshot({
        path: info.outputPath(`leave-${flow}-failed-${viewport.width}.png`),
      });
      await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
      await expect(name).toHaveValue(`${title} edited`);
      await page.unroute(savePattern);

      const arrived = latch(),
        release = latch();
      await page.route(savePattern, async (route) => {
        arrived.resolve();
        await release.promise;
        await route.continue();
      });
      await leave();
      const saved = waitForEditDraftSave(page, prompt ? 'prompt-preset' : 'content', original.id);
      try {
        await guard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
        await arrived.promise;
        await expect(guard.getByRole('button', { name: '저장 중…', exact: true })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(guard).toBeVisible();
        await expect(guard.getByRole('button', { name: '계속 편집', exact: true })).toBeDisabled();
        await page.screenshot({
          path: info.outputPath(`leave-${flow}-saving-${viewport.width}.png`),
        });
      } finally {
        release.resolve();
      }
      await saved;
      await expect(guard).toBeHidden();
      await expect(
        page.getByLabel(flow === 'content-list' ? '서재 검색' : '프롬프트 검색', { exact: true })
      ).toBeVisible();
      const persisted = await (await request.get(`${endpoint}/${original.id}`)).json();
      expect(persisted.title).toBe(`${title} edited`);
      expect(persisted.revision).toBe(original.revision + 1);
      expect(saves).toHaveLength(2);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      ).toBeLessThanOrEqual(1);
    });
  }
}

test('LEAVE multiple prompt roles stay open without saving only the current role', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
  const editor = page.getByTestId('prompt-editor');
  const mainTitle = `Unwritten main ${randomUUID()}`;
  const translationTitle = `Unwritten translation ${randomUUID()}`;
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  const title = editor.getByLabel('프롬프트 이름', { exact: true });
  const role = editor.getByLabel('프롬프트 역할', { exact: true });
  await title.fill(mainTitle);
  await role.selectOption('translation');
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await expect(role).toHaveValue('translation');
  await title.fill(translationTitle);
  const saves: string[] = [];
  page.on('request', (value) => {
    if (isEditDraftSaveRequest(value)) saves.push(value.url());
  });
  await page.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: '미저장 프롬프트 확인', exact: true });
  await guard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
  await expect(guard.getByRole('alert')).toContainText(
    '다른 역할이나 프리셋에도 미저장 초안이 있어요'
  );
  await expect(guard).toBeVisible();
  expect(saves).toHaveLength(0);
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(title).toHaveValue(translationTitle);
  await role.selectOption('main');
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await expect(role).toHaveValue('main');
  await expect(title).toHaveValue(mainTitle);
  await role.selectOption('translation');
  await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
  await expect(title).toHaveValue(translationTitle);
  expect(saves).toHaveLength(0);
});
