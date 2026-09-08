import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'navigation',
  scope:
    'Compact bot navigation, folder ordering, deletion and activity synthetic browser regression',
  registrationFixture: true,
  files: [
    'tests/organization-browser.spec.ts',
    'tests/deletion-browser.spec.ts',
    'tests/activity-browser.spec.ts',
  ],
  requiredCases: ['ORG01', 'ORG02', 'ORG03', 'ORG04', 'DEL03'],
});
