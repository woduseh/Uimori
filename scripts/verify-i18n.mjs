import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'i18n',
  scope:
    'Four UI languages, reader recovery, presentation-only switching and mobile accessible names using local synthetic fixtures',
  files: ['tests/i18n-browser.spec.ts'],
});
