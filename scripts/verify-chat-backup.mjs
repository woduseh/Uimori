import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'chat-backup',
  scope: 'Independent chat backup, fresh-copy restoration, ordinary saves and local recovery',
  files: ['tests/personal-workspace-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'Restoration uses only synthetic local chats; no live provider or user database is accessed.',
  ],
});
