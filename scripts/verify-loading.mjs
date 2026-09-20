import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'loading',
  prefix: 'loading-ui',
  scope:
    'Reader paging, scene navigation, scroll restore, CAS tabs and library exact revision loading',
  files: ['tests/loading-browser.spec.ts'],
  limitations: [
    'LOADUI07 projects 65 synthetic navigation entries over two stored fixture sources; off-page synthetic entries do not establish server paging.',
  ],
  timeout: 180000,
});
