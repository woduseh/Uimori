import { runBrowserVerification } from './browser-verification.mjs';
import widths from '../fixtures/browser-viewports.json' with { type: 'json' };

await runBrowserVerification({
  name: 'diagnostics',
  scope:
    'Privacy-minimized report preview/download from settings and a Run; original local Inspector preservation; synthetic data only',
  files: ['tests/diagnostic-report-browser.spec.ts'],
  requiredCases: ['DIAG01', 'DIAG02'],
  expectedCount: 4,
  requiredScreenshots: [`diagnostics-${widths.mobile}.png`, `diagnostics-${widths.desktop}.png`],
  limitations: [
    'No real provider, private database, external upload, server log collection or detailed tracing.',
  ],
});
