import { expect, test, type Locator } from './fixtures/browser-test.js';
import { randomUUID } from 'node:crypto';
import type { Content, PromptPreset } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { isResourceSaveRequest, waitForResourceSave } from './fixtures/resource-save.js';
import { editLibraryContent, navigationAction, selectEditorSection } from './ui-navigation.js';
import { expectCodeFieldValue } from './code-field.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const compact = { width: 412, height: 915 };
const flows = [
  { flow: 'prompt-list', viewport: compact },
  { flow: 'global-navigation', viewport: { width: 2560, height: 1440 } },
] as const;

test(`DECISION resource conflict appears live, and review and failed recovery preserve input at ${compact.width}px`, async ({
  page,
  request,
}) => {
  await page.setViewportSize(compact);
  const title = `Decision ${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/prompt-presets', {
    data: { title, role: 'main', program: nativePrompt('Original instructions'), values: {} },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const preset = (await response.json()) as PromptPreset;
  const saveElsewhere = async (expectedRevision: number, text: string) => {
    const saved = await request.post('/api/resources/save', {
      data: {
        kind: 'prompt-preset',
        id: preset.id,
        expectedRevision,
        model: { title, role: 'main', program: nativePrompt(text), values: {} },
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  };
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
  await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
  const editor = page.getByTestId('prompt-editor');
  const body = editor.getByLabel('1번 프롬프트 본문', { exact: true });
  await expectCodeFieldValue(body, 'Original instructions');
  const read = `**/api/resources/prompt-preset/${preset.id}`;
  let failingUntil = Number.POSITIVE_INFINITY;
  let failedReads = 0;
  await page.route(read, (route) => {
    if (route.request().method() !== 'GET' || Date.now() >= failingUntil) return route.fallback();
    failedReads++;
    return route.fulfill({ status: 503, json: { error: 'Synthetic read failure' } });
  });
  await saveElsewhere(preset.revision, 'Saved while clean');
  failingUntil = Date.now() + 500;
  await expectCodeFieldValue(body, 'Saved while clean');
  expect(failedReads).toBeGreaterThan(0);
  await page.unroute(read);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === 'uimori-editor-recovery' && args[1] === 'readwrite')
        throw new DOMException('Disk full', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await body.fill('Keep my unsaved instructions');
  await expect(
    editor.getByRole('alert').filter({ hasText: '복구용 입력을 보관하지 못했어요' })
  ).toBeVisible();
  await saveElsewhere(preset.revision + 1, 'Changed elsewhere');
  await expect(
    editor.getByRole('alert').filter({ hasText: '저장된 자료가 변경됐어요' })
  ).toBeVisible();
  await expectCodeFieldValue(body, 'Keep my unsaved instructions');
  const review = page.getByRole('alertdialog', { name: '변경된 저장본 확인', exact: true });
  await expect(review).toBeHidden();
  let saves = 0;
  page.on('request', (request) => {
    if (isResourceSaveRequest(request) && request.postDataJSON().kind === 'prompt-preset') saves++;
  });
  await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
  await expect(review).toBeVisible();
  await expect(review).toContainText('Changed elsewhere');
  await review.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
  await expectCodeFieldValue(body, 'Keep my unsaved instructions');
  expect(saves).toBe(0);
  await page.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
  const leave = page.getByRole('alertdialog', { name: '미저장 프롬프트 확인', exact: true });
  await expect(leave.getByRole('alert')).toContainText('현재 입력을 복구할 수 없어요');
  await leave.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expectCodeFieldValue(body, 'Keep my unsaved instructions');
  const persisted = await (await request.get(`/api/prompt-presets/${preset.id}`)).json();
  expect(JSON.stringify(persisted.program)).toContain('Changed elsewhere');
});

for (const { flow, viewport } of flows) {
  test(`LEAVE ${flow} saves before leaving and retains failed or unapplied drafts at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
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
    if (prompt) await selectEditorSection(editor, '기본 옵션');
    const name = editor.getByLabel(prompt ? /^프롬프트 이름$/u : /^(봇|페르소나|모듈) 이름$/u);
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
      await selectEditorSection(editor, '정규식');
      await editor.getByText('고급 JSON 편집', { exact: true }).click();
      raw = editor.getByLabel('Risu 정규식 JSON', { exact: true });
    } else {
      await selectEditorSection(editor, 'JSON 소스');
      raw = editor.getByLabel('Risu 원문 JSON', { exact: true });
    }
    await raw.fill('[{"unfinished":');
    const saves: string[] = [];
    page.on('request', (value) => {
      if (isResourceSaveRequest(value)) saves.push(value.url());
    });
    await leave();
    await guard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
    await expect(guard.getByRole('alert')).toContainText('저장하지 못했어요');
    expect(saves).toHaveLength(0);
    expect((await (await request.get(`${endpoint}/${original.id}`)).json()).revision).toBe(
      original.revision
    );
    await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(raw).toHaveValue('[{"unfinished":');
    await editor.getByRole('button', { name: '입력 되돌리기', exact: true }).click();

    const savePattern = '**/api/resources/save';
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
    const saved = waitForResourceSave(page, prompt ? 'prompt-preset' : 'content', original.id);
    try {
      await guard.getByRole('button', { name: '저장하고 이동', exact: true }).click();
      await arrived.promise;
      await expect(guard.getByRole('button', { name: '저장 중…', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(guard).toBeVisible();
      await expect(guard.getByRole('button', { name: '계속 편집', exact: true })).toBeDisabled();
    } finally {
      release.resolve();
    }
    await saved;
    await expect(guard).toBeHidden();
    await expect(page.getByLabel('프롬프트 검색', { exact: true })).toBeVisible();
    const persisted = await (await request.get(`${endpoint}/${original.id}`)).json();
    expect(persisted.title).toBe(`${title} edited`);
    expect(persisted.revision).toBe(original.revision + 1);
    expect(saves).toHaveLength(2);
  });
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
  await selectEditorSection(editor, '기본 옵션');
  const title = editor.getByLabel('프롬프트 이름', { exact: true });
  const role = editor.getByLabel('프롬프트 역할', { exact: true });
  await title.fill(mainTitle);
  await role.selectOption('translation');
  await selectEditorSection(editor, '기본 옵션');
  await expect(role).toHaveValue('translation');
  await title.fill(translationTitle);
  const saves: string[] = [];
  page.on('request', (value) => {
    if (isResourceSaveRequest(value)) saves.push(value.url());
  });
  await page.getByRole('button', { name: '도우미 열기', exact: true }).click();
  const helper = page.locator('#helper-panel');
  await helper.getByRole('button', { name: '편집 중인 자료 저장', exact: true }).click();
  await expect(helper.getByText(/다른 역할이나 프리셋에도 미저장 초안이 있어요/u)).toBeVisible();
  await helper.getByRole('button', { name: '도우미 닫기', exact: true }).click();
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
  await selectEditorSection(editor, '기본 옵션');
  await expect(role).toHaveValue('main');
  await expect(title).toHaveValue(mainTitle);
  await role.selectOption('translation');
  await selectEditorSection(editor, '기본 옵션');
  await expect(title).toHaveValue(translationTitle);
  expect(saves).toHaveLength(0);
});
