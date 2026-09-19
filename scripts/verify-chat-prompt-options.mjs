import { runBrowserVerification } from './browser-verification.mjs';
await runBrowserVerification({
  name: 'chat-prompt-options',
  scope:
    'Native prompt options shared across chats, explicit preset application and draft/CAS preservation',
  timeout: 120000,
  files: ['tests/prompt-workspace-browser.spec.ts'],
  requiredCases: ['PWS01', 'PWS02', 'PWS03'],
});
