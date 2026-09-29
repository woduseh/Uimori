// Synthetic stdio server for the writer -> advisor -> terminal-submission integration.
// Scripts are test-owned JSON; this process never calls a model or reads account credentials.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.158.0');
  process.exit(0);
}
const scripts = JSON.parse(process.env.UIMORI_CODEX_FIXTURE_SCRIPT);
const send = (message) => console.log(JSON.stringify(message));
const threadId = 'synthetic-thread';
const turnId = 'synthetic-turn';
let model;
let steps;
let index = 0;
function step() {
  const current = steps[index];
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { total: { inputTokens: (index + 1) * 100, outputTokens: (index + 1) * 30 } },
    },
  });
  if (!current || current.hang) return;
  if (current.text !== undefined) {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: current.text },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed', error: null } },
    });
    return;
  }
  const callId = `script-${index}`;
  const tool = `uimori_${current.name.replaceAll('.', '_')}`;
  send({
    method: 'item/started',
    params: {
      threadId,
      turnId,
      item: {
        type: 'dynamicToolCall',
        id: callId,
        tool,
        arguments: current.args,
        status: 'inProgress',
      },
    },
  });
  send({
    id: callId,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId,
      callId,
      namespace: 'uimori',
      tool,
      arguments: current.args,
    },
  });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (process.env.UIMORI_CODEX_FIXTURE_LOG)
    appendFileSync(
      process.env.UIMORI_CODEX_FIXTURE_LOG,
      JSON.stringify({ model, ...message }) + '\n'
    );
  if (method === 'initialized') return;
  if (method === 'initialize') return send({ id, result: { userAgent: 'synthetic' } });
  if (method === 'account/read')
    return send({ id, result: { account: { type: 'chatgpt', planType: 'pro' } } });
  if (method === 'thread/start') {
    model = params.model;
    return send({ id, result: { thread: { id: threadId }, model } });
  }
  if (method === 'turn/start') {
    steps = scripts[model];
    if (!steps) throw new Error('Missing synthetic model script');
    send({
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'inProgress', error: null } },
    });
    send({ id, result: { turn: { id: turnId } } });
    step();
    return;
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'interrupted', error: null } },
    });
    return;
  }
  if (!method && steps) {
    if (message.error) return;
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: `script-${index}`,
          status: 'completed',
          ...message.result,
        },
      },
    });
    index++;
    step();
    return;
  }
  send({ id, result: {} });
});
