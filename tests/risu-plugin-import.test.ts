import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import Fastify from 'fastify';
import { readRisuPlugin, risuPluginRoutes } from '../server/risu-plugin-import.js';
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

test('refuses a file that is not a plugin and reports an older API declaration', async () => {
  expect(() => readRisuPlugin(source('const x = 1;'))).toThrow('RISU_PLUGIN_INVALID_FILE');
  expect(() => readRisuPlugin(source(plugin(''), 'plugin.txt'))).toThrow(
    'RISU_PLUGIN_INVALID_FILE'
  );
  const legacy = readRisuPlugin(
    source(['//@name legacy', '//@api 2.0', 'risuai.getArgument("key");'].join('\n'))
  );
  expect(legacy.apiVersion).toBe('2.0');
  expect(legacy.findings.map((finding) => finding.code)).toContain('plugin-api-version');

  const app = Fastify();
  risuPluginRoutes(app, 'unused.sqlite');
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/risu-plugin-imports/prepare',
      payload: { source: source(plugin('risuai.log("ready");')) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('synthetic-plugin');
  } finally {
    await app.close();
  }
});
