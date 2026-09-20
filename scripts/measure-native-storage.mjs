import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { defaultProfile } from '../dist/core/product.js';
import { projectNativeRisuPackage } from '../dist/server/risu-native-projection.js';
import { prepareNativeRisuRun } from '../dist/server/risu-native-run.js';
import { assertBuild, root, newId, json } from './lib.mjs';

const identity = await assertBuild();
const directory = path.join(root, 'output', 'benchmarks', `native-storage-${newId()}`);
await mkdir(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, 'synthetic.sqlite'));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const card = { name: 'Synthetic storage card', description: 'A synthetic guide.' };
const pkg = projectNativeRisuPackage(
  {
    version: 1,
    id: 'synthetic',
    revision: 1,
    title: card.name,
    description: '',
    lore: [],
    instructions: [],
    nativeRisu: {
      version: 1,
      card,
      assets: [],
      sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
    },
  },
  'bot'
).pkg;
const results = [];
try {
  db.exec('CREATE TABLE snapshots (scene_count INTEGER PRIMARY KEY, snapshot TEXT NOT NULL)');
  for (const count of [10, 100, 300]) {
    const history = Array.from({ length: count }, (_, index) => ({
      revision: `source-${index}`,
      text: (`Scene ${index}. ` + 'Synthetic history. '.repeat(500)).slice(0, 8000),
    }));
    const snapshot = await prepareNativeRisuRun(
      {
        chatId: 'synthetic',
        parentRevision: history.at(-1).revision,
        settingsRevision: 1,
        settings: {},
        request: 'Continue.',
        resources: [],
        history,
        logicalHistory: history.map((source) => ({
          id: `source:${source.revision}`,
          role: 'assistant',
          text: source.text,
        })),
        profile: {
          ...defaultProfile('synthetic'),
          models: {},
          packages: [pkg],
          packageAttachments: [{ id: pkg.id, revision: 1, role: 'bot' }],
        },
      },
      { preview: true }
    );
    const strings = new Map();
    const collect = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'text' || key === 'data') && typeof child === 'string' && child.length >= 100)
          strings.set(child, (strings.get(child) ?? 0) + 1);
        else if (typeof child === 'object') collect(child);
      }
    };
    collect(snapshot);
    const native = snapshot.nativeRisuExecution;
    db.prepare('INSERT INTO snapshots VALUES (?,?)').run(count, JSON.stringify(snapshot));
    results.push({
      count,
      manuscriptBytes: history.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
      snapshotBytes: bytes(snapshot),
      historyBytes: bytes(snapshot.history),
      logicalHistoryBytes: bytes(snapshot.logicalHistory),
      nativeHistoryBytes: bytes(native.history),
      nativeMessagesBytes: bytes(native.messages),
      preRequestBytes: bytes(native.preRequest),
      duplicatedTextBytes: [...strings].reduce(
        (sum, [text, copies]) => sum + Buffer.byteLength(text) * (copies - 1),
        0
      ),
      sqliteBytes:
        Number(db.prepare('PRAGMA page_count').get().page_count) *
        Number(db.prepare('PRAGMA page_size').get().page_size),
    });
  }
} finally {
  db.close();
}
const report = {
  identity,
  results,
  limitations:
    'Synthetic 8 KB scenes, actual native preparation and JSON stored in a measurement SQLite table. Three isolated history lengths, not cumulative production growth. No model calls, request/output callbacks, prompt wire receipts, indexes or archive overhead. Duplicated text is an upper-bound opportunity, not a migration saving guarantee.',
};
await json(path.join(directory, 'summary.json'), report);
console.log(JSON.stringify({ results, limitations: report.limitations }));
console.log(`Report: ${path.join(directory, 'summary.json')}`);
