import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'auxiliary-recovery',
  scope: 'Synthetic auxiliary failure diagnostics and explicit status recovery',
  timeout: 120000,
  files: ['tests/auxiliary-recovery-browser.spec.ts'],
  limitations: [
    'Failure projection and status action response are synthetic; no live provider calls.',
  ],
});
