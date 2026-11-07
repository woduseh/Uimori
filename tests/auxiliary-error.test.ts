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
  it('keeps partial response and input limit guidance in the shared message without obsolete chunking advice', () => {
    const partial = auxiliaryErrorDiagnostic('AUXILIARY_PROVIDER_PARTIAL');
    expect(partial.message).toContain('끝까지 받지 못했어요');
    expect(partial.action).toContain('호출 기록');
    expect(partial.action).toContain('응답 제한 시간');
    const limit = auxiliaryErrorDiagnostic('AUXILIARY_PROVIDER_INPUT_CONTEXT_LIMIT_EXCEEDED');
    expect(limit.message).toContain('입력 한도');
    for (const diagnostic of [
      partial,
      limit,
      auxiliaryErrorDiagnostic('AUXILIARY_PROVIDER_TIMEOUT'),
    ])
      expect(JSON.stringify(diagnostic)).not.toContain('구간');
  });
  it('keeps a missing prompt slot visible instead of disguising it as a model connection failure', () => {
    const diagnostic = auxiliaryErrorDiagnostic('PROMPT_UNKNOWN_SLOT');
    expect(diagnostic.code).toBe('PROMPT_UNKNOWN_SLOT');
    expect(diagnostic.message).toContain('슬롯');
    expect(diagnostic.action).toContain('프롬프트');
    expect(auxiliaryErrorDiagnostic('PROMPT_UNKNOWN_SLOT private text').code).toBeNull();
  });
  it('identifies exactly the missing model role', () => {
    for (const [role, label] of [
      ['main', '본문'],
      ['translation', '번역'],
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

  it('distinguishes a malformed JEV answer from a connection failure', () => {
    const diagnostic = auxiliaryErrorDiagnostic('JEV_RESPONSE_INVALID');
    expect(diagnostic.code).toBe('JEV_RESPONSE_INVALID');
    expect(diagnostic.message).toContain('판단 결과 형식');
    expect(diagnostic.action).toContain('다시 요청');
    expect(diagnostic.action).not.toContain('연결을 확인');
  });

  it('distinguishes missing classifier, failed classification, uncertainty and retry limits', () => {
    const credential = auxiliaryErrorDiagnostic('JEV_CREDENTIAL_REQUIRED');
    expect(credential.code).toBe('JEV_CREDENTIAL_REQUIRED');
    expect(credential.message).toContain('연결');
    expect(credential.action).toContain('API 키');
    const failed = auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_CHECK_FAILED');
    const uncertain = auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_UNCERTAIN');
    expect(failed.code).toBe('TRANSLATION_REFUSAL_CHECK_FAILED');
    expect(uncertain.code).toBe('TRANSLATION_REFUSAL_UNCERTAIN');
    expect(failed.message).toContain('번역 거절 여부');
    expect(uncertain.message).toContain('번역 거절 여부');
    expect(failed.action).toContain('연결');
    expect(uncertain.action).toContain('응답');
    const exhausted = auxiliaryErrorDiagnostic('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED');
    expect(exhausted.code).toBe('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED');
    expect(exhausted.message).toBe('번역이 거절된 것으로 판단했어요.');
    expect(auxiliaryErrorDiagnostic('AUXILIARY_CALL_BUDGET_EXHAUSTED').action).toContain(
      '호출 한도'
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

it.each([
  [
    'JEV_INPUT_BUDGET',
    '판단 입력이 허용된 토큰 한도를 초과했어요.',
    '출력 길이 설정을 확인해 주세요.',
  ],
  ['JEV_EXECUTION_FAILED', '판단을 완료하지 못했어요.', '작업 상세와 연결을 확인해 주세요.'],
])('shows concise judgment details for %s', (code, message, action) => {
  expect(auxiliaryErrorDiagnostic(code)).toEqual({ code, message, action });
  expect(auxiliaryErrorMessage(code)).toBe(`${message} ${action}`);
  expect(mainJudgmentError(code)).toBe(`${message} ${action}`);
});
