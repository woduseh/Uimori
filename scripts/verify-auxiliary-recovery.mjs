import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'auxiliary-recovery',
  scope: 'Synthetic translation failure diagnostics and retry recovery',
  timeout: 120000,
  files: ['tests/auxiliary-recovery-browser.spec.ts'],
  limitations: [
    'Failure projection and judgment action response are synthetic; no live provider calls.',
  ],
});
