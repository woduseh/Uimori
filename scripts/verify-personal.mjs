import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'personal-workspace',
  scope:
    'Ordinary saves, raw JSON, device recovery, image metadata, direct API keys and independent chat backup',
  files: ['tests/personal-workspace-browser.spec.ts'],
  timeout: 240000,
});
