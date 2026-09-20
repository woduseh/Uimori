import { runBrowserVerification } from './browser-verification.mjs';

// This isolated credential UI test starts unconfigured, regardless of the developer's environment.
delete process.env.TYPESAFE_API_KEY;

await runBrowserVerification({
  name: 'jev-provider',
  scope: 'JEV connection settings, server-local credentials and synthetic diagnostic UI',
  files: ['tests/jev-provider-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'Credential save, conflict and removal use the isolated real backend. Diagnostic kickoff and result endpoints are browser-intercepted synthetic receipts; this run never calls TypeSafe or verifies a real API key.',
  ],
});
