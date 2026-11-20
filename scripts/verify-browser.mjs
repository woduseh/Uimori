import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'browser',
  scope: 'Complete local synthetic browser regression',
  providerFixture: true,
  timeout: 3_600_000,
});
