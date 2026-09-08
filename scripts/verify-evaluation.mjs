import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'evaluation',
  prefix: 'evaluation-ui',
  scope: 'Provider-neutral evaluation-tool opt-in and persisted role selection',
  files: ['tests/evaluation-browser.spec.ts'],
  requiredCases: ['EVALUI01', 'EVALUI02'],
  requiredScreenshots: [
    'evaluation-desktop-options.png',
    'evaluation-desktop-restored-roles.png',
    'evaluation-mobile-connection.png',
    'evaluation-mobile-options.png',
  ],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
