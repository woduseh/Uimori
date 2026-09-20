import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'redesign',
  scope: 'Bot workspace and package redesign plus existing synthetic browser regression',
  providerFixture: true,
  // The complete browser suite needs a longer timeout than a focused feature run.
  timeout: 1_800_000,
});
