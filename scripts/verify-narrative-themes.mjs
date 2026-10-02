import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'narrative-themes',
  scope:
    'Cinematic, Letter and Scrapbook layouts: independent palettes, real synthetic portraits, bounded long-prose scene scrolling, request personas, light/dark responsive reading, controls and fallback',
  files: ['tests/narrative-themes-browser.spec.ts', 'tests/theme-body-scroll-browser.spec.ts'],
  privateMaterials: Boolean(process.env.UIMORI_NARRATIVE_DEMO_DIR),
});
