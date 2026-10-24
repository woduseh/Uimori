import { expect, test, type Locator } from '@playwright/test';
import { BUILTIN_PALETTES } from '../core/theme-palettes.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function expectReadableText(locator: Locator, description: string) {
  await expect(locator).toBeVisible();
  const contrast = await locator.evaluate((element) => {
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const blend = (foreground: number[], background: number[]) => {
      const alpha = foreground[3] ?? 1;
      return foreground
        .slice(0, 3)
        .map((channel, i) => channel * alpha + background[i] * (1 - alpha));
    };
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement)
      ancestors.unshift(current);
    let background = [255, 255, 255];
    for (const ancestor of ancestors)
      background = blend(rgb(getComputedStyle(ancestor).backgroundColor), background);
    const foreground = blend(rgb(getComputedStyle(element).color), background);
    const luminance = (channels: number[]) => {
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const values = [luminance(foreground), luminance(background)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
  expect(contrast, description).toBeGreaterThanOrEqual(4.5);
}

test('COLOR selected mobile language and avatar text stay readable in every built-in palette', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 412, height: 844 });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'system'));
  const created = await postFixtureChat(request, { data: { title: '선택 색상 검증' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const before = await (await request.get('/api/themes')).json();
  const layout = await request.post('/api/themes/selection', {
    data: {
      scope: 'global',
      themeId: 'builtin:forest',
      expectedRevision: before.preferences.revision,
    },
  });
  expect(layout.ok()).toBe(true);
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill('팔레트를 바꿔도 이 요청과 선택한 언어를 유지해요.');
  const menu = page.locator('.input-translation-language-mobile');
  const trigger = menu.locator('summary');
  await trigger.click();
  await menu.getByRole('button', { name: '일본어', exact: true }).click();
  await expect(trigger).toHaveText('JA');
  await expect(trigger).toBeFocused();
  await trigger.click();
  const selected = menu.locator('button[aria-pressed="true"]');
  await expect(selected).toHaveText('일본어');
  await expect(selected).toHaveCSS('font-size', '14px');

  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
    for (const palette of BUILTIN_PALETTES) {
      const catalog = await (await request.get('/api/themes')).json();
      const changed = await request.post('/api/themes/selection', {
        data: {
          dimension: 'palette',
          scope: 'global',
          paletteId: palette.id,
          expectedRevision: catalog.preferences.revision,
        },
      });
      expect(changed.ok()).toBe(true);
      await page.evaluate(() => dispatchEvent(new Event('uimori-themes-changed')));
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      await expect
        .poll(() =>
          page
            .locator('html')
            .evaluate((root) => getComputedStyle(root).getPropertyValue('--accent').trim())
        )
        .toBe(palette.colors[mode].accent);
      await expectReadableText(selected, `${palette.id} ${mode}: selected language`);
      await selected.hover();
      await expectReadableText(selected, `${palette.id} ${mode}: hovered selected language`);
      const avatar = page.locator('.content-avatar').filter({ visible: true }).first();
      await expectReadableText(avatar, `${palette.id} ${mode}: avatar initial`);
      await expect(menu).toHaveAttribute('open', '');
      await expect(selected).toHaveText('일본어');
      await expect(composer).toHaveValue('팔레트를 바꿔도 이 요청과 선택한 언어를 유지해요.');
      if (palette.id === 'forest')
        await page.screenshot({ path: info.outputPath(`selected-language-${mode}.png`) });
    }
  }
  await selected.press('Escape');
  await expect(menu).not.toHaveAttribute('open');
  await expect(trigger).toBeFocused();
  expect((await (await request.get('/api/themes')).json()).themes).toEqual(before.themes);
});

