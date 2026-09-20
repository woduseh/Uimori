import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'outline',
  scope:
    'Hierarchical composition: five levels, level rules, targeted edits and writing one designated unit at mobile and desktop widths; synthetic provider only',
  files: ['tests/outline-browser.spec.ts'],
});
