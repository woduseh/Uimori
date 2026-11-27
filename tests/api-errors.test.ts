import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { api, ApiError } from '../web/api.js';
import { downloadArchive } from '../web/archive-download.js';
import { loadLocale, setLocale, translateMessage, UI_LOCALES } from '../web/i18n.js';

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
  expect(await rejectedWith(409, { code: 'CHAT_DELETE_HELPER_ACTIVE' }, 'DELETE')).toMatchObject({
    code: 'CHAT_DELETE_HELPER_ACTIVE',
    message: deletion,
  });
});

test('a coded error renders its message from params in the current locale', async () => {
  const body = { code: 'INPUT_TRANSLATION_TOO_LONG', params: { limit: 1234 } };
  const result = await rejectedWith(422, body);
  expect(result).toMatchObject({
    status: 422,
    code: 'INPUT_TRANSLATION_TOO_LONG',
    message: expect.stringContaining('1,234자'),
  });
  setLocale('en');
  expect(result.displayMessage).toContain('1,234 characters');
});

test('a catalogued code still arriving as a legacy error string uses the catalog message', async () => {
  const legacy = await rejected(422, 'INPUT_TRANSLATION_REFUSED');
  const coded = await rejectedWith(422, { code: 'INPUT_TRANSLATION_REFUSED' });
  expect(legacy).toMatchObject({ code: 'INPUT_TRANSLATION_REFUSED', message: coded.message });
  setLocale('en');
  expect(legacy.displayMessage).toBe('The translation model refused to translate this input.');
});

test('a legacy error string naming a code that needs params falls back instead of formatting', async () => {
  const result = await rejected(422, 'INPUT_TRANSLATION_TOO_LONG');
  expect(result).toMatchObject({ status: 422, message: expect.any(String) });
});

test('archive downloads show coded errors and keep their own fallback for an empty body', async () => {
  const download = async (body: string, status = 400) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
    const result = await downloadArchive('/native-transfers/export-archive', 'x.uimori', {}).then(
      () => null,
      (error: unknown) => error
    );
    expect(result).toBeInstanceOf(ApiError);
    return result as ApiError;
  };
  expect(await download(JSON.stringify({ code: 'RESOURCE_BUNDLE_MODULE_CYCLE' }))).toMatchObject({
    code: 'RESOURCE_BUNDLE_MODULE_CYCLE',
    message: '모듈 연결에 순환이 있어요.',
  });
  const uncoded = await download(JSON.stringify({ error: 'Request failed' }), 500);
  expect(uncoded.message).toBe((await rejectedWith(500, { error: 'Request failed' })).message);
  const empty = await download('', 500);
  expect(empty.code).toBeNull();
  expect(translateMessage(empty.message)).toBe('백업 파일을 받지 못했어요.');
});
