import { expect, test } from '@playwright/test';
import type { RisuImportResult } from '../core/risu-import.js';
import { navigationAction } from './ui-navigation.js';

for (const width of [390, 1440]) {
  test(`RISULUACOMPAT ${width}px authored form reaches Lua and survives reload`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const title = `폼 호환 ${crypto.randomUUID()}`;
    const opening = `<section style="max-width:32rem;padding:12px">
<h2>작은 이야기의 주인공</h2>
<form risu-form="profile">
<p><label>닉네임 <input name="nickname" required></label></p>
<p><label><input type="checkbox" name="interest" value="독서">독서</label>
<label><input type="checkbox" name="interest" value="산책">산책</label></p>
<button type="submit" name="decision" value="apply">작성 적용</button>
</form>
<p id="summary">결과: {{getvar::summary}}</p>
<button risu-trigger="remember" risu-id="카드-버튼">선택 요소 기억</button>
<p id="remembered">요소: {{getvar::remembered}}</p>
</section>`;
    const document = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: title,
        description: 'Synthetic form compatibility fixture',
        first_mes: opening,
        extensions: {
          risuai: {
            defaultVariables: 'summary=대기\nremembered=없음\nsubmissions=0',
            triggerscript: [
              {
                type: 'start',
                effect: [
                  {
                    type: 'triggerlua',
                    code: `function onFormSubmit(id, name, payload)
  local form = json.decode(payload).data
  setChatVar(id, 'submissions', tonumber(getChatVar(id, 'submissions')) + 1)
  setChatVar(id, 'submitted', payload)
  setChatVar(id, 'summary', name .. ': ' .. form.nickname .. ' / ' .. table.concat(form.interest, ', ') .. ' / ' .. form.decision)
  reloadDisplay(id)
end
function remember(id)
  setChatVar(id, 'remembered', cbs('{{trigger_id}}'))
  reloadDisplay(id)
end`,
                  },
                ],
              },
            ],
          },
        },
      },
    };
    await page.goto('/');
    await navigationAction(page, '봇');
    await page.getByRole('button', { name: '자료 가져오기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
    await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
      name: 'lua-form.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(document)),
    });
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await dialog.getByRole('checkbox', { name: '가져온 뒤 새 채팅도 만들기' }).check();
    const applying = page.waitForResponse((response) =>
      response.url().endsWith('/api/risu-imports/apply')
    );
    await dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true }).click();
    const applied = await applying;
    expect(applied.ok(), await applied.text()).toBe(true);
    const imported = (await applied.json()) as RisuImportResult;
    const chatId = imported.chat!.id;
    const surface = page.locator('.risu-message-surface').last();
    await expect(surface.locator('#summary')).toHaveText('결과: 대기');
    await surface.getByRole('textbox', { name: '닉네임' }).fill('별을 읽는 재연');
    await surface.getByRole('checkbox', { name: '독서', exact: true }).check();
    await surface.getByRole('checkbox', { name: '산책', exact: true }).check();
    const submissions: Record<string, unknown>[] = [];
    await page.route('**/risu-action', async (route) => {
      const body = route.request().postDataJSON();
      if (body.kind !== 'form') return route.continue();
      submissions.push(body);
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      if (submissions.length === 1)
        await route.fulfill({ status: 503, json: { error: 'Synthetic lost form response' } });
      else await route.fulfill({ response });
    });
    const submitting = page.waitForResponse((response) => response.url().endsWith('/risu-action'));
    await surface.getByRole('button', { name: '작성 적용', exact: true }).click();
    const submitted = await submitting;
    expect(submitted.status()).toBe(503);
    expect(submitted.request().postDataJSON()).toMatchObject({
      kind: 'form',
      name: 'profile',
      data: { nickname: '별을 읽는 재연', interest: ['독서', '산책'], decision: 'apply' },
    });
    await expect(surface.locator('#summary')).toHaveText(
      '결과: profile: 별을 읽는 재연 / 독서, 산책 / apply'
    );
    const variables = async () => (await request.get(`/api/chats/${chatId}/variables`)).json();
    expect((await variables()).values.submissions).toBe('1');
    // An unconfirmed form must not prevent a different authored choice from running.
    await surface.getByRole('button', { name: '선택 요소 기억', exact: true }).click();
    await expect(surface.locator('#remembered')).toHaveText('요소: 카드-버튼');
    // The successful server state may arrive over SSE despite the lost HTTP response.
    // Retrying must reuse the captured revision and key instead of executing the form again.
    await surface.getByRole('textbox', { name: '닉네임' }).fill('별을 읽는 재연');
    await surface.getByRole('checkbox', { name: '독서', exact: true }).check();
    await surface.getByRole('checkbox', { name: '산책', exact: true }).check();
    const confirming = page.waitForResponse((response) => response.url().endsWith('/risu-action'));
    await surface.getByRole('button', { name: '작성 적용', exact: true }).click();
    const confirmed = await confirming;
    expect(confirmed.ok(), await confirmed.text()).toBe(true);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect((await variables()).values.submissions).toBe('1');
    await expect(surface.locator('.risu-message-content')).toHaveAttribute(
      'data-risu-disabled',
      'false'
    );
    await page.reload();
    await expect(surface.locator('#summary')).toHaveText(
      '결과: profile: 별을 읽는 재연 / 독서, 산책 / apply'
    );
    await expect(surface.locator('#remembered')).toHaveText('요소: 카드-버튼');
    expect((await variables()).values.submissions).toBe('1');
    const contentId = imported.receipt.items.find((item) => item.root)!.id;
    const content = await (await request.get(`/api/content/${contentId}`)).json();
    expect(content.package.nativeRisu.card.first_mes).toBe(opening);
    await page.screenshot({ path: info.outputPath(`risu-lua-form-${width}.png`) });
  });
}
