import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { assertBuild, root } from './lib.mjs';

// Manual synthetic measurement. Alternate emitted runtimes are diagnostic comparisons, not gates.
const args = process.argv.slice(2);
if (args.some((arg) => !/^--(?:runtime|counts|label)=/.test(arg)))
  throw new Error('UNKNOWN_ARGUMENT');
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runtime = path.resolve(root, option('runtime', 'dist'));
const inside = path.relative(root, runtime);
if (path.isAbsolute(inside) || inside.startsWith('..'))
  throw new Error('RUNTIME_OUTSIDE_WORKSPACE');
const label = option('label', 'current');
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('INVALID_LABEL');
const counts = option('counts', '100,300,1000').split(',').map(Number);
if (!counts.length || counts.some((value) => !Number.isInteger(value) || value < 1 || value > 5000))
  throw new Error('INVALID_COUNTS');
const identity =
  runtime === path.join(root, 'dist') ? await assertBuild() : { diagnosticRuntime: inside };
const { Store } = await import(pathToFileURL(path.join(runtime, 'server/store.js')).href);
const { importChatTranscript, exportChatTranscript } = await import(
  pathToFileURL(path.join(runtime, 'server/chat-transcript.js')).href
);
const base = path.join(root, 'output', 'transcript-storage');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, `${label}-`));
const samples = [];
for (const count of counts) {
  const file = path.join(directory, `${count}.sqlite`);
  const store = new Store(file);
  try {
    const bot = store.product.content({
      kind: 'bot',
      title: 'Synthetic import bot',
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: 'benchmark',
        revision: 1,
        title: 'Synthetic import bot',
        description: '',
        body: '',
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
      },
    });
    const transcript = {
      format: 'uimori-chat-transcript',
      version: 1,
      exportedAt: new Date().toISOString(),
      title: `Synthetic ${count}`,
      attachments: [],
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: Array.from({ length: count }, (_, index) => ({
        request: `Scene ${index}`,
        text: (`Scene ${index}. ` + 'Synthetic prose. '.repeat(100)).slice(0, 1000),
        translation: null,
      })),
    };
    const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const start = performance.now();
    const timer = new Promise((done) => setTimeout(() => done(performance.now() - start), 0));
    const imported = importChatTranscript(store, { transcript, idempotencyKey: 'measurement' });
    const elapsedMs = performance.now() - start;
    const eventLoopDelayMs = await timer;
    const snapshotBytes = Number(
      store.db
        .prepare('SELECT SUM(length(snapshot)) AS n FROM runs WHERE chat_id=?')
        .get(imported.chat.id).n
    );
    const attempts = Number(store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n);
    const roundTripMatches =
      hash(exportChatTranscript(store, imported.chat.id).entries) === hash(transcript.entries);
    if (attempts || !roundTripMatches) throw new Error('IMPORT_PRESERVATION_FAILED');
    store.close();
    const result = {
      count,
      uniqueTextChars: count * 1000,
      elapsedMs,
      eventLoopDelayMs,
      snapshotBytes,
      databaseBytes: (await stat(file)).size,
      processPeakRssKb: process.resourceUsage().maxRSS,
      attempts,
      roundTripMatches,
    };
    samples.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    try {
      store.close();
    } catch {}
    throw error;
  }
}
const moduleHashes = Object.fromEntries(
  await Promise.all(
    ['server/chat-transcript.js', 'server/reservation-snapshot.js'].map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(path.join(runtime, name)))
        .digest('hex'),
    ])
  )
);
const report = {
  identity,
  moduleHashes,
  measurement:
    'Synthetic authored import; processPeakRssKb is cumulative for this process, timer delay includes synchronous import',
  samples,
};
const output = path.join(directory, 'results.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Measurements: ${output}`);
