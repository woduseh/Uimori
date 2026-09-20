import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'package-ui',
  scope: 'Native Risu card and RISUP import synthetic isolated browser smoke',
  timeout: 300000,
  files: ['tests/risu-preset-import-browser.spec.ts', 'tests/risu-import-browser.spec.ts'],
});
