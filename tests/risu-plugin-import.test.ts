import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { readRisuPlugin } from '../server/risu-plugin-import.js';
import { RISU_PLUGIN_API_SUPPORT } from '../core/risu-plugin.js';

const plugin = (body: string) =>
  [
    '//@name synthetic-plugin',
    '//@display-name Synthetic Plugin',
    '//@api 3.0',
    '//@arg api_key string 연결에 사용할 키',
    '//@arg retries int 재시도 횟수',
    '//@link https://example.test/docs 사용 안내',
    body,
  ].join('\n');
const source = (code: string, name = 'synthetic.js') => ({
  name,
  base64: Buffer.from(code, 'utf8').toString('base64'),
});

test('reads the declared plugin identity, arguments and links without running the file', () => {
  const code = plugin('(async () => { throw new Error("PLUGIN_MUST_NOT_RUN"); })();');
  const preview = readRisuPlugin(source(code));
  expect(preview).toMatchObject({
    name: 'synthetic-plugin',
    displayName: 'Synthetic Plugin',
    apiVersion: '3.0',
    links: [{ url: 'https://example.test/docs', hoverText: '사용 안내' }],
    arguments: [
      { key: 'api_key', type: 'string', description: '연결에 사용할 키' },
      { key: 'retries', type: 'int', description: '재시도 횟수' },
    ],
    bytes: Buffer.byteLength(code),
    sha256: createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex'),
  });
  expect(preview.findings.map((finding) => finding.code)).toContain('plugin-not-executed');
});

test('keeps the last declared name and leaves a clean plugin without an unsupported finding', () => {
  // RisuAI assigns on every //@name line, so a repeated header keeps the last value.
  const preview = readRisuPlugin(
    source(['//@name first', '//@name second', '//@api 3.0', 'risuai.getRuntimeInfo();'].join('\n'))
  );
  expect(preview.name).toBe('second');
  expect(preview.findings.map((finding) => finding.level)).not.toContain('unsupported');
  expect(preview.findings).toEqual([
    expect.objectContaining({ code: 'plugin-not-executed', level: 'info' }),
    expect.objectContaining({ code: 'plugin-api-detection', level: 'info' }),
  ]);
  expect(preview).toMatchObject({ pluginVersion: '', updateUrl: '', allowedIpc: [] });
});

test('judges every mentioned API against the current contracts and reports the rest', () => {
  const preview = readRisuPlugin(
    source(
      plugin(`
        const { pluginStorage, getRootDocument } = risuai;
        await risuai.addRisuReplacer('editdisplay', (text) => text);
        await risuai.nativeFetch('https://example.test');
        await Risuai.registerButton('side', () => {});
        await risuai.somethingBrandNew();
      `)
    )
  );
  const support = Object.fromEntries(preview.apis.map((api) => [api.name, api.support]));
  expect(support).toMatchObject({
    addRisuReplacer: 'mapped',
    pluginStorage: 'mapped',
    nativeFetch: 'unimplemented',
    registerButton: 'out-of-scope',
    getRootDocument: 'out-of-scope',
  });
  expect(preview.unknownApis).toEqual(['somethingBrandNew']);
  const codes = preview.findings.map((finding) => finding.code);
  expect(codes).toContain('plugin-api-unimplemented');
  expect(codes).toContain('plugin-api-out-of-scope');
  expect(codes).toContain('plugin-api-unknown');
  // Every judgement names a support level the classification table owns.
  for (const api of preview.apis)
    expect(RISU_PLUGIN_API_SUPPORT[api.name].support).toBe(api.support);
});

test('reads the version, update URL and IPC headers and calls the plugin channel unimplemented', () => {
  const preview = readRisuPlugin(
    source(
      [
        '//@name channel-plugin',
        '//@api 3.0',
        '//@version 1.4.2',
        '//@update-url https://example.test/plugin.js',
        '//@allowed-ipc sibling-a sibling-b',
        '//@allowed-ipc sibling-a',
        'risuai.getRuntimeInfo();',
      ].join('\n')
    )
  );
  expect(preview).toMatchObject({
    pluginVersion: '1.4.2',
    updateUrl: 'https://example.test/plugin.js',
    allowedIpc: ['sibling-a', 'sibling-b'],
  });
  const ipc = preview.findings.find((finding) => finding.code === 'plugin-allowed-ipc');
  expect(ipc?.level).toBe('unsupported');
  expect(ipc?.message).toContain('아직 구현하지 않아서');
  // An http update URL is not a Risu update URL, so the preview reports none.
  const insecure = readRisuPlugin(
    source(['//@name plain', '//@update-url http://example.test/plugin.js'].join('\n'))
  );
  expect(insecure.updateUrl).toBe('');
});

