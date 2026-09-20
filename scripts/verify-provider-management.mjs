import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'provider-management',
  scope: 'Provider management synthetic UI',
  providerFixture: true,
  files: ['tests/provider-management-browser.spec.ts'],
  timeout: 180000,
});
