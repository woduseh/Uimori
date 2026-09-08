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
      expect(diagnostic.action).toContain('전역 모델 설정');
    }
    expect(auxiliaryErrorDiagnostic('MODEL_REQUIRED:secret').code).toBeNull();
  });

  it('distinguishes provider authorization from structured auxiliary output failures', () => {
    const auth = auxiliaryErrorDiagnostic('AUXILIARY_PROVIDER_HTTP_401');
    expect(auth.code).toBe('AUXILIARY_PROVIDER_HTTP_401');
    expect(auth.message).toContain('인증');
    const validation = auxiliaryErrorDiagnostic('OUTPUT_SCHEMA_INVALID');
    expect(validation.message).toContain('출력 형식');
    expect(validation.action).toContain('프롬프트');
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

  it('distinguishes missing classifier, failed classification, uncertainty and retry limits without replay promises', () => {
    expect(auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_MODEL_REQUIRED').message).toContain(
      '지정되지'
    );
    const failed = auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_CHECK_FAILED');
    const uncertain = auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_UNCERTAIN');
    expect(failed.message).not.toBe(uncertain.message);
    for (const diagnostic of [failed, uncertain]) {
      expect(diagnostic.action).toContain('보존');
      expect(diagnostic.action).toContain('자동으로 다시 호출하지 않았어요');
    }
    expect(auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED').message).toContain(
      '허용된 자동 재시도'
    );
    expect(auxiliaryErrorDiagnostic('AUXILIARY_CALL_BUDGET_EXHAUSTED').action).toContain(
      '거절 판정'
    );
    expect(auxiliaryErrorDiagnostic('TOOL_CORRECTION_EXHAUSTED').message).toContain('중단');
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
      'TRANSLATION_REFUSAL_CHECK_FAILED PRIVATE_RESPONSE_TEXT',
      { code: 'TRANSLATION_REFUSAL_UNCERTAIN', response: 'PRIVATE_RESPONSE_TEXT' },
    ]) {
      const diagnostic = auxiliaryErrorDiagnostic(error);
      expect(diagnostic.code).toBeNull();
      expect(diagnostic).toEqual(auxiliaryErrorDiagnostic(undefined));
    }
  });
});
