import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'edit-drafts',
  scope: `Shared editing drafts, incomplete JSON restoration, concurrent helper edits and reviewed undo at ${MOBILE_WIDTH}/${DESKTOP_WIDTH}px`,
  files: ['tests/edit-drafts-browser.spec.ts'],
  requiredCases: ['ED01', 'ED02'],
});
