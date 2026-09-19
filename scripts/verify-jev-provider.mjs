import { runBrowserVerification } from './browser-verification.mjs';

// This isolated credential UI test starts unconfigured, regardless of the developer's environment.
delete process.env.TYPESAFE_API_KEY;

await runBrowserVerification({
  name: 'jev-provider',
  scope: 'JEV connection settings, server-local credentials and synthetic diagnostic UI',
  files: ['tests/jev-provider-browser.spec.ts'],
  requiredCases: ['JEVUI01', 'JEVUI02', 'JEVUI03'],
  requiredScreenshots: [
    'jev-connection-mobile.png',
    'jev-connection-desktop.png',
    'jev-test-success-mobile.png',
    'jev-test-success-desktop.png',
    'jev-test-auth-error-mobile.png',
  ],
  timeout: 180000,
  limitations: [
    'Credential save, conflict and removal use the isolated real backend. Diagnostic kickoff and result endpoints are browser-intercepted synthetic receipts; this run never calls TypeSafe or verifies a real API key.',
  ],
});
