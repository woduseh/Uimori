import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'risu-lua-compat',
  scope: 'Native Risu forms, action receipts and reader control compatibility',
  files: [
    'tests/risu-lua-compat-browser.spec.ts',
    'tests/risu-message-surface-browser.spec.ts',
    'tests/risu-native-frame-browser.spec.ts',
  ],
});
