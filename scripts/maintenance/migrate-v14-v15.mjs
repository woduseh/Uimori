import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Use: migrate.mjs SOURCE TARGET VALIDATION_DB REPORT');
const [sourcePath, targetPath, validationPath, reportPath] = args.map((value) => resolve(value));
assert.equal(
  new Set([sourcePath, targetPath, validationPath, reportPath]).size,
  4,
  'Paths must differ'
);
assert(existsSync(sourcePath), 'Source snapshot missing');
for (const file of [targetPath, validationPath, reportPath]) {
  assert(!existsSync(file), 'Destination already exists');
  mkdirSync(dirname(file), { recursive: true });
}
const identity = JSON.parse(readFileSync('dist/build-identity.json', 'utf8'));
assert.equal(
  identity.buildId,
  '0a60c7c39dc7ad8c004a84d3b1f76433752335871de8408a792b6648b878f37c',
  'Unreviewed application build'
);
const { Store } = await import(pathToFileURL(resolve('dist/server/store.js')).href);
const { contextDependencyKey, measureMainContext } = await import(
  pathToFileURL(resolve('dist/server/context-planning.js')).href
);
const { validateRunSnapshot } = await import(
  pathToFileURL(resolve('dist/server/snapshot-archive.js')).href
);
const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const fileDigest = (file) => digest(readFileSync(file));
const sourceFileHash = fileDigest(sourcePath);
const source = new DatabaseSync(sourcePath, { readOnly: true });
const quote = (name) => {
  assert(/^[a-z_]+$/u.test(name), 'Unexpected schema identifier');
  return '"' + name + '"';
};
const tables = (db) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
const rows = (db, table) => db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all();
const columns = (db, table) => db.prepare(`PRAGMA table_info(${quote(table)})`).all();
const stableRows = (values) =>
  values.map((row) =>
    Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
  );
