import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'chat-prompt-options',
  scope:
    'Synthetic chat creative option panel, explicit persistence, draft safety, CAS and responsive layout',
  timeout: 120000,
  files: ['tests/chat-prompt-options-browser.spec.ts', 'tests/product-browser.spec.ts'],
  grep: 'chat creative options|creative option CAS|P01 package',
  requiredCases: ['P01'],
  requiredTitles: [
    'chat creative options preserve drafts, apply explicitly and fit desktop/mobile',
    'creative option CAS conflict preserves draft and server profile',
  ],
});
