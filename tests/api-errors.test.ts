import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../web/api.js';

afterEach(() => vi.restoreAllMocks());

async function rejected(status: number, error: unknown, method = 'POST') {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error }), { status })
  );
  const result = await api('/synthetic', {}, method).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(ApiError);
  return result as ApiError;
}

test('pinned prompt failures preserve the safe code and point to chat settings, not revision conflict', async () => {
  const result = await rejected(
    409,
    'PINNED_PROMPT_UNAVAILABLE: arbitrary server details secret-value'
  );
  expect(result).toMatchObject({ status: 409, code: 'PINNED_PROMPT_UNAVAILABLE' });
  expect(result.message).toContain('채팅 설정');
  expect(result.message).toContain('고정을 해제');
  expect(result.message).not.toMatch(/다른 요청|secret-value/);
});

test.each([
  [400, 'CHAT_TRANSCRIPT_INVALID_REQUEST', '요청 문장'],
  [400, 'CHAT_TRANSCRIPT_UNSUPPORTED_VERSION', '앱의 버전'],
  [400, 'CHAT_BACKUP_UNSUPPORTED_VERSION', '앱의 버전'],
  [400, 'CHAT_BACKUP_TOO_LARGE', '허용 크기'],
  [409, 'MODEL_REQUIRED:translation-refusal', '번역 거절 판정'],
  [409, 'MODEL_REQUIRED:helper', '도우미 모델'],
  [409, 'HELPER_EFFECTS_ALREADY_COMMITTED', '남은 작업만 새 요청'],
  [409, 'ILLUSTRATION_ACTIVE', '아직 생성 중'],
] as const)('business error %s %s has its own recovery message', async (status, code, message) => {
  const result = await rejected(status, code);
  expect(result).toMatchObject({ code, status });
  expect(result.message).toContain(message);
  expect(result.message).not.toContain('다른 요청이 먼저');
});

test('unavailable models retain only the role code and show the current selection paths', async () => {
  const result = await rejected(409, 'MODEL_UNAVAILABLE:main:private-model-and-credential');
  expect(result.code).toBe('MODEL_UNAVAILABLE:main');
  expect(result.message).toContain('고정 모델');
  expect(result.message).not.toContain('private-model');
});

test('only recognized revision errors are described as a concurrent save', async () => {
  for (const code of [
    'Revision conflict',
    'Source revision conflict',
    'Settings revision conflict',
    '초안이 변경됐어요. 현재 입력은 유지하고 변경 내용을 확인해 주세요.',
  ])
    expect(await rejected(409, code)).toMatchObject({
      code: 'REVISION_CONFLICT',
      message: expect.stringContaining('다른 요청이 먼저'),
    });
  expect(await rejected(409, 'BEHAVIOR_STATE_STALE')).toMatchObject({
    code: 'BEHAVIOR_STATE_STALE',
    message: expect.stringContaining('다른 요청이 먼저'),
  });
  const unknown = await rejected(409, 'INTERNAL_PATH:C:/private/provider-credential');
  expect(unknown.code).toBeNull();
  expect(unknown.message).toContain('현재 상태');
  expect(unknown.message).not.toMatch(/다른 요청|private|credential/);
});

test('generic errors keep provider/internal text hidden and retain deletion conflict details', async () => {
  expect(await rejected(503, 'remote model response secret')).toMatchObject({
    status: 503,
    code: null,
    message: '서버 작업을 완료하지 못했어요. (503)',
  });
  expect(await rejected(400, 'unrecognized request secret')).toMatchObject({
    status: 400,
    code: null,
    message: '요청을 처리할 수 없어요. (400)',
  });
  const deletion = '진행 중인 도우미 작업을 취소하거나 완료한 뒤 삭제해 주세요.';
  expect(await rejected(409, deletion, 'DELETE')).toMatchObject({ message: deletion });
});
