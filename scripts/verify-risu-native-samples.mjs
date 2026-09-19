import { runBrowserVerification } from './browser-verification.mjs';

if (!process.env.NR_RISU_SAMPLE_ROOT)
  throw new Error('NR_RISU_SAMPLE_ROOT is required for explicit private-card verification.');
if (process.env.NR_RISU_SAMPLE_DIAGNOSTIC === '1')
  throw new Error('Diagnostic partial imports cannot produce an acceptance receipt.');

await runBrowserVerification({
  name: 'risu-native-samples',
  scope:
    'Opt-in actual local CHARX UI import, original first-message controls, selected variables, reload and branch isolation, then a synthetic loopback writing turn with the selected native state.',
  files: ['tests/risu-native-samples-browser.spec.ts'],
  requiredCases: ['RISUSAMPLE01', 'RISUSAMPLE02', 'RISUSAMPLE03'],
  privateMaterials: true,
  timeout: 900000,
  limitations: [
    'Three selected local cards and their initial scenario paths only; this is not an exhaustive compatibility claim for every script or scenario.',
    'The writing model is a deterministic local fixture. Real-provider output, creative quality and semantic memory quality are not evaluated.',
  ],
});
