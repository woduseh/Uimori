import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'evaluation',
  prefix: 'evaluation-ui',
  scope: 'Provider-neutral evaluation-tool opt-in and persisted role selection',
  files: ['tests/evaluation-browser.spec.ts'],
  timeout: 180000,
});
