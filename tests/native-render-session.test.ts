import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  NativeRisuRenderInput,
  NativeRisuRenderResult,
} from '../server/risu-native-render.js';
import { renderNativeRisuMessage } from '../server/risu-native-render.js';
import { createNativeRisuWorkerSession } from '../server/risu-native-worker.js';

// Runs with the project's real Markdown/CBS dependencies, not the worker transport fixture.
test('session rendering matches one-shot rendering as messages and live variables change', async () => {
  const session = createNativeRisuWorkerSession<NativeRisuRenderInput, NativeRisuRenderResult>(
    new URL('../server/risu-native-render.js', import.meta.url),
    'renderNativeRisuMessageInWorker'
  );
  const input: NativeRisuRenderInput = {
    native: {
      version: 1,
      sourceHash: 'a'.repeat(64),
      assets: [],
      card: {
        name: '봇',
        description: '',
        extensions: { risuai: { backgroundHTML: '<style>.scene {padding: 1em}</style>' } },
      },
      module: {
        regex: [
          { type: 'editdisplay', in: 'TOKEN', out: '{{getvar::name}}', ableFlag: true, flag: 'g' },
        ],
      },
    },
    text: '**{{char}}**: TOKEN {{getvar::name}}',
    context: {
      charName: '봇',
      userName: '사용자',
      variables: { name: '첫 상태' },
      messages: [],
      now: 0,
      messageIndex: 0,
      displaying: true,
    },
  };
  try {
    for (const name of ['첫 상태', '다음 상태', '세 번째 상태']) {
      input.context.variables = { name };
      input.context.messages = [{ role: 'char', data: name }];
      const expected = await renderNativeRisuMessage(input);
      assert.deepEqual(await session.run(input), expected);
      assert.equal(input.context.variables.name, name);
    }
    const original = { ...input, text: 'Original **message**' };
    const translated = { ...input, text: '번역된 **메시지**' };
    assert.deepEqual(await session.run(original), await renderNativeRisuMessage(original));
    assert.deepEqual(await session.run(translated), await renderNativeRisuMessage(translated));
  } finally {
    await session.close();
  }
});
