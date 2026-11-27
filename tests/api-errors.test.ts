import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { api, ApiError } from '../web/api.js';
import { downloadArchive } from '../web/archive-download.js';
import { loadLocale, setLocale, translateMessage, UI_LOCALES } from '../web/i18n.js';
import { errorDescriptor } from '../web/api-errors.js';
import { formatUiMessage } from '../web/ui-message.js';
import { emptyTheme, validateTheme } from '../core/themes.js';

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

const shown = (error: ApiError) => {
  const text = formatUiMessage(error.uiMessage);
  expect(translateMessage(error.message)).toBe(text);
  return text;
};

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

test('a coded error renders its message from params in the current locale', async () => {
  const body = { code: 'INPUT_TRANSLATION_TOO_LONG', params: { limit: 1234 } };
  const result = await rejectedWith(422, body);
  expect(result).toMatchObject({ status: 422, code: 'INPUT_TRANSLATION_TOO_LONG' });
  expect(shown(result)).toContain('1,234자');
  setLocale('en');
  expect(shown(result)).toContain('1,234 characters');
});

test('a local validator error renders its catalogued message with a localized field label', () => {
  let caught: unknown;
  try {
    validateTheme({ ...emptyTheme('Long'), appCss: 'x'.repeat(1_000_001) });
  } catch (error) {
    caught = error;
  }
  const descriptor = errorDescriptor(caught);
  expect(translateMessage(descriptor)).toBe('앱 CSS: 최대 1,000,000자의 문자열을 입력해 주세요.');
  setLocale('en');
  expect(translateMessage(descriptor)).toBe('App CSS: Enter text of up to 1,000,000 characters.');
});

test('missing-translation scene labels render in the language shown, including after a switch', async () => {
  const result = await rejectedWith(409, {
    code: 'MANUSCRIPT_TRANSLATION_MISSING',
    params: { scenes: '0,3', total: 5 },
  });
  expect(shown(result)).toContain(': 첫 메시지, 장면 3, ….');
  setLocale('en');
  expect(shown(result)).toContain(
    '5 scenes have no valid saved translation: First message, Scene 3, ….'
  );
});

test('a catalogued code still arriving as a legacy error string uses the catalog message', async () => {
  const legacy = await rejected(422, 'INPUT_TRANSLATION_REFUSED');
  const coded = await rejectedWith(422, { code: 'INPUT_TRANSLATION_REFUSED' });
  expect(legacy).toMatchObject({ code: 'INPUT_TRANSLATION_REFUSED', message: coded.message });
  setLocale('en');
  expect(shown(legacy)).toBe('The translation model refused to translate this input.');
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
  const cycle = await download(JSON.stringify({ code: 'RESOURCE_BUNDLE_MODULE_CYCLE' }));
  expect(cycle.code).toBe('RESOURCE_BUNDLE_MODULE_CYCLE');
  expect(shown(cycle)).toBe('모듈 연결에 순환이 있어요.');
  const uncoded = await download(JSON.stringify({ error: 'Request failed' }), 500);
  expect(uncoded.message).toBe((await rejectedWith(500, { error: 'Request failed' })).message);
  const empty = await download('', 500);
  expect(empty.code).toBeNull();
  expect(shown(empty)).toBe('백업 파일을 받지 못했어요.');
});
