import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'deletion',
  scope: 'Deletion workflows and related synthetic browser regression',
  providerFixture: true,
  files: ['tests/deletion-browser.spec.ts', 'tests/organization-browser.spec.ts'],
});