test('COLOR selected outline and illustration labels retain readable text and accent symbols', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'light'));
  const catalog = await (await request.get('/api/themes')).json();
  const changed = await request.post('/api/themes/selection', {
    data: {
      dimension: 'palette',
      scope: 'global',
      paletteId: 'forest',
      expectedRevision: catalog.preferences.revision,
    },
  });
  expect(changed.ok()).toBe(true);
  const created = await postFixtureChat(request, { data: { title: '선택 문구 검증' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const saved = await request.post(`/api/chats/${chat.id}/outline`, {
    data: {
      idempotencyKey: crypto.randomUUID(),
      operations: [
        {
          op: 'create',
          level: 'episode',
          title: '선택한 회차',
          intent: '등장인물이 비밀을 발견해요.',
        },
      ],
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto(`/?chat=${chat.id}`);
  await page.locator('.chat-menu').getByLabel('채팅 메뉴').click();
  await page
    .locator('.chat-menu .action-menu-body')
    .getByRole('button', { name: '계층형 구성', exact: true })
    .click();
  const outline = page.locator('.outline-navigation .outline-node-button');
  await outline.click();
  await expect(outline).toHaveAttribute('aria-current', 'true');
  await page.mouse.move(0, 0);
  await expectReadableText(outline.locator('.outline-title'), 'selected outline title');
  await outline.hover();
  await expectReadableText(outline.locator('.outline-title'), 'hovered selected outline title');
  await page.keyboard.press('Escape');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '삽화');
  for (const label of ['기본 생성 환경과 자동 생성 관리', '프리셋과 적용 범위 관리']) {
    const disclosure = page.getByText(label, { exact: true });
    if ((await disclosure.locator('..').getAttribute('open')) === null) await disclosure.click();
  }
  const preset = page.locator('.illustration-preset-card.selected');
  const badge = preset.locator('.illustration-preset-selected');
  await expectReadableText(badge, 'selected illustration badge');
  await expect(preset.locator('.illustration-preset-apply')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(badge.locator('svg')).toHaveCSS('color', 'rgb(42, 126, 59)');
  await page.screenshot({ path: info.outputPath('selected-illustration.png') });
});

test('COLOR disabled actions are neutral and dark dialogs separate from the reading background', async ({
  page,
  request,
}, info) => {
  await page.addInitScript(() => localStorage.setItem('uimori:theme', 'system'));
  // Each navigation discards this synthetic form without submitting backup settings.
  page.on('dialog', (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    return dialog.accept();
  });
  for (const selection of [
    { themeId: 'builtin:forest' },
    { dimension: 'palette', paletteId: 'forest' },
  ]) {
    const catalog = await (await request.get('/api/themes')).json();
    const changed = await request.post('/api/themes/selection', {
      data: { ...selection, scope: 'global', expectedRevision: catalog.preferences.revision },
    });
    expect(changed.ok()).toBe(true);
  }
  const created = await postFixtureChat(request, { data: { title: '조작부 색상 검증' } });
  expect(created.ok()).toBe(true);
  const chat = await created.json();
  const rgb = (hex: string) =>
    `rgb(${hex
      .slice(1)
      .match(/../g)!
      .map((value) => parseInt(value, 16))
      .join(', ')})`;
  for (const width of [412, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
      await page.goto(`/?chat=${chat.id}`);
      const colors = BUILTIN_PALETTES.find((palette) => palette.id === 'forest')!.colors[mode];
      const send = page.locator('.composer-dock .send-button');
      await expect(send).toBeDisabled();
      await expect(send).toHaveCSS('background-color', rgb(colors.surface));
      await expect(send).toHaveCSS('color', rgb(colors.muted));
      await navigationAction(page, '설정');
      await selectSettingsSection(page, '데이터 관리');
      const dialog = page.getByRole('dialog', { name: '설정', exact: true });
      await expect(dialog).toHaveCSS(
        'background-color',
        rgb(mode === 'dark' ? colors.panel : colors.bg)
      );
      const panel = page.getByRole('region', { name: '서버 자동 백업', exact: true });
      const save = panel.getByRole('button', { name: '백업 설정 저장', exact: true });
      const retention = panel.getByLabel('성공본 보관 개수');
      const original = await retention.inputValue();
      await expect(save).toBeDisabled();
      await expect(save).toHaveCSS('background-color', rgb(colors.surface));
      await expect(save).toHaveCSS('color', rgb(colors.muted));
      await expect(retention).toHaveCSS('border-top-color', rgb(colors['input-border']));
      await save.scrollIntoViewIfNeeded();
      const disabledBounds = await save.boundingBox();
      await page.screenshot({ path: info.outputPath(`neutral-disabled-${width}-${mode}.png`) });
      await retention.fill(original === '6' ? '7' : '6');
      await expect(save).toBeEnabled();
      await expect(save).toHaveCSS('background-color', rgb(colors.accent));
      await expect(save).toHaveCSS('color', rgb(colors['accent-ink']));
      const enabledBounds = await save.boundingBox();
      expect(enabledBounds!.width).toBe(disabledBounds!.width);
      expect(enabledBounds!.height).toBe(disabledBounds!.height);
    }
  }
});
