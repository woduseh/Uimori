import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'settings-polish',
  scope:
    'Compact agent settings, illustration layout and seconds, reload failure and draft discard protection; related navigation regressions',
  files: [
    'tests/illustration-browser.spec.ts',
    'tests/provider-management-browser.spec.ts',
    'tests/settings-compact-browser.spec.ts',
    'tests/chat-settings-browser.spec.ts',
    'tests/library-browser.spec.ts',
    'tests/chat-prompt-options-browser.spec.ts',
    'tests/product-browser.spec.ts',
  ],
  grep: 'ILUI|PMUI10|PMUI11|SCUI|CSUI02|LIBUI03|chat creative options|P01 packages|P09 P10',
  requiredCases: [
    'ILUI01',
    'ILUI02',
    'ILUI03',
    'PMUI10',
    'PMUI11',
    'LIBUI03',
    'SCUI01',
    'SCUI02',
    'SCUI03',
    'CSUI02',
  ],
  providerFixture: true,
  timeout: 360000,
  limitations: [
    'Codex authentication and ComfyUI image generation are synthetic; no live account or external generator is used.',
  ],
});
