import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'personal-features',
  scope:
    'Verified backups, manuscript search and semantic reader navigation on desktop and mobile using isolated synthetic data',
  files: ['tests/personal-features-browser.spec.ts'],
});
