import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'ui',
  scope: 'Reader layout, editing, Markdown rendering and reading preferences in a local browser',
  files: ['tests/ui-browser.spec.ts', 'tests/reading-browser.spec.ts'],
});
