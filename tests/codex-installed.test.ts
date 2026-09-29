import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { CodexRuntime, codexEnvironment, codexExecutable } from '../server/codex-runtime.js';

type Schema = {
  properties?: Record<string, Schema>;
  definitions?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  enum?: string[];
};
const runFile = promisify(execFile);

// Explicit, non-model preflight for the operator's installed official CLI.
test.skipIf(process.env.UIMORI_CODEX_PREFLIGHT !== '1')(
  'installed Codex initializes without authentication and exposes the native tool protocol',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'uimori-codex-installed-'));
    const within = relative(resolve(tmpdir()), root);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-codex-installed-')
    )
      throw new Error('Unsafe cleanup');
    const runtime = new CodexRuntime(join(root, 'probe.sqlite'), {
      enabled: true,
      executable: process.env.UIMORI_CODEX_EXECUTABLE,
    });
    try {
      const status = await runtime.status();
      const executable = codexExecutable(process.env.UIMORI_CODEX_EXECUTABLE);
      expect(executable).toBeDefined();
      const home = join(root, 'schema-home');
      await mkdir(home);
      const execution = {
        env: codexEnvironment(home, root),
        cwd: root,
        windowsHide: true,
        timeout: 15_000,
      };
      const version = (await runFile(executable!, ['--version'], execution)).stdout.trim();
      const schemaDirectory = join(root, 'schema');
      await runFile(
        executable!,
        [
          'app-server',
          '--strict-config',
          '-c',
          'code_mode.excluded_tool_namespaces=["functions"]',
          'generate-json-schema',
          '--experimental',
          '--out',
          schemaDirectory,
        ],
        execution
      );
      const schema = async (file: string): Promise<Schema> =>
        JSON.parse(await readFile(join(schemaDirectory, file), 'utf8'));
      const thread = await schema('v2/ThreadStartParams.json');
      const call = await schema('DynamicToolCallParams.json');
      const response = await schema('DynamicToolCallResponse.json');
      const requests = await schema('ServerRequest.json');
      const tool = thread.definitions?.DynamicToolSpec;
      const functionTool = tool?.oneOf?.find((item) =>
        item.properties?.type?.enum?.includes('function')
      );
      const namespaceTool = tool?.oneOf?.find((item) =>
        item.properties?.type?.enum?.includes('namespace')
      );
      expect(thread.properties).toHaveProperty('dynamicTools');
      expect(functionTool?.required).toEqual(
        expect.arrayContaining(['type', 'name', 'description', 'inputSchema'])
      );
      expect(namespaceTool?.required).toEqual(
        expect.arrayContaining(['type', 'name', 'description', 'tools'])
      );
      expect(call.required).toEqual(
        expect.arrayContaining(['threadId', 'turnId', 'callId', 'tool', 'arguments'])
      );
      expect(
        requests.oneOf?.some((item) => item.properties?.method?.enum?.includes('item/tool/call'))
      ).toBe(true);
      expect(response.required).toEqual(expect.arrayContaining(['contentItems', 'success']));
      expect(
        response.definitions?.DynamicToolCallOutputContentItem?.oneOf?.some((item) =>
          item.properties?.type?.enum?.includes('inputText')
        )
      ).toBe(true);
      const directory = resolve('output/codex-preflight');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'summary.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            modelCalls: 0,
            loginAttempted: false,
            version,
            status,
            protocol: {
              experimentalDynamicTools: true,
              toolSpec: 'namespace/function',
              defaultCodeModeNamespaceExcluded: true,
              clientToolCall: true,
              textToolResponse: true,
            },
          },
          null,
          2
        )
      );
      expect(status).toMatchObject({
        available: true,
        authenticated: false,
        authMode: null,
        error: null,
        login: null,
        limits: [],
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
