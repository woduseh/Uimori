import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { api, ApiError } from '../web/api.js';
import { loadLocale, setLocale, UI_LOCALES } from '../web/i18n.js';
import { formatUiMessage } from '../web/ui-message.js';

beforeAll(() => Promise.all(UI_LOCALES.map(loadLocale)));

afterEach(() => {
  vi.restoreAllMocks();
  setLocale('ko');
});

async function rejected(status: number, error: unknown, method = 'POST') {
  return rejectedWith(status, { error }, method);
}

async function rejectedWith(status: number, body: unknown, method = 'POST') {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const result = await api('/synthetic', {}, method).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(ApiError);
  return result as ApiError;
}

const shown = (error: ApiError) => formatUiMessage(error.uiMessage);

test('unavailable models retain only the role code and show the current selection paths', async () => {
  const result = await rejectedWith(409, { code: 'MODEL_UNAVAILABLE', params: { role: 'main' } });
  expect(result.code).toBe('MODEL_UNAVAILABLE');
  expect(shown(result)).toContain('고정 모델');
  const other = await rejectedWith(409, { code: 'MODEL_UNAVAILABLE', params: { role: 'helper' } });
  expect(shown(other)).toContain('역할별 모델');
  expect(shown(other)).not.toContain('고정 모델');
  const agent = await rejectedWith(409, { code: 'MODEL_UNAVAILABLE', params: { role: 'agent' } });
  expect(shown(agent)).toContain('에이전트 협업');
  expect(shown(agent)).not.toContain('역할별 모델');
});

test('only recognized revision errors are described as a concurrent save', async () => {
  const conflict = await rejectedWith(409, { code: 'REVISION_CONFLICT' });
  expect(conflict.code).toBe('REVISION_CONFLICT');
  expect(shown(conflict)).toContain('다른 요청이 먼저');
  for (const error of ['Revision conflict', 'Source revision conflict'])
    expect(await rejected(409, error)).toMatchObject({ code: null });
  const unknown = await rejected(409, 'INTERNAL_PATH:C:/private/provider-credential');
  expect(unknown.code).toBeNull();
  expect(shown(unknown)).toContain('현재 상태');
  expect(shown(unknown)).not.toMatch(/다른 요청|private|credential/);
});

test('generic errors keep provider, internal and deletion-conflict text hidden', async () => {
  const server = await rejected(503, 'remote model response secret');
  expect(server).toMatchObject({ status: 503, code: null });
  expect(shown(server)).toBe('서버 작업을 완료하지 못했어요. (503)');
  const request = await rejected(400, 'unrecognized request secret');
  expect(request).toMatchObject({ status: 400, code: null });
  expect(shown(request)).toBe('요청을 처리할 수 없어요. (400)');
  const deletion = await rejected(409, 'Chat organization is missing', 'DELETE');
  expect(deletion).toMatchObject({ status: 409, code: null });
  expect(shown(deletion)).toBe(
    '현재 상태에서는 이 요청을 완료할 수 없어요. 설정과 작업 상태를 확인해 주세요. (409)'
  );
  const coded = await rejectedWith(409, { code: 'CHAT_DELETE_HELPER_ACTIVE' }, 'DELETE');
  expect(coded.code).toBe('CHAT_DELETE_HELPER_ACTIVE');
  expect(shown(coded)).toBe('진행 중인 도우미 작업을 취소하거나 완료한 뒤 삭제해 주세요.');
});
