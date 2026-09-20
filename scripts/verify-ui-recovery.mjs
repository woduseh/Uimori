import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'ui-recovery',
  scope:
    'Native authoring, saved CHARX/RISUP downloads, retired import UI and isolated message appearance at the selected desktop/mobile dimensions',
  files: [
    'tests/ui-recovery-browser.spec.ts',
    'tests/risu-native-frame-browser.spec.ts',
    'tests/risu-preset-import-browser.spec.ts',
    'tests/risu-import-browser.spec.ts',
    'tests/native-transfer-browser.spec.ts',
    'tests/new-story-browser.spec.ts',
    'tests/source-edit-focus-browser.spec.ts',
    'tests/reader-navigation-browser.spec.ts',
  ],
  timeout: 600000,
  requiredCases: [
    'RISUPRESETUI01',
    'RISUPRESETUI02',
    'RISUPRESETUI03',
    'RISUKINDUI01',
    'RISUKINDUI02',
    'NATIVEUI03',
    'NATIVEUI04',
    'NSUI01',
    'NSUI02',
    'C04E',
  ],
});
