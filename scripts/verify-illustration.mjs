import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'illustration',
  prefix: 'illustration-ui',
  scope:
    'Synthetic scene illustrations: manual request from the scene menu, completed image display, failure retry, deletion, settings save and reload persistence',
  files: ['tests/illustration-browser.spec.ts'],
  requiredCases: ['ILUI01', 'ILUI02'],
  requiredScreenshots: ['illustration-desktop.png', 'illustration-settings-mobile.png'],
  timeout: 180000,
  limitations: [
    'The synthetic generator returns a fixed PNG; no Codex or ComfyUI call, image quality or reference fidelity is verified here.',
  ],
});
