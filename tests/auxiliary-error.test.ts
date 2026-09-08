import { describe, expect, it } from 'vitest';
import { auxiliaryErrorDiagnostic } from '../web/auxiliary-error.js';

describe('safe auxiliary error diagnostics', () => {
  it('identifies exactly the missing model role', () => {
    for (const [role, label] of [
      ['main', '본문'],
      ['translation', '번역'],
      ['status', '표시 상태'],
      ['image', '이미지'],
    ]) {
      const diagnostic = auxiliaryErrorDiagnostic(`MODEL_REQUIRED:${role}`);
      expect(diagnostic.code).toBe(`MODEL_REQUIRED:${role}`);
      expect(diagnostic.message).toContain(`${label} 모델`);
      expect(diagnostic.action).toContain('채팅 설정');
    }
    expect(auxiliaryErrorDiagnostic('MODEL_REQUIRED:secret').code).toBeNull();
  });

  it('distinguishes provider authorization from translation validation failures', () => {
    const auth = auxiliaryErrorDiagnostic('AUXILIARY_PROVIDER_HTTP_401');
    expect(auth.code).toBe('AUXILIARY_PROVIDER_HTTP_401');
    expect(auth.message).toContain('인증');
    const validation = auxiliaryErrorDiagnostic('PROTECTED_SPAN_INVALID');
    expect(validation.message).toContain('원문 보존');
    expect(validation.action).toContain('보호 표기');
  });

  it('explains uncertain execution without promising a safe automatic replay', () => {
    for (const code of [
      'AUXILIARY_PROVIDER_TIMEOUT',
      'AUXILIARY_PROVIDER_UNEXPECTED_EOF',
      'AUXILIARY_PROVIDER_HTTP_503',
    ]) {
      expect(auxiliaryErrorDiagnostic(code).action).toContain('실행되었을 수');
    }
  });

  it('does not expose raw remote text, unrecognized codes or inherited object keys', () => {
    for (const error of [
      null,
      undefined,
      {},
      'constructor',
      '__proto__',
      'AUXILIARY_PROVIDER_PRIVATE_SECRET',
      'AUXILIARY_PROVIDER_HTTP_401 https://private.example/key',
      '<script>secret</script>',
    ]) {
      const diagnostic = auxiliaryErrorDiagnostic(error);
      expect(diagnostic.code).toBeNull();
      expect(diagnostic).toEqual(auxiliaryErrorDiagnostic(undefined));
    }
  });
});
