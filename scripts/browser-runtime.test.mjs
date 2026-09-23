import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrowserRuntime } from './browser-runtime.mjs';

function fixture({
  layout = { width: 160, height: 30 },
  text = '로컬 실행 확인',
  closeError,
} = {}) {
  const seen = { closed: false, options: null };
  return {
    seen,
    launch: async (options) => {
      seen.options = options;
      return {
        version: () => 'synthetic',
        newPage: async () => ({
          goto: async (url) => assert.equal((await fetch(url)).status, 200),
          locator: () => ({ innerText: async () => text, evaluate: async () => layout }),
        }),
        close: async () => {
          seen.closed = true;
          if (closeError) throw new Error(closeError);
        },
      };
    },
  };
}

test('probe actually visits loopback and checks text layout, then closes the browser', async () => {
  const f = fixture();
  const result = await assertBrowserRuntime({ executablePath: process.execPath, launch: f.launch });
  assert.equal(result.version, 'synthetic');
  assert.equal(f.seen.closed, true);
  assert.deepEqual(f.seen.options.args, ['--no-proxy-server']);
});

test('missing shared libraries are an environment blocker with the loader diagnostic', async () => {
  await assert.rejects(
    assertBrowserRuntime({
      executablePath: process.execPath,
      launch: async () => {
        throw new Error('error while loading shared libraries: libglib-2.0.so.0');
      },
    }),
    (error) =>
      error.code === 'BROWSER_RUNTIME_UNAVAILABLE' && error.message.includes('libglib-2.0.so.0')
  );
});

test('empty text geometry is blocked even when the browser and DOM are available', async () => {
  const f = fixture({ layout: { width: 0, height: 0 } });
  await assert.rejects(
    assertBrowserRuntime({ executablePath: process.execPath, launch: f.launch }),
    /text has no layout/
  );
  assert.equal(f.seen.closed, true);
});

test('cleanup cannot replace the primary failure, or silently turn success into PASS', async () => {
  const f = fixture({ text: 'wrong page', closeError: 'close failed' });
  await assert.rejects(
    assertBrowserRuntime({ executablePath: process.execPath, launch: f.launch }),
    (error) => error.message.includes('page mismatch') && error.message.includes('close failed')
  );
  const success = fixture({ closeError: 'close failed' });
  await assert.rejects(
    assertBrowserRuntime({ executablePath: process.execPath, launch: success.launch }),
    /cleanup failed/
  );
});
