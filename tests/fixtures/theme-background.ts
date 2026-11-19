import { expect, type APIRequestContext } from '@playwright/test';
import sharp from 'sharp';
import type { ThemeBackground } from '../../core/theme-background.js';
import { defaultThemeBackground } from '../../core/theme-background.js';
import type { ThemeCatalog } from '../../core/themes.js';

export async function setGlobalBackgroundImage(request: APIRequestContext) {
  const before = (await (await request.get('/api/themes')).json()) as ThemeCatalog;
  const bytes = await sharp({
    create: { width: 64, height: 40, channels: 3, background: '#73a7ab' },
  })
    .png()
    .toBuffer();
  const blob = await request.post('/api/package-image-blobs', {
    data: { base64: bytes.toString('base64') },
  });
  expect(blob.ok(), await blob.text()).toBe(true);
  const { hash } = (await blob.json()) as { hash: string };
  const background: ThemeBackground = {
    ...(before.preferences.defaultBackground ?? defaultThemeBackground),
    imageHash: hash,
  };
  const saved = await request.post('/api/themes/background', {
    data: { scope: 'global', background, expectedRevision: before.preferences.revision },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return before.preferences.defaultBackground ?? null;
}

export async function restoreGlobalBackground(
  request: APIRequestContext,
  background: ThemeBackground | null
) {
  const current = (await (await request.get('/api/themes')).json()) as ThemeCatalog;
  const restored = await request.post('/api/themes/background', {
    data: { scope: 'global', background, expectedRevision: current.preferences.revision },
  });
  expect(restored.ok(), await restored.text()).toBe(true);
}
