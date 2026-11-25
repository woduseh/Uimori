import { runNativeRisuLua } from './risu-native-lua-session.js';

const COMPILE_ONLY = String.raw`
local errors = {}
for index, code in ipairs(api.input.codes) do
  local _, message = load(code, '=lua', 't', {})
  if message then errors[tostring(index)] = message end
end
api.host.call('__native.next', {ok=true, errors=errors})
`;

export type LuaSyntaxError = { line: number | null; message: string };

export async function checkNativeRisuLuaSyntax(
  codes: string[],
  signal?: AbortSignal
): Promise<(LuaSyntaxError | null)[]> {
  if (!codes.length) return [];
  const result = (await runNativeRisuLua(
    COMPILE_ONLY,
    { codes },
    [],
    { signal, sessionOwner: {} },
    async (method) => {
      throw new Error(`RISU_LUA_SYNTAX_HOST_CALL:${method}`);
    }
  )) as { errors?: Record<string, unknown> };
  return codes.map((_, index) => {
    const message = result.errors?.[String(index + 1)];
    if (typeof message !== 'string') return null;
    const located = /^lua:(\d+): ([\s\S]*)$/u.exec(message);
    return located
      ? { line: Number(located[1]), message: located[2]! }
      : { line: null, message: message.slice(0, 500) };
  });
}
