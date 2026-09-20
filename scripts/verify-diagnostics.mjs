import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'diagnostics',
  scope:
    'Privacy-minimized report preview/download from settings and a Run; original local Inspector preservation; synthetic data only',
  files: ['tests/diagnostic-report-browser.spec.ts'],
  limitations: [
    'No real provider, private database, external upload, server log collection or detailed tracing.',
  ],
});
