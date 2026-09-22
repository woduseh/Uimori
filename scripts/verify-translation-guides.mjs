import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'translation-guides',
  scope:
    'Bot-only translation guide editing, native JSON, literal preview, local draft recovery and responsive layout',
  files: ['tests/translation-guides-browser.spec.ts'],
});
