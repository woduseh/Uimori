import { expect, test, type APIRequestContext, type Page } from './fixtures/browser-test.js';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_HEIGHT } from './fixtures/browser-viewports.js';
import { editLibraryContent, selectEditorSection } from './ui-navigation.js';
import { expectCodeFieldValue } from './code-field.js';

const breakLua =
  "listenEdit('editDisplay', function(id, text) if string.find(text, 'BREAK') then error('deliberate draft failure') end return text end)";

async function seedBot(request: APIRequestContext, title: string, card: Record<string, unknown>) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      package: nativeContent({ name: title, description: '', ...card }),
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Content;
}

const referenceCard = {
  first_mes: '오늘 기분은 {{getvar::mood}}이고 {{getvar::missing}}도 있어요.',
  alternate_greetings: ['두 번째 인사 {{setvar::mood::bright}}'],
  character_book: {
    entries: [
      {
        keys: ['숲'],
        content: '숲의 분위기는 {{getvar::mood}}예요.',
        comment: '조용한 숲',
        enabled: true,
        insertion_order: 0,
      },
    ],
  },
  extensions: {
    risuai: {
      defaultVariables: 'mood=calm\nspare=1',
      toggles: 'rain=비 오는 날\nsnow=눈 오는 날',
      customScripts: [
        {
          comment: '비 표시',
          type: 'editdisplay',
          in: '비',
          out: '{{#when::toggle::rain}}🌧{{/when}}',
          flag: 'g',
          ableFlag: true,
        },
      ],
    },
  },
};

async function openBot(page: Page, title: string, section: string) {
  await page.goto('/');
  await page.getByTestId('library-panel').getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
  await selectEditorSection(page, section);
}

test('CBSREF01 variable uses expand, jump and add a missing default', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
  const title = `CBSREF01 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, referenceCard);
  await openBot(page, title, '변수와 토글 초기값');
  const references = page.getByRole('region', { name: '변수와 토글 사용처', exact: true });
  await expect(references).toBeVisible();
  const mood = references.locator('details', {
    has: page.locator('code', { hasText: /^mood$/u }),
  });
  await expect(mood.locator('summary')).toContainText('읽기 2');
  await expect(mood.locator('summary')).toContainText('쓰기 1');
  const spare = references.locator('details', {
    has: page.locator('code', { hasText: /^spare$/u }),
  });
  await expect(spare.locator('summary')).toContainText('읽는 곳 없음');
  const snow = references.locator('details', {
    has: page.locator('code', { hasText: /^snow$/u }),
  });
  await expect(snow.locator('summary')).toContainText('쓰지 않는 토글');
  await snow.locator('summary').click();
  await expect(snow).toContainText('사용처를 찾지 못함');
  await mood.locator('summary').click();
  await expect(mood.getByRole('button')).toHaveCount(3);

  await mood.getByRole('button').filter({ hasText: '대체 첫 메시지 1' }).click();
  const alternate = page.getByRole('textbox', { name: '대체 첫 메시지', exact: true });
  await expect(alternate).toBeFocused();
  await expectCodeFieldValue(alternate, referenceCard.alternate_greetings[0]!);
  await expect
    .poll(() =>
      alternate.evaluate(() => {
        const selection = document.getSelection();
        return selection?.toString() ?? '';
      })
    )
    .toBe('mood');

  await selectEditorSection(page, '변수와 토글 초기값');
  await mood.getByRole('button').filter({ hasText: '조용한 숲' }).click();
  const lore = page.getByRole('textbox', { name: '로어 본문', exact: true });
  await expect(lore).toBeFocused();
  await expectCodeFieldValue(lore, referenceCard.character_book.entries[0]!.content);

  await selectEditorSection(page, '변수와 토글 초기값');
  const missing = references.locator('.cbs-missing-defaults');
  await expect(missing).toContainText('missing');
  await missing.getByRole('button', { name: 'missing 기본값 추가', exact: true }).click();
  const defaults = page.getByRole('textbox', { name: '기본 변수', exact: true });
  await expect(defaults).toHaveValue('mood=calm\nspare=1\nmissing=');
  await expect(defaults).toBeFocused();
  await page.keyboard.type('없음');
  await expect(missing).toHaveCount(0);
});

async function openPreview(page: Page, title: string) {
  await openBot(page, title, '첫 메시지');
  const field = page.getByRole('textbox', { name: '기본 첫 메시지', exact: true });
  await expect(field).toHaveClass(/cm-content/u);
  return field;
}

const previewCard = {
  first_mes: '<p>{{char}}가 문을 열어요. 기분은 {{getvar::mood}}.</p>',
  extensions: {
    risuai: {
      defaultVariables: 'mood=calm',
      triggerscript: [
        { comment: '오류 검사', type: 'start', effect: [{ type: 'triggerlua', code: breakLua }] },
      ],
    },
  },
};

test('PREVIEW01 live first message preview updates and survives an evaluation error', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
  const title = `PREVIEW01 ${randomUUID().slice(0, 8)}`;
  await seedBot(request, title, previewCard);
  const field = await openPreview(page, title);
  const preview = page.getByRole('region', { name: '저장 전 미리보기', exact: true });
  await expect(preview).toContainText(`${title}가 문을 열어요. 기분은 calm.`);

  const requests: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST' && item.url().includes('/risu-preview')) requests.push(item.url());
  });
  await field.locator('.cm-line').last().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' 새 문장');
  await expect(preview).toContainText('새 문장');
  expect(requests.length).toBeLessThanOrEqual(2);

  await page.keyboard.type(' BREAK');
  await expect(preview.getByRole('alert')).toContainText('deliberate draft failure');
  await expect(preview).toContainText('새 문장');
  for (let i = 0; i < ' BREAK'.length; i++) await page.keyboard.press('Backspace');
  await expect(preview.getByRole('alert')).toHaveCount(0);

  await page.keyboard.type(' {{img::없는그림}}');
  await expect(preview.getByText(/미리보기에서 확인이 필요한 항목/u)).toBeVisible();
  await preview.getByText(/미리보기에서 확인이 필요한 항목/u).click();
  await expect(preview.getByRole('listitem')).toHaveText(
    '없는그림 에셋을 찾지 못해 표시하지 않았어요.'
  );
});
