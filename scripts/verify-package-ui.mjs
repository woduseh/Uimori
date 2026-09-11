import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'package-ui',
  scope: 'Prompt editor and common package UI synthetic isolated browser smoke',
  timeout: 300000,
  files: [
    'tests/prompt-editor-browser.spec.ts',
    'tests/prompt-templates-browser.spec.ts',
    'tests/source-segments-browser.spec.ts',
    'tests/package-request-browser.spec.ts',
    'tests/package-features-browser.spec.ts',
  ],
  requiredCases: [
    'NUI01',
    'BPTUI01',
    'BPTUI02',
    'SEGMENTUI01',
    'SEGMENTUI02',
    'PREQUESTUI01',
    'PREQUESTUI02',
    'PFUI01',
    'PFUI02',
    'PFUI03',
  ],
});
