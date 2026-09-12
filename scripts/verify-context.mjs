import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'context',
  scope:
    'Shared context summary edit/restore, author-note revision conflicts, draft retention, manual no-op and cancellation UI',
  files: ['tests/context-browser.spec.ts'],
  requiredCases: ['CTXUI01', 'CTXUI02', 'CTXUI03'],
  requiredScreenshots: [
    `context-summary-${MOBILE_WIDTH}.png`,
    `context-summary-${DESKTOP_WIDTH}.png`,
  ],
  expectedCount: 3,
  limitations: [
    'The running-job cancellation case uses a UI projection; durable cancellation and provider execution are verified separately.',
  ],
});
