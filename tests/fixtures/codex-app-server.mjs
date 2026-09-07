import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write(
    'codex-cli ' + (process.env.UIMORI_CODEX_FIXTURE_VERSION ?? '0.153.0') + '\n'
  );
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const mode = process.env.UIMORI_CODEX_FIXTURE_MODE ?? 'normal';
const input = createInterface({ input: process.stdin });
let initialized = false;
let nextThread = 0;
let nextTurn = 0;
let loggedOut = mode === 'logged-out';
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (process.env.UIMORI_CODEX_FIXTURE_LOG)
    appendFileSync(process.env.UIMORI_CODEX_FIXTURE_LOG, line + '\n');
  const { id, method, params } = request;
  if (method === 'initialized') {
    initialized = true;
    return;
  }
  if (!method) {
    send({ method: 'fixture/clientResponse', params: request });
    return;
  }
  if (method === 'initialize') {
    if (mode === 'init-timeout') return;
    send({
      id,
      result: { userAgent: 'fixture', platformFamily: 'windows', platformOs: 'windows' },
    });
    return;
  }
  if (!initialized) {
    send({ id, error: { code: -1, message: 'not initialized' } });
    return;
  }
  if (method === 'fixture/hang') return;
  if (method === 'fixture/malformed') {
    process.stdout.write('secret-token-not-json\n');
    return;
  }
  if (method === 'fixture/oversized') {
    process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    return;
  }
  if (method === 'fixture/invalidUtf8') {
    process.stdout.write(
      Buffer.concat([
        Buffer.from('{"id":' + id + ',"result":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ])
    );
    return;
  }
  if (method === 'fixture/exit') {
    process.stderr.write('SECRET_AUTH_TOKEN\n');
    process.exit(1);
  }
  if (method === 'fixture/error') {
    send({ id, error: { code: -1, message: 'SECRET_AUTH_TOKEN' } });
    return;
  }
  if (method === 'fixture/approval') {
    send({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'secret' },
    });
    send({ id, result: {} });
    return;
  }
  if (method === 'fixture/delay') {
    setTimeout(() => send({ id, result: params }), 80);
    return;
  }
  if (method === 'account/read') {
    send({
      id,
      result: {
        account: loggedOut
          ? null
          : mode === 'api-key'
            ? { type: 'apiKey' }
            : { type: 'chatgpt', email: 'synthetic@example.invalid', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (method === 'account/login/start') {
    send({
      id,
      result: {
        type: 'chatgptDeviceCode',
        loginId: 'fixture-login',
        verificationUrl:
          process.env.UIMORI_CODEX_FIXTURE_LOGIN_URL ?? 'https://auth.openai.com/codex/device',
        userCode: 'TEST-1234',
      },
    });
    return;
  }
  if (method === 'account/login/cancel' || method === 'account/logout') {
    if (method === 'account/logout') loggedOut = true;
    send({ id, result: {} });
    return;
  }
  if (method === 'account/rateLimits/read') {
    const rateLimits = {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    };
    send({
      id,
      result: {
        rateLimits,
        rateLimitsByLimitId: { codex: rateLimits },
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
      },
    });
    return;
  }
  if (method === 'model/list') {
    send({
      id,
      result: {
        data: [
          {
            id: 'gpt-5.4',
            model: 'gpt-5.4',
            displayName: 'GPT-5.4',
            hidden: false,
            description: 'fixture',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }],
            defaultReasoningEffort: 'low',
            inputModalities: ['text'],
            supportsPersonality: false,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }
  if (method === 'thread/start') {
    if (mode === 'thread-hang') return;
    send({
      id,
      result: {
        thread: { id: 'fixture-thread-' + ++nextThread },
        model: mode === 'wrong-model' ? 'wrong-model' : params.model,
      },
    });
    return;
  }
  if (method === 'turn/start') {
    const threadId = params.threadId;
    const turnId = 'fixture-turn-' + ++nextTurn;
    const reply = () =>
      send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
    send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } });
    send({
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } },
    });
    if (mode !== 'early-completion') reply();
    if (mode === 'turn-hang') return;
    if (mode === 'turn-exit') {
      process.stderr.write('SECRET_AUTH_TOKEN');
      process.exit(1);
    }
    if (mode === 'builtin') {
      send({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item: { type: 'commandExecution', id: 'denied-tool', command: 'never execute' },
        },
      });
      return;
    }
    setTimeout(() => {
      const text = process.env.UIMORI_CODEX_FIXTURE_OUTPUT ?? '{"ok":true}';
      send({
        method: 'thread/tokenUsage/updated',
        params: { threadId, turnId, tokenUsage: { total: { inputTokens: 100, outputTokens: 30 } } },
      });
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'fixture-item-' + turnId, delta: text },
      });
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { type: 'agentMessage', id: 'fixture-item-' + turnId, text, phase: 'final_answer' },
        },
      });
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: mode === 'turn-error' ? 'failed' : 'completed',
            items: [],
            error: mode === 'turn-error' ? { message: 'SECRET_AUTH_TOKEN' } : null,
          },
        },
      });
      if (mode === 'early-completion') reply();
    }, 20);
    return;
  }
  send({ id, result: params });
});
