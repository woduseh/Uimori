import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'composer-more',
  scope: 'Synthetic failed-request editing and uncertain request recovery',
  timeout: 120000,
  files: ['tests/run-retry-browser.spec.ts'],
  grep: 'failed request',
  requiredTitles: ['failed request edit, draft protection and uncertain retry reuse one admission'],
});
