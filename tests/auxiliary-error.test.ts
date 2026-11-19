import { describe, expect, it } from 'vitest';
import { auxiliaryErrorDiagnostic, auxiliaryErrorMessage } from '../web/auxiliary-error.js';
import { mainJudgmentError } from '../web/main-judgment-error.js';

describe('safe auxiliary error diagnostics', () => {
  it('identifies missing evaluation submission in main and auxiliary tasks', () => {
    const diagnostic = auxiliaryErrorDiagnostic('EVALUATION_SUBMISSION_REQUIRED');
    expect(diagnostic.code).toBe('EVALUATION_SUBMISSION_REQUIRED');
    expect(diagnostic.message).toBe('모델이 결과를 제출하지 않았어요.');
    expect(diagnostic.action).toBe('평가 도구 설정을 확인해 주세요.');
    expect(mainJudgmentError('EVALUATION_SUBMISSION_REQUIRED')).toContain(diagnostic.message);
    expect(mainJudgmentError('EVALUATION_SUBMISSION_REQUIRED private text')).toBeUndefined();
  });
  it('identifies exactly the missing model role', () => {
    for (const [role, label] of [
      ['main', '본문'],
      ['translation', '번역'],
    ]) {
      const diagnostic = auxiliaryErrorDiagnostic(`MODEL_REQUIRED:${role}`);
      expect(diagnostic.code).toBe(`MODEL_REQUIRED:${role}`);
      expect(diagnostic.message).toContain(`${label} 모델`);
      expect(diagnostic.action).toContain('설정 > 역할별 모델');
    }
    expect(auxiliaryErrorDiagnostic('MODEL_REQUIRED:secret').code).toBeNull();
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
      'TRANSLATION_REFUSAL_CHECK_FAILED PRIVATE_RESPONSE_TEXT',
      { code: 'TRANSLATION_REFUSAL_UNCERTAIN', response: 'PRIVATE_RESPONSE_TEXT' },
    ]) {
      const diagnostic = auxiliaryErrorDiagnostic(error);
      expect(diagnostic.code).toBeNull();
      expect(diagnostic).toEqual(auxiliaryErrorDiagnostic(undefined));
    }
  });
});

it('shows concise judgment details consistently across shared messages', () => {
  const code = 'JEV_EXECUTION_FAILED';
  const message = '판단을 완료하지 못했어요.';
  const action = '작업 상세와 연결을 확인해 주세요.';
  expect(auxiliaryErrorDiagnostic(code)).toEqual({ code, message, action });
  expect(auxiliaryErrorMessage(code)).toBe(`${message} ${action}`);
  expect(mainJudgmentError(code)).toBe(`${message} ${action}`);
});
