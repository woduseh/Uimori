import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'liquid-gallery',
  scope:
    'Liquid Gallery: opaque 2:3 and 1:1 portraits, 10k-token prose, original/translation, editing, copying, responsive layout and recovery',
  files: ['tests/liquid-gallery-browser.spec.ts'],
  privateMaterials: Boolean(process.env.UIMORI_GALLERY_DEMO_DIR),
});
