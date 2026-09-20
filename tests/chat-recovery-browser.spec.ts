import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { openChatSettings, selectChatSettingsSection } from './ui-navigation.js';
import {
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
  MOBILE_WIDTH,
  MOBILE_HEIGHT,
} from './fixtures/browser-viewports.js';

async function fixture(request: APIRequestContext) {
  const input = fixtureBotInput(`Chat recovery ${randomUUID()}`);
  input.package.nativeRisu.card.extensions = {
    risuai: { defaultVariables: 'trust=40\nlocation=reading_room\nempty=' },
  };
  const created = await request.post('/api/content', { data: input });
  expect(created.ok(), await created.text()).toBe(true);
  const bot = (await created.json()) as Content;
  const response = await request.post('/api/chats', { data: { title: bot.title, botId: bot.id } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string }>;
}

async function open(page: Page, chatId: string) {
  await page.goto(`/?chat=${chatId}`);
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeVisible();
  await openChatSettings(page);
  return page.getByRole('dialog', { name: '채팅 설정', exact: true });
}

for (const viewport of [
  { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
]) {
  test.describe(`chat recovery ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test('CHATREC01 shared profile drafts survive reorganized memory and image sections', async ({
      page,
      request,
    }, info) => {
      const chat = await fixture(request);
      const dialog = await open(page, chat.id);
      await selectChatSettingsSection(page, '대화 구성');
      await expect(dialog.getByLabel('원문 이미지 자동 배치', { exact: true })).toBeHidden();
      await expect(dialog.getByRole('region', { name: '로어 문맥 정책' })).toBeHidden();
      await selectChatSettingsSection(page, '기억·로어');
      await expect(dialog.getByLabel('Jev 관련성 기준', { exact: true })).toBeHidden();
      await dialog.getByText('선별 기준과 용량', { exact: true }).click();
      await dialog.getByLabel('Jev 관련성 기준', { exact: true }).fill('0.7');
      await dialog.getByLabel('조회 로어 문자 한도', { exact: true }).fill('');
      await selectChatSettingsSection(page, '이미지');
      const manager = dialog.locator('.chat-settings-image-management');
      await expect(manager).not.toHaveAttribute('open');
      await expect(dialog.getByLabel('이미지 이름', { exact: true })).toBeHidden();
      await manager.locator(':scope > summary').click();
      await dialog.getByLabel('이미지 이름', { exact: true }).fill('접어도 유지할 이미지 이름');
      await manager.locator(':scope > summary').click();
      await manager.locator(':scope > summary').click();
      await expect(dialog.getByLabel('이미지 이름', { exact: true })).toHaveValue(
        '접어도 유지할 이미지 이름'
      );
      await dialog.getByLabel('이미지 이름', { exact: true }).fill('');
      await manager.locator(':scope > summary').click();
      const image = dialog.getByRole('switch', { name: '원문 이미지 자동 배치', exact: true });
      const originalImage = await image.isChecked();
      await image.setChecked(!originalImage);
      await expect(
        dialog.getByRole('button', { name: '채팅 설정 저장', exact: true })
      ).toBeDisabled();
      await selectChatSettingsSection(page, '프롬프트·모델');
      await expect(
        dialog.getByRole('combobox', { name: '이 채팅의 본문 모델', exact: true })
      ).toBeVisible();
      await expect(
        dialog.getByRole('combobox', { name: '이 채팅의 작문 프롬프트', exact: true })
      ).toBeVisible();
      await selectChatSettingsSection(page, '기억·로어');
      await expect(dialog.getByLabel('조회 로어 문자 한도', { exact: true })).toHaveValue('');
      await expect(dialog.getByLabel('Jev 관련성 기준', { exact: true })).toHaveValue('0.7');
      await dialog.getByLabel('조회 로어 문자 한도', { exact: true }).fill('48000');
      await page.screenshot({ path: info.outputPath(`chat-memory-${viewport.width}.png`) });
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/chats/${chat.id}/profile`) &&
          response.request().method() === 'PUT'
      );
      await dialog.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
      expect((await saved).ok()).toBe(true);
      const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
      expect(detail.profile.loreContext.judgment.threshold).toBe(0.7);
      expect(detail.profile.image).toBe(!originalImage);
      expect(detail.runs).toHaveLength(0);
      expect(
        await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      ).toBeLessThanOrEqual(1);
    });

    test('CHATREC02 variable rows preserve empty strings, raw drafts, conflicts and uncertain save receipts', async ({
      page,
      request,
    }, info) => {
      test.setTimeout(60000);
      const chat = await fixture(request);
      const endpoint = `/api/chats/${chat.id}/variables`;
      let dialog = await open(page, chat.id);
      await selectChatSettingsSection(page, '카드 변수');
      const value = (key: string) => dialog.getByLabel(`${key} 문자열 값`, { exact: true });
      await expect(value('trust')).toHaveValue('40');
      await value('trust').fill('');
      await value('location').fill('garden');
      await dialog.getByLabel('location 재정의 해제', { exact: true }).click();
      await expect(value('location')).toHaveValue('reading_room');
      await dialog.getByRole('button', { name: 'JSON 편집', exact: true }).click();
      const raw = dialog.getByLabel('공유 변수 재정의 · JSON', { exact: true });
      expect(JSON.parse(await raw.inputValue())).toEqual({ trust: '' });
      await raw.fill('{"trust":');
      await selectChatSettingsSection(page, '기억·로어');
      await selectChatSettingsSection(page, '카드 변수');
      await expect(raw).toHaveValue('{"trust":');
      await expect(dialog.getByRole('button', { name: '행 편집', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
      await page.reload();
      await openChatSettings(page);
      dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
      await selectChatSettingsSection(page, '카드 변수');
      await expect(raw).toHaveValue('{"trust":');
      await raw.fill('{"trust":""}');
      await dialog.getByRole('button', { name: '행 편집', exact: true }).click();
      await expect(value('trust')).toHaveValue('');
      await page.screenshot({ path: info.outputPath(`chat-variables-${viewport.width}.png`) });
      // A concurrent edit must not be silently overwritten by the row projection.
      const initial = await (await request.get(endpoint)).json();
      const concurrent = await request.put(endpoint, {
        data: {
          expectedRevision: initial.revision,
          expectedSourceHash: initial.sourceHash,
          idempotencyKey: randomUUID(),
          values: { trust: 'concurrent' },
        },
      });
      expect(concurrent.ok(), await concurrent.text()).toBe(true);
      await dialog.getByRole('button', { name: '공유 변수 저장', exact: true }).click();
      await expect(
        dialog.getByText(
          '서버의 변수 개정이나 현재 원문이 바뀌었어요. 입력한 초안은 그대로 보존했어요.',
          { exact: true }
        )
      ).toBeVisible();
      await expect(value('trust')).toHaveValue('');
      await dialog
        .getByRole('button', { name: '최신 상태 기준으로 초안 유지', exact: true })
        .click();
      const bodies: unknown[] = [];
      let loseResponse = true;
      await page.route(`**${endpoint}`, async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        bodies.push(route.request().postDataJSON());
        if (!loseResponse) return route.continue();
        loseResponse = false;
        const persisted = await route.fetch();
        expect(persisted.ok()).toBe(true);
        await route.fulfill({
          status: 503,
          json: { error: 'Synthetic lost response after commit' },
        });
      });
      await dialog.getByRole('button', { name: '공유 변수 저장', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: '저장 결과 확인', exact: true })
      ).toBeEnabled();
      await expect(value('trust')).toBeDisabled();
      await dialog.getByRole('button', { name: '저장 결과 확인', exact: true }).click();
      await expect(
        dialog.getByText('공유 변수를 저장했어요. 다음 생성부터 적용해요.', { exact: true })
      ).toBeVisible();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      const final = await (await request.get(endpoint)).json();
      expect(final.values).toEqual({ trust: '' });
      expect(final.resolved.location).toBe('reading_room');
      expect(
        await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
    });
  });
}