test('classifies the members the earlier table missed or judged too optimistically', () => {
  const preview = readRisuPlugin(
    source(
      plugin(`
        risuai.risuFetch('https://example.test');
        risuai.installPlugin('other');
        risuai.setChatPanel('<p></p>');
        risuai.alert('hi'); risuai.alertConfirm('sure?'); risuai.alertError('no');
        risuai.setArg('key', 1);
        risuai.pluginStorage.getItem('key');
        risuai.safeLocalStorage.getItem('key');
        risuai.getLocalPluginStorage();
        risuai.parseRisuChat('text');
        risuai.onUnload(() => {});
        risuai.log('note');
        risuai.getChatFromIndex(0);
        risuai.getCurrentChatIndex();
        risuai.getCurrentCharacterIndex();
        risuai.getCharacterFromIndex(0);
        risuai.getDatabase();
      `)
    )
  );
  expect(Object.fromEntries(preview.apis.map((api) => [api.name, api.support]))).toEqual({
    risuFetch: 'unimplemented',
    installPlugin: 'unimplemented',
    setChatPanel: 'out-of-scope',
    alert: 'out-of-scope',
    alertConfirm: 'out-of-scope',
    alertError: 'out-of-scope',
    setArg: 'unimplemented',
    // The three storages now reach branch shared variables through the plugin adapter.
    pluginStorage: 'mapped',
    safeLocalStorage: 'mapped',
    getLocalPluginStorage: 'mapped',
    parseRisuChat: 'unimplemented',
    onUnload: 'mapped',
    log: 'mapped',
    getChatFromIndex: 'out-of-scope',
    getCurrentChatIndex: 'out-of-scope',
    getCurrentCharacterIndex: 'out-of-scope',
    getCharacterFromIndex: 'out-of-scope',
    getDatabase: 'out-of-scope',
  });
  const note = (name: string) => RISU_PLUGIN_API_SUPPORT[name].note;
  expect(note('risuFetch')).toContain('nativeFetch');
  expect(note('onUnload')).toContain('부르지 않아요');
  expect(note('pluginStorage')).toContain('공유 변수');
  expect(note('setArgument')).toContain('읽기만 해요');
  expect(note('getDatabase')).toContain('읽기 전용 허용 목록 프록시');
  expect(note('getChatFromIndex')).toContain('주소 공간');
  expect(note('addRisuScriptHandler')).toContain('메시지 수와 역할');
  // The main-app UI rule covers a dialog exactly as it covers a registered part.
  expect(note('alert')).toBe(note('registerButton'));
});

test('says that API detection is textual and names a binding that renames risuai', () => {
  const plain = readRisuPlugin(source(plugin('risuai.getRuntimeInfo();')));
  const notice = plain.findings.find((finding) => finding.code === 'plugin-api-detection');
  expect(notice?.level).toBe('info');
  expect(notice?.message).toContain('글자만 대조해서');
  expect(notice?.message).not.toContain('다른 이름으로 받는 곳');

  const aliased = readRisuPlugin(
    source(plugin('const risuApi = risuai;\nrisuApi.nativeFetch("https://example.test");'))
  );
  const aliasNotice = aliased.findings.find((finding) => finding.code === 'plugin-api-detection');
  expect(aliasNotice?.message).toContain('risuApi');
  // The alias is only named, never resolved, so its member stays out of the judged list.
  expect(aliased.apis).toEqual([]);
  expect(aliased.unknownApis).toEqual([]);
});

test('refuses a file that is not a plugin and reports an older API declaration', () => {
  expect(() => readRisuPlugin(source('const x = 1;'))).toThrow('RISU_PLUGIN_INVALID_FILE');
  expect(() => readRisuPlugin(source(plugin(''), 'plugin.txt'))).toThrow(
    'RISU_PLUGIN_INVALID_FILE'
  );
  const legacy = readRisuPlugin(
    source(['//@name legacy', '//@api 2.0', 'risuai.getArgument("key");'].join('\n'))
  );
  expect(legacy.apiVersion).toBe('2.0');
  expect(legacy.findings.map((finding) => finding.code)).toContain('plugin-api-version');
});
