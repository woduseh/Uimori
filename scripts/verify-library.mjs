import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'library',
  scope:
    'Library folders, role selection, portraits, prompt management and guarded deletion synthetic browser regression',
  providerFixture: true,
  files: [
    'tests/library-browser.spec.ts',
    'tests/library-compact-browser.spec.ts',
    'tests/library-images-browser.spec.ts',
    'tests/new-story-browser.spec.ts',
    'tests/personal-workspace-browser.spec.ts',
    'tests/deletion-browser.spec.ts',
  ],
});
