import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'browser',
  scope: 'Complete local synthetic browser regression',
  providerFixture: true,
  // The complete browser suite needs a longer timeout than a focused feature run.
  timeout: 1_800_000,
});
