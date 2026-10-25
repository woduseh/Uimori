import { afterEach, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { readResource } from '../server/resource-service.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import type { Content } from '../core/product.js';

// The Linux path under test uses Bash, Python and Unix sockets, not a mocked shell.
const linuxTest = process.platform === 'linux' ? test : test.skip;
const owned: {
  dir: string;
  store: Store;
  runtime: HelperRuntime;
  child: ChildProcess;
  controller: AbortController;
  work: Promise<void>[];
}[] = [];
afterEach(async () => {
  for (const f of owned.splice(0)) {
    f.controller.abort();
    await Promise.allSettled(f.work);
    f.runtime.shell.close();
    if (f.child.exitCode === null && f.child.signalCode === null) {
      const exited = once(f.child, 'exit');
      f.child.kill('SIGKILL');
      await exited;
    }
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(sceneUpdated?: (id: string) => void, inputTokenLimit = 272000) {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-shell-runtime-'));
  const root = join(dir, 'shell');
  vi.stubEnv('UIMORI_SHELL_ROOT', root);
  const store = new Store(join(dir, 'test.sqlite'));
  const work: Promise<void>[] = [];
  const controller = new AbortController();
  const connection = store.product.connection({
    title: 'Synthetic Chat',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: 'synthetic-helper',
    maxOutputTokens: 2048,
    inputTokenLimit,
    temperature: null,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const runtime = new HelperRuntime(store, {
    resolveCredential: () => 'synthetic-fixture-key',
    owner: 'shell-runtime',
    services: { sceneUpdated },
    signal: controller.signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
  });
  const child = spawn(process.execPath, [resolve('runner/runner.mjs')], {
    env: { ...process.env, UIMORI_SHELL_ROOT: root },
    stdio: 'ignore',
  });
  owned.push({ dir, store, runtime, child, controller, work });
  for (let i = 0; i < 80 && !existsSync(join(root, '.exec.sock')); i++) await delay(25);
  expect(existsSync(join(root, '.exec.sock'))).toBe(true);
  const conversation = runtime.workspace.open({ kind: 'library', workId: 'shell-runtime' });
  const run = async (request: string) => {
    const task = runtime.enqueue(conversation.id, randomUUID(), request);
    await Promise.all(work);
    return runtime.workspace.task(task.id);
  };
  return { store, runtime, child, root, conversation, run };
}

// Only the paid provider is intercepted; native transport, Runner, bridge and saves are real.
function answer(body: any, call?: { id: string; arguments: unknown }) {
  const delta = call
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: call.id,
            type: 'function',
            function: {
              name: body.tools.find((tool: any) => tool.function.name.endsWith('_data_exec'))
                .function.name,
              arguments: JSON.stringify(call.arguments),
            },
          },
        ],
      }
    : { role: 'assistant', content: 'Synthetic final.' };
  return new Response(
    `data: ${JSON.stringify({
      id: 'synthetic-response',
      choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }
  );
}
function provider(action: (body: any, round: number) => Response) {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return action(body, bodies.length - 1);
    })
  );
  return bodies;
}
const toolResult = (body: any) =>
  JSON.parse(body.messages.findLast((message: any) => message.role === 'tool').content);

linuxTest(
  'committed apply remains recorded when Runner response is lost and stops automatic replay',
  async () => {
    const f = await fixture();
    const bot = f.store.product.content(fixtureBotInput('Lost response fixture', 'Original'));
    const file = `library/${bot.id}/resource.json`;
    const command = `python3 - <<'PY'
import json
p='${file}'
x=json.load(open(p))
x['package']['nativeRisu']['card']['creator_notes']='Committed before transport failure'
open(p,'w').write(json.dumps(x))
PY
${process.execPath} ${resolve('runner/uimori.mjs')} apply ${file} && kill -KILL ${f.child.pid}`;
    const bodies = provider((body, round) =>
      round === 0 ? answer(body, { id: 'lost-shell', arguments: { command } }) : answer(body)
    );
    const task = await f.run('Update creator notes through native apply.');
    expect((readResource(f.store, 'content', bot.id) as Content).description).toBe(
      'Committed before transport failure'
    );
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(task.id)?.n
    ).toBe(1);
    expect(task.completedEffects?.count).toBe(1);
    expect(task.status).toBe('failed');
    expect(bodies).toHaveLength(1);
    const finished = f.runtime.workspace
      .events(f.conversation.id)
      .find(
        (event) =>
          event.kind === 'tool.finished' &&
          (event.data as { callId?: string }).callId === 'lost-shell'
      );
    expect(finished?.data).toMatchObject({
      denied: true,
      result: {
        outcome: 'unknown',
        retryMode: 'inspect_outcome',
        recoverable: false,
        applied: [expect.objectContaining({ path: file, changed: true })],
      },
    });
  }
);

linuxTest(
  'invalid shell arguments can be corrected to a long command with a small result',
  async () => {
    const f = await fixture();
    const command = '#' + 'x'.repeat(33000) + '\nprintf LONG_COMMAND_OK';
    const bodies = provider((body, round) => {
      if (round === 0) return answer(body, { id: 'invalid-shell', arguments: { command: 123 } });
      if (round === 1) return answer(body, { id: 'long-shell', arguments: { command } });
      return answer(body);
    });
    const task = await f.run('Run the local script.');
    expect(bodies).toHaveLength(3);
    expect(toolResult(bodies[1])).toMatchObject({
      code: 'INVALID_SHELL_ARGUMENTS',
      outcome: 'unchanged',
      retryMode: 'correct_arguments',
      recoverable: true,
    });
    expect(toolResult(bodies[2])).toMatchObject({
      exitCode: 0,
      output: 'LONG_COMMAND_OK',
      applied: [],
    });
    expect(task.status).toBe('completed');
    expect(task.completedEffects?.count ?? 0).toBe(0);
  }
);

linuxTest(
  'oversized shell output is narrowed from its log without replaying the command',
  async () => {
    // Recovery is needed when the selected model cannot fit the result, not at a
    // fixed 16k threshold in an otherwise roomy 272k context.
    const f = await fixture(undefined, 16384);
    const counter = join(f.root, 'executions');
    const command = `printf x >> ${counter}; python3 -c "print(chr(0) * 18000, end='')"`;
    const bodies = provider((body, round) => {
      if (round === 0) return answer(body, { id: 'large-output', arguments: { command } });
      if (round === 1) {
        const result = toolResult(body);
        if (result.nextRead?.name === 'data.exec')
          return answer(body, { id: 'narrow-output', arguments: result.nextRead.arguments });
      }
      return answer(body);
    });
    const task = await f.run('Inspect the local output.');
    const result = toolResult(bodies[1]);
    expect(result).toMatchObject({
      error: 'HELPER_READ_TOO_LARGE',
      returned: false,
      execution: { exitCode: 0, outputFile: expect.stringContaining('scratch/exec-') },
      nextRead: { name: 'data.exec' },
    });
    expect(result.nextRead.arguments.command).toMatch(/head -c 1000 -- 'scratch\/exec-/u);
    expect(bodies).toHaveLength(3);
    expect(toolResult(bodies[2])).toMatchObject({ exitCode: 0, output: '\0'.repeat(1000) });
    expect(task.status).toBe('completed');
    expect(readFileSync(counter, 'utf8')).toBe('x');
  }
);

linuxTest(
  'CLI discovers, queries and saves through the shared app dispatcher in one shell call',
  async () => {
    const f = await fixture();
    const bot = f.store.product.content(fixtureBotInput('CLI fixture', 'Original'));
    const chat = createFixtureChat(f.store, 'CLI outline target');
    const cli = `${process.execPath} ${resolve('runner/uimori.mjs')}`;
    const command = `python3 - <<'PY'
import json, subprocess
cli=${JSON.stringify([process.execPath, resolve('runner/uimori.mjs')])}
def call(name, args):
    return json.loads(subprocess.check_output(cli+['call',name,'--input','-'],input=json.dumps(args),text=True))
schemas=json.loads(subprocess.check_output(cli+['tools',json.dumps({'names':['resource.patch','db.query']})],text=True))
assert len(schemas['tools']) == 2
query=call('db.query',{'sql':'SELECT COUNT(*) AS n FROM agent_resources'})
assert query['rows'][0]['n'] >= 1
for value in ['First CLI save','Second CLI save']:
    current=call('resource.read',{'kind':'content','id':'${bot.id}'})
    result=call('resource.patch',{'kind':'content','id':'${bot.id}','expectedRevision':current['revision'],'changes':[{'op':'set','path':'/package/nativeRisu/card/creator_notes','value':value}]})
    assert result['revision'] == current['revision']+1
for _ in range(10):
    call('chat.list',{})
outline=call('outline.write',{'chatId':'${chat.id}','operations':[{'op':'create','level':'beat','title':'CLI outline','intent':'Saved after ten calls'}]})
assert len(outline['created']) == 1
print('Two guarded saves completed.')
PY
${cli} call data.exec '{"command":"echo recursion"}' > scratch/rejected.json
test $? -eq 1
python3 -c "import json; assert json.load(open('scratch/rejected.json'))['code']=='UNKNOWN_APP_TOOL'"`;
    const bodies = provider((body, round) =>
      round === 0 ? answer(body, { id: 'cli-script', arguments: { command } }) : answer(body)
    );
    const task = await f.run('Update creator notes twice using the CLI.');
    expect(task.status).toBe('completed');
    expect(bodies).toHaveLength(2);
    const tools = bodies[0].tools.map((tool: any) => tool.function.name);
    expect(tools).toHaveLength(3);
    expect(tools.some((name: string) => /_data_search$|_data_read$|_db_query$/u.test(name))).toBe(
      false
    );
    const result = toolResult(bodies[1]);
    expect(result).toMatchObject({ exitCode: 0, output: 'Two guarded saves completed.\n' });
    expect(result.applied).toHaveLength(3);
    expect(
      result.applied.every(
        (effect: any) =>
          ['resource.patch', 'outline.write'].includes(effect.name) && effect.receiptId
      )
    ).toBe(true);
    expect(new Set(result.applied.map((effect: any) => effect.receiptId)).size).toBe(3);
    expect((readResource(f.store, 'content', bot.id) as Content).description).toBe(
      'Second CLI save'
    );
    expect(readResource(f.store, 'content', bot.id).revision).toBe(bot.revision + 2);
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(task.id)?.n
    ).toBe(3);
  }
);

linuxTest(
  'CLI preserves a committed receipt and stops later writes after a post-commit app failure',
  async () => {
    const f = await fixture(() => {
      throw Object.assign(new Error('Synthetic reader notification failed'), { code: 'ENOENT' });
    });
    const chat = createFixtureChat(f.store, 'CLI target');
    const source = completedSource(f.store, chat.id, 'Before CLI scene edit.');
    const bot = f.store.product.content(fixtureBotInput('Must stay untouched', 'Original'));
    const marker = join(f.root, 'followup-result.json');
    const command = `python3 - <<'PY'
import json, subprocess
cli=${JSON.stringify([process.execPath, resolve('runner/uimori.mjs')])}
def call(name,args):
    return subprocess.run(cli+['call',name,'--input','-'],input=json.dumps(args),text=True,capture_output=True)
read=call('scene.read',{'chatId':'${chat.id}','sourceId':'${source.id}','target':'original'})
assert read.returncode == 0, read.stdout+read.stderr
target=json.loads(read.stdout)['editTarget']
save=call('scene.patch',dict(target,chatId='${chat.id}',text='Committed before notification failure.'))
assert save.returncode == 1, save.stdout+save.stderr
assert json.loads(save.stdout)['outcome']=='unknown'
followup=call('resource.patch',{'kind':'content','id':'${bot.id}','expectedRevision':${bot.revision},'changes':[{'op':'set','path':'/package/nativeRisu/card/creator_notes','value':'Must not save'}]})
open('${marker}','w').write(followup.stdout)
assert followup.returncode == 1
PY`;
    const bodies = provider((body, round) =>
      round === 0 ? answer(body, { id: 'cli-unknown', arguments: { command } }) : answer(body)
    );
    const task = await f.run('Edit the saved scene using the CLI.');
    expect(f.store.source(source.id).text).toBe('Committed before notification failure.');
    expect((readResource(f.store, 'content', bot.id) as Content).description).toBe(bot.description);
    expect(readResource(f.store, 'content', bot.id).revision).toBe(bot.revision);
    expect(JSON.parse(readFileSync(marker, 'utf8')).error).toBe('SHELL_EXECUTION_STOPPED');
    expect(task.status).toBe('failed');
    expect(task.completedEffects?.count).toBe(1);
    expect(bodies).toHaveLength(1);
    const finished = f.runtime.workspace
      .events(f.conversation.id)
      .find(
        (event) =>
          event.kind === 'tool.finished' &&
          (event.data as { callId?: string }).callId === 'cli-unknown'
      );
    expect(finished?.data).toMatchObject({
      denied: true,
      result: {
        outcome: 'unknown',
        applied: [expect.objectContaining({ name: 'scene.patch', receiptId: expect.any(String) })],
      },
    });
  }
);
