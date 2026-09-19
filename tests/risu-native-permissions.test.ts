import { expect, test } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import type { NativeRisuContent } from '../core/risu-native.js';
import { nativeRisuContext } from '../server/risu-native-context.js';
import { executeRisuNative } from '../server/risu-native-runtime.js';

test('host-resolved bot and external module grants remain distinct after composition', async () => {
  const trigger = (name: string, flag: boolean) => ({
    type: 'start',
    lowLevelAccess: flag,
    effect: [
      {
        type: 'triggerlua',
        code: `function ${name}(id) local result = LLM(id, '${name}'); setChatVar(id, 'result', result.result) end`,
      },
    ],
  });
  const bot: NativeRisuContent = {
    version: 1,
    card: {
      name: 'Bot',
      first_mes: 'Opening',
      extensions: { risuai: { lowLevelAccess: false, triggerscript: [trigger('denied', true)] } },
    },
    assets: [],
    sourceHash: 'a'.repeat(64),
  };
  const module: NativeRisuContent = {
    version: 1,
    card: {},
    module: { lowLevelAccess: true, trigger: [trigger('allowed', false)] },
    assets: [],
    sourceHash: 'b'.repeat(64),
  };
  const packages = [bot, module].map((nativeRisu, index) => ({
    version: 1 as const,
    id: `package-${index}`,
    revision: 1,
    title: `Package ${index}`,
    description: '',
    body: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    nativeRisu,
  }));
  const snapshot: RunSnapshot = {
    chatId: 'permissions',
    parentRevision: null,
    settingsRevision: 1,
    settings: { mode: 'direct', preset: 'calm', translation: false, status: false, maxCalls: 4 },
    request: '',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('permissions'),
      contents: [],
      models: {},
      packages,
      packageAttachments: [
        { id: 'package-0', revision: 1, role: 'bot' },
        { id: 'package-1', revision: 1, role: 'module' },
      ],
    },
  };
  const context = nativeRisuContext(snapshot)!;
  expect(context.effectiveTriggers.map((entry) => entry.lowLevelAccess)).toEqual([false, true]);
  let calls = 0;
  const options = {
    host: async () => {
      calls++;
      return { success: true, result: 'Allowed' };
    },
  };
  expect(
    (await executeRisuNative({ ...context, event: 'manual', argument: 'allowed' }, options))
      .variables.result
  ).toBe('Allowed');
  await expect(
    executeRisuNative({ ...context, event: 'manual', argument: 'denied' }, options)
  ).rejects.toThrow('RISU_NATIVE_MODEL_DENIED');
  expect(calls).toBe(1);
});