const tableDigest = (values) => digest(stableRows(values));
const report = {
  status: 'FAIL',
  startedAt: new Date().toISOString(),
  sourceSchema: 14,
  targetSchema: 15,
  buildId: identity.buildId,
  sourceFileHash,
  sourceDataHash: null,
  tableCounts: {},
  preservedTables: [],
  changedTables: [],
  transformations: {},
  runs: [],
  contextModel: 'unique previously selected memory model',
  helperModel: null,
  limitations: [
    'One-off conversion for an audited v14 database without extracted memory, state jobs, package execution state, compacted context, or active work.',
    'Original v14 volume/snapshot remains the complete historical source. Actual transmitted requests, outputs, sources and usage are not recompiled or rewritten.',
    'Archive import is validated in a separate database because import intentionally disables connections and strips credentials.',
    'No provider request or background worker is started by this script.',
  ],
};
let target;
let validation;
const changed = (kind, path) => {
  report.transformations[kind] ??= [];
  report.transformations[kind].push(path);
};
function program(node, path) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      program(value, `${path}/${index}`);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'slot') {
    for (const key of ['slot', 'name'])
      if (node[key] === 'memory') {
        node[key] = 'notes';
        changed('memorySlotToNotes', `${path}/${key}`);
      }
  }
  if (
    node.version === 1 &&
    Array.isArray(node.controls) &&
    Array.isArray(node.blocks) &&
    node.collaboration
  ) {
    for (const advisor of node.collaboration.agents ?? [])
      if (advisor.tools?.includes('memory')) {
        advisor.tools = advisor.tools.map((value) => (value === 'memory' ? 'notes' : value));
        changed('memoryToolToNotes', path + '/collaboration');
      }
  }
  for (const [key, value] of Object.entries(node)) program(value, `${path}/${key}`);
}
function normalize(node, path) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      normalize(value, `${path}/${index}`);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (
    typeof node.modelId === 'string' &&
    typeof node.id === 'string' &&
    'maxOutputTokens' in node &&
    'capabilityRevision' in node
  ) {
    delete node.capabilityRevision;
    changed('retiredCapabilityRevision', path + '/capabilityRevision');
  }
  if (node.target === 'memory')
    throw new Error('Memory-only package instructions require a separately reviewed conversion');
  for (const [key, value] of Object.entries(node)) normalize(value, `${path}/${key}`);
}
try {
  assert.equal(source.prepare('PRAGMA user_version').get().user_version, 14, 'Expected v14 source');
  assert.equal(source.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(source.prepare('PRAGMA foreign_key_check').all().length, 0);
  const sourceTables = tables(source);
  const sourceRows = new Map(sourceTables.map((table) => [table, rows(source, table)]));
  report.sourceDataHash = digest(
    sourceTables.map((table) => [table, tableDigest(sourceRows.get(table))])
  );
  assert.equal(
    report.sourceDataHash,
    '63658eec83de2b9e8f2f7cac3e9a9d91a7647a330996e354b29a08aa0268e9ce',
    'Source differs from the reviewed 2026-09-09 snapshot; review a fresh backup before changing this guard'
  );
  const mustBeEmpty = [
    'story_memories',
    'story_indexes',
    'story_jobs',
    'story_states',
    'package_behavior_heads',
    'package_behavior_journal',
    'package_behavior_opportunities',
    'package_behavior_outputs',
    'package_behavior_runs',
    'package_behavior_states',
    'package_requests',
  ];
  for (const table of mustBeEmpty)
    assert.equal(sourceRows.get(table)?.length ?? 0, 0, `Unsupported existing rows: ${table}`);
  for (const [table, values] of sourceRows)
    for (const row of values) {
      assert(
        !['queued', 'running', 'waiting_for_state', 'pending', 'executing', 'started'].includes(
          row.status
        ),
        `Active work in ${table}`
      );
    }
  const memoryModels = [
    ...new Set(
      sourceRows
        .get('story_configs')
        .map((row) => JSON.parse(row.body).memory?.model?.id)
        .filter(Boolean)
    ),
  ];
  assert.equal(
    memoryModels.length,
    1,
    'Context model mapping requires one unambiguous previous selection'
  );
  assert(
    sourceRows
      .get('provider_settings')
      .some((row) => row.kind === 'model' && row.id === memoryModels[0]),
    'Previous memory model missing'
  );
  target = new Store(targetPath);
  const targetTables = new Set(tables(target.db));
  for (const [table, values] of sourceRows)
    assert(targetTables.has(table) || values.length === 0, `Nonempty retired table: ${table}`);
  const expectedRows = new Map();
  target.transaction(() => {
    target.db.exec('PRAGMA defer_foreign_keys=ON');
    for (const table of sourceTables.filter((table) => targetTables.has(table)))
      target.db.exec(`DELETE FROM ${quote(table)}`);
    for (const [table, values] of sourceRows) {
      if (!targetTables.has(table)) continue;
      const targetColumns = columns(target.db, table);
      const originalColumns = columns(source, table).map((c) => c.name);
      for (const name of originalColumns)
        assert(
          targetColumns.some((c) => c.name === name),
          `Removed nonempty column: ${table}.${name}`
        );
      const insert = target.db.prepare(
        `INSERT INTO ${quote(table)}(${originalColumns.map(quote).join(',')}) VALUES(${originalColumns.map(() => '?').join(',')})`
      );
      const mapped = [];
      for (let index = 0; index < values.length; index++) {
        const row = { ...values[index] };
        const field =
          table === 'runs'
            ? 'snapshot'
            : table === 'jobs'
              ? 'input'
              : ['versions', 'provider_settings', 'prompt_workspace', 'story_configs'].includes(
                    table
                  )
                ? 'body'
                : null;
        if (field && row[field] !== null) {
          let value = JSON.parse(row[field]);
          const at = `${table}/${index}/${field}`;
          normalize(value, at);
          program(value, at);
          if (table === 'story_configs') {
            delete value.memory;
            changed('retiredMemoryExtractionConfiguration', at + '/memory');
          }
          if (table === 'prompt_workspace') {
            value.contextModel = { id: memoryModels[0] };
            value.helperModel = null;
            changed('globalContextModelFromPreviousMemorySelection', at + '/contextModel');
            changed('newHelperModelUnselected', at + '/helperModel');
          }
          if (table === 'runs') {
            assert.equal(row.status, 'completed', 'Only completed historical Runs are reviewed');
            assert(
              !value.story && !value.candidateOf && !value.forkedFrom && !value.sourceSegments,
              'Additional snapshot semantics require review'
            );
            assert.equal(value.contextPlan.status, 'ready');
            assert.equal(value.contextPlan.summary, null);
            assert.equal(value.contextPlan.summaryCalls, 0);
            assert.equal(value.contextPlan.compacted.length, 0);
            const original = JSON.parse(values[index][field]);
            value.contextPlan.dependencyKey = contextDependencyKey(value);
            delete value.promptCompilation;
            const measured = measureMainContext(value);
            value = measured.snapshot;
            value.contextPlan.estimatedInputTokens = measured.estimatedInputTokens;
            const messageContent = (compilation) =>
              compilation.messages.map((message) => ({
                id: message.id,
                role: message.role,
                text: message.text,
              }));
            assert.deepEqual(
              messageContent(value.promptCompilation),
              messageContent(original.promptCompilation),
              'Historical prompt messages changed'
            );
            assert.deepEqual(
              value.logicalHistory,
              original.logicalHistory,
              'Logical history changed'
            );
            report.runs.push({
              id: row.id,
              beforeSnapshotHash: digest(values[index][field]),
              afterSnapshotHash: digest(JSON.stringify(value)),
              beforeEstimate: original.contextPlan.estimatedInputTokens,
              afterEstimate: measured.estimatedInputTokens,
              transmittedPromptMessagesPreserved: true,
              source: row.source_revision,
            });
          }
          row[field] = JSON.stringify(value);
        }
        insert.run(...originalColumns.map((column) => row[column]));
        mapped.push(row);
      }
      expectedRows.set(table, mapped);
    }
  });
  assert.equal(target.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(target.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  for (const [table, expected] of expectedRows) {
    const originalColumns = columns(source, table).map((c) => c.name);
    const actual = rows(target.db, table).map((row) =>
      Object.fromEntries(originalColumns.map((column) => [column, row[column]]))
    );
    assert.deepEqual(actual, expected, `Copied values differ: ${table}`);
    const before = tableDigest(sourceRows.get(table));
    const after = tableDigest(actual);
    report.tableCounts[table] = { before: sourceRows.get(table).length, after: actual.length };
    (before === after ? report.preservedTables : report.changedTables).push({
      table,
      before,
      after,
    });
  }
  for (const row of rows(target.db, 'runs'))
    validateRunSnapshot(target, JSON.parse(row.snapshot), row.id);
  const unchanged = new Set(report.preservedTables.map((entry) => entry.table));
  for (const table of [
    'sources',
    'attempts',
    'model_inputs',
    'tool_events',
    'job_results',
    'chats',
    'branches',
    'profiles',
    'provider_connection_tests',
  ])
    assert(unchanged.has(table), `Historical data was changed: ${table}`);
  validation = new Store(validationPath);
  validation.product.import(target.product.export());
  assert.equal(validation.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  report.archiveRoundTrip = 'PASS in separate credential-normalizing scratch database';
  report.sourceUnchanged = sourceFileHash === fileDigest(sourcePath);
  assert(report.sourceUnchanged, 'Source file changed');
  validation.close();
  validation = null;
  target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  target.close();
  target = null;
  report.targetFileHash = fileDigest(targetPath);
  report.status = 'PASS';
  console.log(
    JSON.stringify({
      status: report.status,
      sourceDataHash: report.sourceDataHash,
      targetFileHash: report.targetFileHash,
      preservedTables: report.preservedTables.length,
      changedTables: report.changedTables.map((row) => row.table),
      runs: report.runs.length,
    })
  );
} catch (error) {
  report.error = error instanceof Error ? error.message.split('\n')[0] : 'Migration failed';
  console.error(report.error);
  process.exitCode = 1;
} finally {
  validation?.close();
  target?.close();
  source.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
