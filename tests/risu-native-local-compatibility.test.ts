import { afterEach, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { readNativeRisuSample } from './fixtures/native-risu.js';
import { readRisuPresetFile } from '../server/risu-preset-file.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
import { projectNativeRisuPackage } from '../server/risu-native-projection.js';
import { renderNativeRisuMessage } from '../server/risu-native-render.js';
import { prepareNativeRisuRun, prepareNativeRisuOutput } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import {
  disposeAllNativeRisuSessions,
  executeRisuNative,
  type NativeRisuExecutionInput,
} from '../server/risu-native-runtime.js';

// Explicit opt-in only. Assertions expose booleans/counts, never private source or script text.
const paths: string[] = JSON.parse(process.env.UIMORI_RISU_LOCAL_CARDS ?? '[]');
const presetPath = process.env.UIMORI_RISU_SAMPLE_PRESET;
afterEach(disposeAllNativeRisuSessions);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test.runIf(paths.length > 0 && !!presetPath)(
  'local cards and an original preset compose a current native request and output without external providers',
  async () => {
    const presetHash = hash(presetPath!);
    const document = readRisuPresetFile({
      name: basename(presetPath!),
      base64: readFileSync(presetPath!).toString('base64'),
    });
    const imported = importRisuPresetProgram(document.preset);
    expect(
      imported.findings.filter((item) => item.level === 'unsupported').map((item) => item.code)
    ).toEqual([]);
    for (const [index, path] of paths.entries()) {
      const before = hash(path);
      const sample = readNativeRisuSample(path);
      const pkg = projectNativeRisuPackage(
        {
          version: 2,
          id: `local-${index}`,
          revision: 1,
          title: 'Local sample',
          description: '',
          lore: [],
          nativeRisu: sample.native,
        },
        'bot'
      ).pkg;
      const rendered = await renderNativeRisuMessage({
        native: pkg.nativeRisu,
        text: String(pkg.nativeRisu.card.first_mes ?? ''),
        context: { variables: sample.variables, userName: 'Reader' },
        timeoutMs: 10000,
      });
      console.info(
        JSON.stringify({
          sample: index + 1,
          firstChars: String(pkg.nativeRisu.card.first_mes ?? '').length,
          starts: pkg.starts?.map((start) => ({
            mode: start.mode,
            chars: start.text?.length ?? 0,
          })),
          renderedChars: rendered.html.length,
          buttons: [...rendered.html.matchAll(/risu-(?:trigger|btn)=["']/gu)].length,
        })
      );
      expect(rendered.html.trim().length > 0, `sample ${index + 1}: rendered first message`).toBe(
        true
      );
      expect(
        rendered.issues.some((issue) => issue.startsWith('regex:')),
        `sample ${index + 1}: display regex`
      ).toBe(false);
      for (const start of pkg.starts?.slice(1) ?? []) {
        const alternate = await renderNativeRisuMessage({
          native: pkg.nativeRisu,
          text: start.text ?? '',
          context: { variables: sample.variables, userName: 'Reader' },
          timeoutMs: 10000,
        });
        expect(
          alternate.html.trim().length > 0,
          `sample ${index + 1}: alternate greeting rendered`
        ).toBe(true);
        expect(
          alternate.issues.some((issue) => issue.startsWith('regex:')),
          `sample ${index + 1}: alternate greeting regex`
        ).toBe(false);
      }
      const knownActions = basename(path).startsWith('Cheongwon')
        ? ['setLangToEnglish', 'setFirst1']
        : basename(path).startsWith('Fujimiya')
          ? ['onLangEn', 'initAff70', 'scenario_g1']
          : [];
      let state: NativeRisuExecutionInput = {
        native: pkg.nativeRisu,
        variables: sample.variables,
        messages: [],
        charName: String(pkg.nativeRisu.card.name),
        userName: 'Reader',
        event: 'manual',
      };
      for (const argument of knownActions) {
        const prior = JSON.stringify(state.variables);
        const selected = await executeRisuNative({ ...state, argument });
        expect(
          JSON.stringify(selected.variables) !== prior,
          `sample ${index + 1}: authored action changes variables`
        ).toBe(true);
        state = { ...state, variables: selected.variables, messages: selected.messages };
      }
      const chatId = randomUUID();
      const snapshot: RunSnapshot = {
        chatId,
        parentRevision: null,
        settingsRevision: 1,
        settings: {
          status: false,
          maxCalls: 1,
        },
        request: 'LOCAL_COMPATIBILITY_CONTINUE',
        history: [],
        resources: [],
        logicalHistory: state.messages.length
          ? state.messages.map((message, i) => ({
              id: `message-${i}`,
              role: message.role === 'user' ? 'user' : 'assistant',
              text: message.data,
            }))
          : [
              {
                id: 'opening',
                role: 'assistant',
                text: String(pkg.nativeRisu.card.first_mes ?? ''),
                sourceKind: 'authored-start',
              },
            ],
        profile: {
          ...defaultProfile(chatId),
          models: {},
          packages: [pkg],
          packageAttachments: [{ id: pkg.id, revision: 1, role: 'bot' }],
          variableState: { revision: 1, values: state.variables },
          promptPresets: {
            main: {
              id: 'local-preset',
              revision: 1,
              title: 'Local preset',
              role: 'main',
              program: imported.program,
              values: {},
            },
          },
        },
      };
      const host = async () => ({ success: true, result: '{}' });
      const prepared = compileSnapshotPrompt(await prepareNativeRisuRun(snapshot, { host }));
      expect(prepared.promptCompilation?.compilerVersion).toBe('risu-native-prompt-2');
      expect(prepared.promptCompilation!.messages.length > 0).toBe(true);
      expect(
        prepared.promptCompilation!.messages.some((message) =>
          message.content.some((part) => part.text.includes('LOCAL_COMPATIBILITY_CONTINUE'))
        )
      ).toBe(true);
      const output = await prepareNativeRisuOutput(prepared, 'LOCAL_COMPATIBILITY_RESPONSE', {
        host,
      });
      expect(typeof output.nativeRisuExecution?.output?.text).toBe('string');
      expect(hash(path) === before, `sample ${index + 1}: original bytes unchanged`).toBe(true);
    }
    expect(hash(presetPath!) === presetHash, 'original preset bytes unchanged').toBe(true);
  },
  120000
);
