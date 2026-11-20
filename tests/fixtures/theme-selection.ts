import { expect, type APIRequestContext } from '@playwright/test';
import {
  normalizeThemePreferences,
  type ThemeCatalog,
  type ThemePreferences,
} from '../../core/themes.js';

async function themeCatalog(request: APIRequestContext) {
  return (await (await request.get('/api/themes')).json()) as ThemeCatalog;
}

export async function restoreGlobalThemeSelection(
  request: APIRequestContext,
  baseline: ThemePreferences
) {
  for (const selection of [
    { themeId: baseline.defaultThemeId },
    { dimension: 'palette', paletteId: baseline.defaultPaletteId ?? null },
  ]) {
    const { preferences } = await themeCatalog(request);
    const restored = await request.post('/api/themes/selection', {
      data: { scope: 'global', ...selection, expectedRevision: preferences.revision },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  }
  const choice = (preferences: ThemePreferences) => {
    const normalized = normalizeThemePreferences(preferences);
    return { themeId: normalized.defaultThemeId, paletteId: normalized.defaultPaletteId };
  };
  expect(choice((await themeCatalog(request)).preferences)).toEqual(choice(baseline));
}
