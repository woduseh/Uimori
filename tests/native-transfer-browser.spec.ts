import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Content } from '../core/product.js';
import type { RisuImportResult } from '../core/risu-import.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { navigationAction } from './ui-navigation.js';

type BrowserArgs = { page: Page; request: APIRequestContext };

function atWidths(
  name: string,
  run: (args: BrowserArgs, width: number, info: TestInfo) => Promise<void>
) {
  for (const width of DEFAULT_WIDTHS)
    test(`${name} @ ${width}`, async ({ page, request }, info) => {
      await page.setViewportSize({ width, height: width <= 500 ? 915 : 1440 });
      await run({ page, request }, width, info);
    });
}

const card = (title: string) => ({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: title,
    description: 'Synthetic native import card.',
    personality: 'Calm and observant.',
    scenario: 'A synthetic browser verification.',
    first_mes: 'The imported opening.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: 'Uimori browser verification',
    character_version: '1',
    extensions: {},
    character_book: {
      name: 'Synthetic lore',
      description: '',
      scan_depth: 4,
      token_budget: 512,
      recursive_scanning: false,
      extensions: {},
      entries: [{ name: 'World', content: 'The sky is green.', constant: true, enabled: true }],
    },
  },
});

async function openImport(page: Page, tab: '봇' | '페르소나' | '모듈') {
  await navigationAction(page, tab);
  const trigger = page.getByRole('button', { name: '자료 가져오기', exact: true });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('가져올 자료 종류')).toHaveValue(
    tab === '봇' ? '' : tab === '페르소나' ? 'persona' : 'module'
  );
  return dialog;
}

async function savedRoot(request: APIRequestContext, result: RisuImportResult) {
  const root = result.receipt.items.find((item) => item.root)!;
  return (await (await request.get(`/api/content/${root.id}`)).json()) as Content;
}

atWidths(
  'NATIVEUI01 imports a Risu card as a bot and opens its authored first message',
  async ({ page, request }, width) => {
    const title = `NATIVEUI01 ${width} ${Date.now()}`;
    await page.goto('/');
    const dialog = await openImport(page, '봇');
    await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
      name: 'synthetic-risu-card.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(card(title))),
    });
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
    const applied = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/risu-imports/apply') && response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true }).click();
    const result = (await (await applied).json()) as RisuImportResult;
    expect(result.chat).not.toBeNull();
    await expect(dialog).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get('chat')).toBe(result.chat!.id);
    expect((await savedRoot(request, result)).kind).toBe('bot');
  }
);

atWidths(
  'NATIVEUI02 imports a Risu card as a persona without creating a chat',
  async ({ page, request }, width) => {
    const title = `NATIVEUI02 ${width} ${Date.now()}`;
    const beforeChats = await (await request.get('/api/chats')).json();
    await page.goto('/');
    const dialog = await openImport(page, '페르소나');
    await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
      name: 'synthetic-risu-persona.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(card(title))),
    });
    await expect(dialog.locator('.risu-import-hero small')).toHaveText('페르소나');
    const applied = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/risu-imports/apply') && response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '페르소나 가져오기', exact: true }).click();
    const result = (await (await applied).json()) as RisuImportResult;
    expect(result.chat).toBeNull();
    await expect(
      dialog.getByRole('status').filter({ hasText: '페르소나를 서재에 등록했어요.' })
    ).toBeVisible();
    expect((await savedRoot(request, result)).kind).toBe('persona');
    expect(await (await request.get('/api/chats')).json()).toHaveLength(beforeChats.length);
  }
);

atWidths(
  'NATIVEUI03 imports and exports a standalone Risu module',
  async ({ page, request }, width) => {
    const title = `NATIVEUI03 ${width} ${Date.now()}`;
    const beforeChats = await (await request.get('/api/chats')).json();
    const source = {
      type: 'risuModule',
      module: {
        id: 'synthetic-module',
        name: title,
        description: 'Synthetic module description.',
        lorebook: [
          {
            key: '',
            comment: 'Harbor setting',
            content: 'The harbor has blue lights.',
            mode: 'normal',
            alwaysActive: true,
            insertorder: 100,
          },
        ],
        regex: [],
        trigger: [],
      },
    };
    await page.goto('/');
    const dialog = await openImport(page, '모듈');
    await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
      name: 'synthetic-risu-module.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(source)),
    });
    const applied = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/risu-imports/apply') && response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '모듈 가져오기', exact: true }).click();
    const result = (await (await applied).json()) as RisuImportResult;
    expect(result.chat).toBeNull();
    expect((await savedRoot(request, result)).kind).toBe('module');
    expect(await (await request.get('/api/chats')).json()).toHaveLength(beforeChats.length);
    await dialog.getByRole('button', { name: '자료 가져오기 닫기', exact: true }).click();
    await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await page.locator('summary').filter({ hasText: '자료 메뉴' }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'RISUM 내보내기', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`${title}.risum`);
    const bytes = await readFile((await download.path())!);
    const decoded = readCharacterCard({
      name: download.suggestedFilename(),
      base64: bytes.toString('base64'),
    });
    expect((decoded.nativeModule as Record<string, unknown>).name).toBe(title);
  }
);

atWidths(
  'NATIVEUI04 exposes one native import entry in each library context',
  async ({ page }, width, info) => {
    await page.goto('/');
    await navigationAction(page, '봇');
    await page.screenshot({ path: info.outputPath(`native-transfer-entry-${width}.png`) });
    const dialog = await openImport(page, '봇');
    await page.screenshot({ path: info.outputPath(`native-transfer-modal-${width}.png`) });
    await dialog.getByRole('button', { name: '자료 가져오기 닫기', exact: true }).click();
    for (const tab of ['봇', '페르소나', '모듈'] as const) {
      await navigationAction(page, tab);
      await expect(page.getByRole('button', { name: '자료 가져오기', exact: true })).toHaveCount(1);
      await expect(
        page.getByRole('button', { name: '자료 파일 가져오기·내보내기', exact: true })
      ).toHaveCount(0);
    }
    await navigationAction(page, '프롬프트');
    await expect(page.getByRole('button', { name: '프롬프트 가져오기', exact: true })).toHaveCount(
      1
    );
    await expect(
      page.getByRole('button', { name: '자료 파일 가져오기·내보내기', exact: true })
    ).toHaveCount(0);
  }
);
