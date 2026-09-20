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
  limitations: [
    'Helper browser responses are synthetic projections; durable helper retry is also covered by SQLite unit tests.',
  ],
});
