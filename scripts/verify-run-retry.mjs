import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'run-retry',
  scope: 'Synthetic failed-card UI with real fixture admission and lost-response recovery',
  timeout: 120000,
  files: ['tests/run-retry-browser.spec.ts'],
  requiredTitles: ['failed request edit, draft protection and uncertain retry reuse one admission'],
  limitations: ['Failure card injected into reader response; no live provider calls.'],
});
