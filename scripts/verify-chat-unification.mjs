import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'chat-unification',
  scope:
    'Shared main/helper composer, durable retry ordering, inline editing and diagnostic access',
  timeout: 240000,
  files: [
    'tests/chat-composer-browser.spec.ts',
    'tests/helper-browser.spec.ts',
    'tests/helper-sessions-browser.spec.ts',
    'tests/run-retry-browser.spec.ts',
    'tests/request-edit-browser.spec.ts',
    'tests/loading-browser.spec.ts',
  ],
  grep: 'shared composer|HELPUI|HSESSION|failed request edit|independent failed requests|REDIT01|RINFO01|LOADUI05',
  requiredCases: [
    'HELPUI01',
    'HELPUI02',
    'HELPUI03',
    'HELPUI04',
    'HELPUI05',
    'HELPUI06',
    'HELPUI07',
    'HSESSION01',
    'HSESSION02',
    'HSESSION03',
    'REDIT01',
    'RINFO01',
    'LOADUI05',
  ],
  requiredTitles: [
    'shared composer preserves Korean composition and Shift+Enter without sending',
    'shared composer grows at narrow widths and resets after clearing',
    'shared composer shrinks nonempty drafts in main and helper without width oscillation',
    'failed request edit, draft protection and uncertain retry reuse one admission',
    'independent failed requests retain their positions when a later request succeeds',
  ],
  limitations: [
    'Helper browser responses are synthetic projections; durable helper retry is also covered by SQLite unit tests.',
  ],
});
