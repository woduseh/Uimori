import { runBrowserVerification } from './browser-verification.mjs';
await runBrowserVerification({
  name: 'prompts',
  prefix: 'native-prompts',
  scope: 'Native RISUP import, editing, prompt/model separation and current option autosave',
  files: ['tests/risu-preset-import-browser.spec.ts', 'tests/prompt-workspace-browser.spec.ts'],
  timeout: 180000,
  limitations: ['Synthetic browser evidence does not establish provider quality.'],
});
