import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'story-ui',
  scope:
    'Story UI chat settings, source/translation rendering, streaming retention, native Risu coexistence and real action admission',
  files: [
    'tests/chat-generation-defaults-browser.spec.ts',
    'tests/story-ui-browser.spec.ts',
    'tests/story-ui-settings-browser.spec.ts',
    'tests/story-ui-theme-browser.spec.ts',
    'tests/risu-message-surface-browser.spec.ts',
    'tests/reading-markdown-browser.spec.ts',
  ],
  limitations: [
    'Synthetic model responses and isolated local databases; real-provider UI composition and long-form quality are not evaluated.',
  ],
});
