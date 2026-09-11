import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'loading',
  prefix: 'loading-ui',
  scope:
    'Reader paging, scene navigation, scroll restore, CAS tabs and library exact revision loading',
  files: ['tests/loading-browser.spec.ts'],
  requiredCases: [
    'LOADUI01',
    'LOADUI02',
    'LOADUI03',
    'LOADUI04',
    'LOADUI05',
    'LOADUI06',
    'LOADUI07',
    'LOADUI08',
    'LOADUI09',
    'LOADUI10',
  ],
  requiredScreenshots: [
    'loading-reader-page.png',
    'loading-cas.png',
    'loading-library.png',
    'loading-reconnected.png',
    'context-summary-mobile.png',
    'scene-navigator-desktop.png',
    'scene-navigator-mobile.png',
  ],
  limitations: [
    'LOADUI07 projects 65 synthetic navigation entries over two stored fixture sources; off-page synthetic entries do not establish server paging.',
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
  timeout: 180000,
});
