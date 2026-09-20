import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'chat-backup',
  scope:
    'Complete per-chat backup, repeated new-chat restoration, single-response clipboard and compact archive controls',
  files: ['tests/chat-backup-browser.spec.ts', 'tests/archive-compact-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'Restoration uses only synthetic local chats; no live provider or user database is accessed.',
  ],
});
