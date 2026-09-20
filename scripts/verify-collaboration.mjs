import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'collaboration',
  scope:
    'Custom writing advisors: saved prompt configuration, API preview and native prompt editing',
  files: ['tests/agent-collaboration-browser.spec.ts'],
});
