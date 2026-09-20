import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'provider-management',
  scope: 'Provider management synthetic UI',
  providerFixture: true,
  files: ['tests/provider-management-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
