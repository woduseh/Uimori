import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { HelperMessage } from '../core/helper.js';
import type { ModelPreset, ModelWorkspace } from '../core/product.js';
import type { Chat } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { openHelper } from './ui-navigation.js';

test.setTimeout(60_000);
preservePromptWorkspace();
const panelFor = (page: Page) => page.locator('#helper-panel');
const composer = (page: Page) =>
  panelFor(page).getByRole('textbox', { name: '도우미에게 요청', exact: true });
const picker = (page: Page) => panelFor(page).locator('input[type="file"]');
const draftImages = (page: Page) =>
  panelFor(page).locator('.helper-draft-attachments .request-image');
const draftFiles = (page: Page) =>
  panelFor(page).locator('.helper-draft-attachments .helper-file-chip');
const sessionPicker = (page: Page) =>
  panelFor(page).getByLabel('도우미 대화 선택', { exact: true });
const textFile = (name = '참고 자료.txt') => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from('인물은 흰 목도리를 하고 있다.\nThe lantern is blue.'),
});
async function png(name = '참고 이미지.png') {
  return {
    name,
    mimeType: 'image/png',
    buffer: await sharp({ create: { width: 64, height: 48, channels: 3, background: '#bc9147' } })
      .png()
      .toBuffer(),
  };
}
async function selectHelper(request: APIRequestContext, id: string) {
  const workspace = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  const response = await request.put('/api/model-workspace', {
    data: {
      ...workspace,
      revision: undefined,
      expectedRevision: workspace.revision,
      helperModel: { id },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function setup(request: APIRequestContext) {
  const created = await postFixtureChat(request, {
    data: { title: `첨부 작업실 ${randomUUID()}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = (await created.json()) as Chat;
  const connection = await request.post('/api/connections', {
    data: {
      title: `첨부 합성 ${randomUUID()}`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      enabled: true,
    },
  });
  expect(connection.ok(), await connection.text()).toBe(true);
  const model = await request.post('/api/model-presets', {
    data: {
      title: `첨부 합성 모델 ${randomUUID()}`,
      connectionId: (await connection.json()).id,
      modelId: 'helper-attachments-fixture',
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(model.ok(), await model.text()).toBe(true);
  const preset = (await model.json()) as ModelPreset;
  await selectHelper(request, preset.id);
  return { chat, model: preset };
}
async function open(page: Page, chat?: Chat) {
  if (chat) await page.goto(`/?chat=${chat.id}`);
  if (!(await panelFor(page).isVisible())) await openHelper(page);
  await expect(composer(page)).toBeEnabled();
  return panelFor(page);
}
async function messages(
  request: APIRequestContext,
  conversationId: string
): Promise<HelperMessage[]> {
  const response = await request.get(`/api/helper/conversations/${conversationId}/messages`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

// The real API admits and stores attachments; fixture execution may end in a local connection
// failure. These cases establish upload/admission/recovery, not live model response quality.
test('HATT01 picker sends image and text attachments without text and restores stored metadata', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { chat } = await setup(request);
  const panel = await open(page, chat);
  const id = await sessionPicker(page).inputValue();
  const posts: Record<string, unknown>[] = [];
  await page.route(`**/api/helper/conversations/${id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    await route.fulfill({ response });
  });
  const choosing = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: '파일 첨부', exact: true }).click();
  await (await choosing).setFiles([textFile(), await png()]);
  await expect(draftFiles(page)).toHaveCount(1);
  await expect(draftImages(page)).toHaveCount(1);
  await expect(composer(page)).toHaveValue('');
  const send = panel.getByRole('button', { name: '도우미 요청 보내기', exact: true });
  await expect(send).toBeEnabled();
  await page.screenshot({ path: info.outputPath('helper-attachments-desktop.png') });
  await send.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({
    text: '',
    images: [
      {
        name: '참고 이미지.png',
        uploadId: expect.any(String),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ],
    files: [
      {
        name: '참고 자료.txt',
        uploadId: expect.any(String),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ],
  });
  await expect(draftFiles(page)).toHaveCount(0);
  await expect(draftImages(page)).toHaveCount(0);
  const saved = (await messages(request, id)).find((message) => message.role === 'user')!;
  expect(saved).toMatchObject({
    text: '',
    images: [{ name: '참고 이미지.png', width: 64, height: 48 }],
    files: [
      { name: '참고 자료.txt', mime: 'text/plain', kind: 'text', bytes: textFile().buffer.length },
    ],
  });
  await page.reload();
  await open(page);
  await expect(panel.getByRole('img', { name: '참고 이미지.png', exact: true })).toBeVisible();
  await expect(panel.locator('.helper-message .helper-file-chip')).toContainText('참고 자료.txt');
  const downloading = page.waitForEvent('download');
  await panel.getByRole('link', { name: '참고 자료.txt', exact: true }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe('참고 자료.txt');
  expect(await readFile((await downloaded.path())!, 'utf8')).toBe(
    textFile().buffer.toString('utf8')
  );
  await expect(draftFiles(page)).toHaveCount(0);
});

test('HATT02 image paste and drop drafts survive sidecar, workspace, conversation switching and model rejection', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 360, height: 844 });
  const { chat, model } = await setup(request);
  const panel = await open(page, chat);
  const first = await sessionPicker(page).inputValue();
  const other = await request.post('/api/helper/conversations/new', {
    data: {
      scope: { kind: 'chat', chatId: chat.id },
      requestKey: randomUUID(),
      title: '다른 첨부 대화',
    },
  });
  expect(other.ok(), await other.text()).toBe(true);
  const otherId = (await other.json()).id as string;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(sessionPicker(page).locator(`option[value="${otherId}"]`)).toHaveCount(1);
  const image = await png('붙여넣은 이미지.png');
  await composer(page).evaluate(
    (node, value) => {
      const bytes = Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], value.name, { type: 'image/png' }));
      node.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      );
    },
    { base64: image.buffer.toString('base64'), name: image.name }
  );
  await expect(draftImages(page)).toHaveCount(1);
  await panel.locator('.helper-request-composer').evaluate((node) => {
    const data = new DataTransfer();
    data.items.add(new File(['드롭한 참고 문서'], '드롭한 문서.txt', { type: 'text/plain' }));
    node.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
    );
  });
  await expect(draftFiles(page)).toContainText('드롭한 문서.txt');
  await expect(panel.getByRole('button', { name: '파일 첨부', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await expect(panel).toHaveClass(/helper-expanded/u);
  await expect(draftImages(page)).toHaveCount(1);
  await sessionPicker(page).selectOption(otherId);
  await expect(draftImages(page)).toHaveCount(0);
  await expect(draftFiles(page)).toHaveCount(0);
  await picker(page).setInputFiles(textFile('다른 대화 자료.txt'));
  await expect(draftFiles(page)).toContainText('다른 대화 자료.txt');
  await sessionPicker(page).selectOption(first);
  await expect(draftImages(page)).toHaveCount(1);
  await expect(draftFiles(page)).toContainText('드롭한 문서.txt');
  await panel.getByRole('button', { name: chat.title, exact: true }).click();
  await expect(panel).not.toHaveClass(/helper-expanded/u);
  await page.screenshot({ path: info.outputPath('helper-attachments-mobile.png') });
  const textConnection = await request.post('/api/connections', {
    data: {
      title: `텍스트 전용 합성 ${randomUUID()}`,
      protocol: 'deepseek-chat-v1',
      endpoint: 'http://127.0.0.1:9/v1/chat/completions',
      enabled: true,
    },
  });
  expect(textConnection.ok(), await textConnection.text()).toBe(true);
  const unsupported = await request.post('/api/model-presets', {
    data: {
      title: `미지원 모델 ${randomUUID()}`,
      connectionId: (await textConnection.json()).id,
      modelId: 'deepseek-chat',
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(unsupported.ok(), await unsupported.text()).toBe(true);
  await selectHelper(request, (await unsupported.json()).id);
  await page.reload();
  await open(page);
  await expect(panel.getByRole('alert')).toContainText(
    '선택한 모델은 이미지 입력을 지원하지 않아요.'
  );
  await expect(draftImages(page)).toHaveCount(1);
  await expect(draftFiles(page)).toContainText('드롭한 문서.txt');
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  expect(
    (await messages(request, first)).filter((message) => message.role === 'user')
  ).toHaveLength(0);
  await selectHelper(request, model.id);
  await page.reload();
  await open(page);
  await expect(draftImages(page)).toHaveCount(1);
  await expect(draftFiles(page)).toContainText('드롭한 문서.txt');
  await sessionPicker(page).selectOption(otherId);
  await expect(draftFiles(page)).toContainText('다른 대화 자료.txt');
});

test('HATT03 uncertain admission reuses exact uploads and preserves the newer text and image draft', async ({
  page,
  request,
}) => {
  const { chat } = await setup(request);
  const panel = await open(page, chat);
  const id = await sessionPicker(page).inputValue();
  const posts: unknown[] = [];
  let uploads = 0;
  await page.route('**/api/uploads', async (route) => {
    uploads++;
    await route.fallback();
  });
  await page.route(`**/api/helper/conversations/${id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    if (posts.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await composer(page).fill('접수 여부를 확인할 원래 요청');
  await picker(page).setInputFiles(textFile('처음 첨부.txt'));
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await page.reload();
  await open(page);
  await composer(page).fill('늦은 접수 응답 뒤에도 남아야 하는 새 초안');
  await picker(page).setInputFiles(await png('새 첨부.png'));
  await expect(draftImages(page)).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '파일 첨부', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '도우미 요청 확인', exact: true })
    .getByRole('button', { name: '접수 확인 및 재시도', exact: true })
    .click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(uploads).toBe(1);
  await expect(panel.locator('.helper-outbox')).toHaveCount(0);
  await expect(composer(page)).toHaveValue('늦은 접수 응답 뒤에도 남아야 하는 새 초안');
  await expect(draftImages(page)).toHaveCount(1);
  await expect(draftFiles(page)).toContainText('처음 첨부.txt');
  expect((await messages(request, id)).filter((message) => message.role === 'user')).toHaveLength(
    1
  );
  await page.reload();
  await open(page);
  await expect(composer(page)).toHaveValue('늦은 접수 응답 뒤에도 남아야 하는 새 초안');
  await expect(draftImages(page)).toHaveCount(1);
  await expect(draftFiles(page)).toContainText('처음 첨부.txt');
});

test('HATT04 long attachment errors keep their text scrollable and dismiss button clickable', async ({
  page,
  request,
}) => {
  const { chat } = await setup(request);
  await page.setViewportSize({ width: 320, height: 568 });
  const panel = await open(page, chat);
  for (const height of [568, 915]) {
    await page.setViewportSize({ width: 320, height });
    const name = `${'긴첨부파일이름'.repeat(18)}${height}.unknown`;
    await picker(page).setInputFiles({
      name,
      mimeType: 'application/x-unrecognized',
      buffer: Buffer.from('test'),
    });
    const notice = panel.locator('.helper-notice');
    await expect(notice).toContainText(name);
    const scroll = await notice.locator('.notice-banner-message').evaluate((message) => {
      message.scrollTop = message.scrollHeight;
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      let lastText: Text | null = null;
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.trim()) lastText = walker.currentNode as Text;
      }
      if (!lastText) throw new Error('Notice message has no text');
      const range = document.createRange();
      const end = lastText.data.trimEnd().length;
      range.setStart(lastText, end - 1);
      range.setEnd(lastText, end);
      const text = range.getBoundingClientRect();
      const area = message.getBoundingClientRect();
      const hit = document.elementFromPoint(
        (area.left + area.right) / 2,
        (area.top + area.bottom) / 2
      );
      return {
        offset: message.scrollTop,
        endVisible: text.top >= area.top - 1 && text.bottom <= area.bottom + 1,
        areaVisible: area.top >= 0 && area.bottom <= window.innerHeight,
        areaHit: !!hit && (hit === message || message.contains(hit)),
      };
    });
    expect(scroll.offset).toBeGreaterThan(0);
    expect(scroll.endVisible && scroll.areaVisible && scroll.areaHit).toBe(true);
    const close = notice.getByRole('button', { name: '닫기', exact: true });
    const point = await close.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const container = button.closest('.helper-notice')!.getBoundingClientRect();
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        visible:
          rect.top >= container.top &&
          rect.bottom <= container.bottom &&
          rect.bottom <= innerHeight,
        hit: !!hit && (hit === button || button.contains(hit)),
      };
    });
    expect(point.visible && point.hit).toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(notice).toHaveCount(0);
  }
});

test('HATT05 oversized attachment explains the limit before a long filename', async ({
  page,
  request,
}) => {
  const { chat } = await setup(request);
  const connection = await request.post('/api/connections', {
    data: {
      title: `첨부 크기 ${randomUUID()}`,
      protocol: 'anthropic-messages-v1',
      endpoint: 'http://127.0.0.1:9/v1/messages',
      enabled: true,
    },
  });
  expect(connection.ok(), await connection.text()).toBe(true);
  const model = await request.post('/api/model-presets', {
    data: {
      title: `첨부 크기 모델 ${randomUUID()}`,
      connectionId: (await connection.json()).id,
      modelId: 'synthetic-size-model',
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(model.ok(), await model.text()).toBe(true);
  await selectHelper(request, (await model.json()).id);
  await page.setViewportSize({ width: 320, height: 568 });
  const panel = await open(page, chat);
  const name = `${'긴첨부파일이름'.repeat(14)}.txt`;
  await panel.locator('.helper-request-composer').evaluate((composer, filename) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(32_000_001)], filename, { type: 'text/plain' }));
    composer.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
    );
  }, name);
  const notice = panel.locator('.helper-notice');
  await expect(notice).toContainText(name);
  const phrase = '파일 크기는 32MB 이하여야 해요.';
  await expect(notice).toContainText(phrase);
  const visible = await notice.locator('.notice-banner-message').evaluate(
    (message, value) => {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode() as Text | null;
      if (!text || text.data.indexOf(value.phrase) !== 0) return null;
      const filenameStart = text.data.indexOf(value.filename);
      if (filenameStart < 0) return null;
      const range = document.createRange();
      const area = message.getBoundingClientRect();
      const isVisible = (start: number, end: number) => {
        range.setStart(text, start);
        range.setEnd(text, end);
        const rect = range.getBoundingClientRect();
        return rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1;
      };
      return {
        reason: isVisible(0, value.phrase.length),
        filename: isVisible(filenameStart, filenameStart + 1),
      };
    },
    { phrase, filename: name }
  );
  expect(visible).toEqual({ reason: true, filename: true });
});
