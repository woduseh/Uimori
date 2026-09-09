import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'request-edit',
  scope:
    'Inline request editing, cancellation, draft recovery and idempotent new-branch generation at mobile and desktop widths; synthetic provider only',
  files: ['tests/request-edit-browser.spec.ts', 'tests/settings-action-icons-browser.spec.ts'],
  requiredCases: ['REDIT01', 'RINFO01', 'SICON01'],
  expectedCount: 6,
});
