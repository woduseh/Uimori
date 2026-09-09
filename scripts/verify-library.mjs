import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'library',
  scope:
    'Library folders, role selection, portraits, prompt management and guarded deletion synthetic browser regression',
  providerFixture: true,
  files: [
    'tests/library-browser.spec.ts',
    'tests/library-images-browser.spec.ts',
    'tests/package-features-browser.spec.ts',
    'tests/shared-package-browser.spec.ts',
    'tests/deletion-browser.spec.ts',
  ],
  requiredCases: [
    'LIBUI01',
    'LIBUI02',
    'LIBUI03',
    'LIBUI04',
    'LIBUI05',
    'LIMG01',
    'LIMG02',
    'LIMG03',
    'LIMG04',
    'LIMG05',
    'DEL01',
  ],
});
