import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'ui-recovery',
  scope:
    'Native authoring, saved CHARX/RISUP downloads, retired import UI and isolated message appearance at the selected desktop/mobile dimensions',
  files: [
    'tests/ui-recovery-browser.spec.ts',
    'tests/chat-recovery-browser.spec.ts',
    'tests/chat-settings-browser.spec.ts',
    'tests/editor-leave-browser.spec.ts',
    'tests/bot-chat-import-browser.spec.ts',
    'tests/settings-compact-browser.spec.ts',
    'tests/agent-collaboration-browser.spec.ts',
    'tests/risu-native-frame-browser.spec.ts',
    'tests/risu-preset-import-browser.spec.ts',
    'tests/risu-import-browser.spec.ts',
    'tests/native-transfer-browser.spec.ts',
    'tests/native-lore-browser.spec.ts',
    'tests/new-story-browser.spec.ts',
    'tests/source-edit-focus-browser.spec.ts',
    'tests/reader-navigation-browser.spec.ts',
  ],
  timeout: 600000,
});
