import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'outline',
  scope:
    'Composition workspace: skipped levels, scoped helper selection, deterministic briefs, continuation, recovery and read-only review at 390/1440px; synthetic provider only',
  files: ['tests/outline-browser.spec.ts'],
});
