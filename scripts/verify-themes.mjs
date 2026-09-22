import { runBrowserVerification } from './browser-verification.mjs';
await runBrowserVerification({
  name: 'themes',
  scope:
    'Themes, color modes, custom HTML/CSS, portable theme files, author state preservation and recovery',
  files: ['tests/themes-browser.spec.ts', 'tests/risu-message-surface-browser.spec.ts'],
});
