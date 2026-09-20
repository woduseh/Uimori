import assert from 'node:assert/strict';
import path from 'node:path';
import { assertBuild, json, newId, root } from './lib.mjs';
import { prepareNativeRisuText } from '../dist/server/risu-native-prepare.js';
import { evaluateNativeRisuFields } from '../dist/server/risu-native-cbs.js';
import { processNativeRisuText } from '../dist/server/risu-native-render.js';

const identity = await assertBuild();
const native = { version: 1, sourceHash: 'a'.repeat(64), card: { name: 'Synthetic' }, assets: [] };
const results = [];
async function measured(run) {
  globalThis.gc?.();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const started = performance.now();
  try {
    const value = await run();
    return {
      value,
      elapsedMs: performance.now() - started,
      initialRss,
      peakRss: Math.max(peakRss, process.memoryUsage().rss),
    };
  } finally {
    clearInterval(timer);
  }
}
for (const count of [10, 50, 100]) {
  const input = {
    native,
    fields: [{ key: 'bot', fields: { body: '{{setvar::step::0}}' } }],
    context: {
      variables: {},
      messages: Array.from({ length: count }, (_, index) => ({
        role: index % 2 ? 'user' : 'char',
        data: `Scene ${index}: ${'synthetic history '.repeat(100)}{{getvar::step}}{{setvar::step::${index + 1}}}`,
      })),
    },
  };
  for (let repeat = 0; repeat < 3; repeat++) {
    let sequentialWorkers = 0;
    const sequential = await measured(async () => {
      sequentialWorkers++;
      const field = await evaluateNativeRisuFields({
        native,
        context: input.context,
        fields: input.fields[0].fields,
      });
      let variables = field.variables;
      const texts = [];
      for (const [messageIndex, message] of input.context.messages.entries()) {
        sequentialWorkers++;
        const result = await processNativeRisuText({
          native,
          text: message.data,
          mode: 'editprocess',
          context: { ...input.context, variables, messageIndex },
        });
        variables = result.variables;
        texts.push(result.text);
      }
      return { fields: { bot: field.fields }, greeting: undefined, texts, variables, issues: [] };
    });
    const batched = await measured(() => prepareNativeRisuText(input));
    assert.deepEqual(batched.value, sequential.value);
    const { value: _old, ...before } = sequential;
    const { value: _new, ...after } = batched;
    const row = {
      count,
      repeat,
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      sequential: { ...before, workers: sequentialWorkers },
      batched: { ...after, workers: 1 },
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
const cancellation = new AbortController();
const pending = prepareNativeRisuText(
  {
    native: { ...native, module: { regex: [{ type: 'editprocess', in: '(a+)+$', out: '' }] } },
    fields: [],
    context: { variables: {}, messages: [{ role: 'user', data: 'a'.repeat(40) + '!' }] },
  },
  cancellation.signal
);
await new Promise((resolve) => setTimeout(resolve, 100));
const cancelledAt = performance.now();
cancellation.abort();
await assert.rejects(pending, /CANCELLED/);
const report = path.join(root, 'output/benchmarks', `native-preparation-${newId()}.json`);
await json(report, {
  identity,
  results,
  cancellationLatencyMs: performance.now() - cancelledAt,
  limitations:
    'Synthetic sequential versus batched text preparation only, no callbacks or providers. RSS is process-wide and sampled every 5ms; runs share allocator state, so this is not isolated per-worker memory.',
});
console.log(`Report: ${report}`);
