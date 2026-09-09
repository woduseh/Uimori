import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'context',
  scope:
    'Shared context summary edit/restore, author-note revision conflicts, draft retention, manual no-op and cancellation UI',
  files: ['tests/context-browser.spec.ts'],
  requiredCases: ['CTXUI01', 'CTXUI02', 'CTXUI03'],
  requiredScreenshots: ['context-summary-390.png', 'context-summary-1440.png'],
  expectedCount: 3,
  limitations: [
    'The running-job cancellation case uses a UI projection; durable cancellation and provider execution are verified separately.',
  ],
});
