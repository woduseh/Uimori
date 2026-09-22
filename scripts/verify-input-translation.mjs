import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'input-translation',
  scope:
    'Manual composer translation, temporary undo, stale-result isolation, accepted-request recovery and raw request copying; existing request editing and reader recovery regressions',
  files: [
    'tests/input-translation-browser.spec.ts',
    'tests/request-edit-browser.spec.ts',
    'tests/reader-recovery-browser.spec.ts',
  ],
});
