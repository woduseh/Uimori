import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'deletion',
  scope: 'Deletion workflows and related synthetic browser regression',
  providerFixture: true,
  files: [
    'tests/deletion-browser.spec.ts',
    'tests/organization-browser.spec.ts',
    'tests/prompt-unified-browser.spec.ts',
  ],
  requiredCases: ['DEL01', 'DEL02', 'DEL03', 'DEL04', 'DEL05', 'DEL06', 'ORG01'],
});
