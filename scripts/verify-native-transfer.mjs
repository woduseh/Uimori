import { runBrowserVerification } from './browser-verification.mjs';
await runBrowserVerification({
  name: 'native-transfer',
  prefix: 'native-transfer',
  scope:
    'Single native Risu import entry, synthetic bot/persona card import, new-chat navigation, and module library registration',
  files: ['tests/native-transfer-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'Synthetic Risu card JSON and module JSON only; no charx/risum browser upload, private source execution, live provider, or physical-device proof.',
  ],
});
