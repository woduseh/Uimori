import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'auxiliary-recovery',
  scope: 'Synthetic auxiliary failure diagnostics and explicit status recovery at 390px',
  timeout: 120000,
  files: ['tests/auxiliary-recovery-browser.spec.ts'],
  requiredTitles: [
    'auxiliary failures show separate safe causes and recreate status with current settings',
  ],
  limitations: [
    'Failure projection and status action response are synthetic; no live provider calls.',
  ],
});
