import type { MessageKey } from './ui-message.js';

export function providerFailureKey(code: string | null | undefined): MessageKey {
  const error = code ?? '';
  if (error.includes('429')) return 'shared.rateLimit';
  if (error.includes('TIMEOUT')) return 'shared.timeoutFailure';
  if (error.includes('TRANSPORT_ERROR')) return 'shared.connectionFailure';
  if (/HTTP_40[13]/u.test(error)) return 'shared.authFailure';
  if (/HTTP_5\d\d/u.test(error)) return 'shared.providerFailure';
  return 'shared.responseFailure';
}
