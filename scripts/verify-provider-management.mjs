import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'provider-management',
  scope: 'Provider management synthetic UI',
  providerFixture: true,
  files: ['tests/provider-management-browser.spec.ts'],
  requiredCases: [
    'PMUI16',
    'PMUI01',
    'PMUI02',
    'PMUI03',
    'PMUI04',
    'PMUI10',
    'PMUI11',
    'PMUI12',
    'PMUI13',
    'PMUI14',
    'PMUI15',
  ],
  requiredScreenshots: [
    'provider-management-mobile-model.png',
    'provider-management-mobile-pricing.png',
    'provider-management-desktop-conflict.png',
    'provider-management-current-model.png',
    `endpoint-guidance-${MOBILE_WIDTH}.png`,
    `endpoint-guidance-${DESKTOP_WIDTH}.png`,
    'provider-management-current-readiness.png',
    'codex-subscription-settings-mobile.png',
    'provider-parameters-0-mobile.png',
    'provider-parameters-1-mobile.png',
    'provider-parameters-2-mobile.png',
    'provider-parameters-3-mobile.png',
    'provider-parameters-4-mobile.png',
    'provider-parameters-preserved-invalid-desktop.png',
    'provider-response-test-mobile.png',
  ],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
