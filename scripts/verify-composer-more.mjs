import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'composer-more',
  scope: 'Synthetic composer more menu, one-shot lore exclusion and uncertain request recovery',
  timeout: 120000,
  files: ['tests/lore-context-browser.spec.ts', 'tests/run-retry-browser.spec.ts'],
  grep: 'LCUI0[234]|failed request',
  requiredCases: ['LCUI02', 'LCUI03', 'LCUI04'],
  requiredTitles: ['failed request edit, draft protection and uncertain retry reuse one admission'],
  expectedCount: 4,
});
