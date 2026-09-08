import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'browser-smoke',
  scope: 'Core chat admission/generation and global prompt settings synthetic browser smoke',
  files: ['tests/product-browser.spec.ts', 'tests/prompt-workspace-browser.spec.ts'],
  grep: '\\b(?:P01|PWS01|PWS02)\\b',
  requiredCases: ['P01', 'PWS01', 'PWS02'],
  timeout: 120_000,
});
