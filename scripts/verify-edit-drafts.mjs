import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'edit-drafts',
  scope:
    'Shared editing drafts, incomplete JSON restoration, concurrent helper edits and reviewed undo at 390/1440px',
  files: ['tests/edit-drafts-browser.spec.ts'],
  requiredCases: ['ED01', 'ED02'],
});
