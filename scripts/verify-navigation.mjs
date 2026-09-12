import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'navigation',
  scope:
    'Compact bot navigation, folder ordering, deletion and activity synthetic browser regression',
  providerFixture: true,
  files: [
    'tests/organization-browser.spec.ts',
    'tests/deletion-browser.spec.ts',
    'tests/activity-browser.spec.ts',
    'tests/default-branch-browser.spec.ts',
  ],
  requiredScreenshots: [`bot-tree-${MOBILE_WIDTH}.png`, `bot-tree-${DESKTOP_WIDTH}.png`],
  requiredCases: [
    'ORG01',
    'ORG02',
    'ORG03',
    'ORG04',
    'ORG05',
    'ORG06',
    'ORG07',
    'DEL03',
    'BRANCH01',
    'BRANCH02',
    'WORKSPACE01',
  ],
});
