import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'personal-features',
  scope:
    'Verified backups, manuscript search, reading/bookmarks, numerical usage, cache-free PWA and explicit Push consent/navigation using isolated synthetic data',
  files: ['tests/personal-features-browser.spec.ts'],
});
