import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'narrative-themes',
  scope:
    'Cinematic, Letter and Scrapbook layouts: independent palettes, real synthetic portraits, long prose, light/dark responsive reading, controls and fallback',
  files: ['tests/narrative-themes-browser.spec.ts'],
  privateMaterials: Boolean(process.env.UIMORI_NARRATIVE_DEMO_DIR),
});
