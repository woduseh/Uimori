import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'prompts',
  prefix: 'prompt-editor',
  scope:
    'Unified prompt editing, collapse preservation, native import and immutable prompt revisions',
  files: [
    'tests/prompt-unified-browser.spec.ts',
    'tests/prompt-error-browser.spec.ts',
    'tests/prompt-actions-browser.spec.ts',
    'tests/prompt-library-refinements-browser.spec.ts',
    'tests/prompt-redesign-browser.spec.ts',
    'tests/prompt-editor-browser.spec.ts',
    'tests/ui-browser.spec.ts',
  ],
  grep: 'PAUI|PUNI|PERR|PLR03|PRUI01|NUI01|UI17',
  requiredCases: [
    'PUNI01',
    'PUNI02',
    'PUNI03',
    'PERR01',
    'PERR02',
    'PLR03',
    'PRUI01',
    'NUI01',
    'UI17',
  ],
  requiredScreenshots: [
    'prompt-collapsed-desktop.png',
    'prompt-collapsed-mobile.png',
    'prompt-structure-mobile.png',
  ],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
