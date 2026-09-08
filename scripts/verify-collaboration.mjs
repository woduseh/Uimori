import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'collaboration',
  scope: 'Custom writing advisors: saved prompt configuration, API preview and responsive editing',
  files: ['tests/agent-collaboration-browser.spec.ts'],
  requiredCases: ['AGENTUI01', 'AGENTUI02'],
  requiredScreenshots: ['agent-collaboration-mobile.png', 'agent-collaboration-desktop.png'],
  expectedCount: 2,
});
