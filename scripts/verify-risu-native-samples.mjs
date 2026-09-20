import { runBrowserVerification } from './browser-verification.mjs';

if (!process.env.UIMORI_RISU_SAMPLE_ROOT)
  throw new Error('UIMORI_RISU_SAMPLE_ROOT is required for explicit private-card verification.');
if (process.env.UIMORI_RISU_SAMPLE_DIAGNOSTIC === '1')
  throw new Error('Diagnostic partial imports cannot produce an acceptance receipt.');

await runBrowserVerification({
  name: 'risu-native-samples',
  scope:
    'Opt-in actual local CHARX UI import, original first-message controls, desktop/mobile access, selected variables, reload and branch isolation, then a synthetic loopback writing turn. UIMORI_RISU_SAMPLE_PRESET optionally supplies the original local preset for the same turn.',
  files: ['tests/risu-native-samples-browser.spec.ts'],
  privateMaterials: true,
  timeout: 900000,
  limitations: [
    'Selected local cards and their initial scenario paths only; this is not an exhaustive compatibility claim for every script or scenario. The Vela sample has a short first message without authored buttons; its alternate greetings are covered by the separate local compatibility test.',
    'The writing model is a deterministic local fixture. Real-provider output, creative quality and semantic memory quality are not evaluated.',
  ],
});
