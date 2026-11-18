import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'loading',
  prefix: 'loading-ui',
  scope:
    'Reader paging, scene navigation, scroll restore, CAS tabs and library exact revision loading',
  files: ['tests/loading-browser.spec.ts'],
  timeout: 180000,
});
