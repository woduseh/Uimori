import { test, expect, type Locator } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { openChatMenu } from './ui-navigation.js';

test.use({ video: 'on' });

async function entered(surface: Locator, motion: 'no-preference' | 'reduce') {
  await settled(surface);
  if (motion === 'reduce') await expect(surface).not.toHaveAttribute('data-entrances');
  else await expect(surface).toHaveAttribute('data-entrances');
  const transition = await surface.evaluate((node) => {
    const style = getComputedStyle(node);
    return { duration: style.transitionDuration, easing: style.transitionTimingFunction };
  });
  if (motion === 'reduce') expect(transition.duration).toBe('0s');
  else {
    expect(transition.duration).toBe('0.15s, 0.15s');
    expect(transition.easing).toBe('ease-out, ease-out');
  }
}

async function settled(surface: Locator) {
  await expect(surface).toHaveCSS('animation-name', 'none');
  await expect.poll(() => surface.evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(surface).toHaveCSS('opacity', '1');
  await expect(surface).toHaveCSS('transform', 'none');
}

async function expectHairline(surface: Locator) {
  const border = await surface.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      token: style.getPropertyValue('--hairline').trim(),
      width: Number.parseFloat(style.borderTopWidth),
      style: style.borderTopStyle,
    };
  });
  expect(Number.parseFloat(border.token)).toBe(0.5);
  expect(border.style).toBe('solid');
  // https://drafts.csswg.org/css-values-4/#snap-as-a-line-width (2026-11-20): a border width greater
  // than zero but less than 1 device pixel rounds to 1 device pixel.
  expect(border.width).toBeGreaterThanOrEqual(0.5);
  expect(border.width).toBeLessThanOrEqual(1);
}

for (const [width, motion] of [
  [412, 'no-preference'],
  [1440, 'reduce'],
] as const) {
  test(`MOTION ${width} ${motion} menus, native dialogs and switches preserve interaction`, async ({
    page,
    request,
  }, info) => {
    const height = width === 412 ? 844 : 1000;
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: motion });
    const response = await postFixtureChat(request, { data: { title: '모션 검증용 서재' } });
    expect(response.ok()).toBe(true);
    const chat = await response.json();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByLabel('다음 장면 요청', { exact: true });
    await composer.fill('조작부를 열고 닫아도 남아야 하는 초안');
    await page.evaluate(() => {
      document.addEventListener('animationstart', (event) => {
        const node = event.target;
        if (node instanceof HTMLElement && node.matches('.app-dialog, .action-menu-body'))
          node.dataset.animations = String(Number(node.dataset.animations ?? 0) + 1);
      });
      document.addEventListener('transitionrun', (event) => {
        const node = event.target;
        if (
          node instanceof HTMLElement &&
          !event.pseudoElement &&
          event.propertyName === 'opacity' &&
          node.matches('.app-dialog, .action-menu-body, .composer-more-panel')
        )
          node.dataset.entrances = String(Number(node.dataset.entrances ?? 0) + 1);
      });
    });
    const trigger = page.locator('.chat-menu > summary');
    const menu = await openChatMenu(page);
    await expect(menu).toBeVisible();
    await entered(menu, motion);
    await expect(menu).not.toHaveAttribute('data-animations');
    await expectHairline(menu);
    await expect(menu.getByRole('button', { name: '읽기 설정', exact: true })).toHaveCSS(
      'font-size',
      '14px'
    );
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    if (width === 412) expect(box.y + box.height).toBeGreaterThanOrEqual(height - 24);
    await page.screenshot({ path: info.outputPath('menu.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    const more = page.getByRole('button', { name: '입력창 더보기', exact: true });
    await more.click();
    const composerMenu = page.locator('.composer-more-panel');
    await expect(composerMenu).toBeVisible();
    await entered(composerMenu, motion);
    const composerBox = (await composerMenu.boundingBox())!;
    expect(composerBox.x).toBeGreaterThanOrEqual(0);
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(width);
    expect(composerBox.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect(composerMenu).toHaveCount(0);
    await expect(more).toBeFocused();

    const openReading = async () => {
      const actions = await openChatMenu(page);
      await actions.getByRole('button', { name: '읽기 설정', exact: true }).click();
    };
    await openReading();
    const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
    await expect(dialog).toBeVisible();
    await entered(dialog, motion);
    await expect(dialog).not.toHaveAttribute('data-animations');
    await expectHairline(dialog);
    await expect(dialog.getByRole('heading', { name: '읽기 설정', exact: true })).toHaveCSS(
      'font-size',
      '18px'
    );
    const toggle = dialog.getByRole('switch', { name: '대사 줄바꿈', exact: true });
    await toggle.scrollIntoViewIfNeeded();
    const transition = await toggle.evaluate((node) => {
      const style = getComputedStyle(node, '::before');
      return {
        durations: style.transitionDuration.split(',').map(Number.parseFloat),
        easing: style.transitionTimingFunction.split(',').map((value) => value.trim()),
      };
    });
    expect(transition.durations.every((value) => value === (motion === 'reduce' ? 0 : 0.25))).toBe(
      true
    );
    if (motion === 'no-preference')
      expect(transition.easing.every((value) => value === 'ease-out')).toBe(true);
    const original = await toggle.isChecked();
    if (width === 412) {
      const target = (await toggle.boundingBox())!;
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await toggle.click({ position: { x: target.width / 2, y: 2 } });
      await expect(toggle).toBeChecked({ checked: !original });
      await toggle.click({ position: { x: target.width / 2, y: target.height - 2 } });
      await expect(toggle).toBeChecked({ checked: original });
    }
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked({ checked: !original });
    await expect(toggle).toHaveCSS('outline-style', 'solid');
    await expect(toggle).toHaveCSS('outline-width', '2px');
    await page.screenshot({ path: info.outputPath('reading-switch.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await openReading();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await openReading();
    await expect(toggle).toBeChecked({ checked: !original });
    await settled(dialog);
    await expect(dialog).not.toHaveAttribute('data-animations');
    await expect(menu).not.toHaveAttribute('data-animations');
    await toggle.setChecked(original);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue('조작부를 열고 닫아도 남아야 하는 초안');
    await composer.click();
    await expect(composer).toBeFocused();
    expect(errors).toEqual([]);
  });
}
