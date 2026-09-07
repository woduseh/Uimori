// Local prepared-package assembly. Original files are streamed only for SHA-256;
// they are never parsed, copied, modified, or used as runtime prompt inputs here.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = join(root, 'output/native-porting');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--bot-source') {
  console.error('Usage: node scripts/native-local-fixture.mjs --bot-source <original-charx-path>');
  process.exit(1);
}
// Load current checked-out server code without touching dist or installing tooling.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL);
      const path = fileURLToPath(candidate);
      if ((path.startsWith(join(root, 'core') + '/') || path.startsWith(join(root, 'server') + '/') || path.startsWith(join(root, 'core') + '\\') || path.startsWith(join(root, 'server') + '\\')) && existsSync(path)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    return next(url, context);
  },
});
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = async path => { const digest = createHash('sha256'); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest('hex'); };
const check = (ok, code) => { if (!ok) throw new Error(code); };
await mkdir(inputs, { recursive: true });
const directory = await mkdtemp(join(inputs, 'actual-preview-'));
const dbPath = join(directory, 'actual-preview.sqlite');
const report = { status: 'FAIL', scope: 'Local runtime assembly of prepared private packages; no external execution or new source-equivalence claim.', startedAt: new Date().toISOString(), sources: [], previews: [] };
let store;
try {
  report.sourceHash = (await fingerprint()).hash;
  const [{ Store }, { HiddenStoryStore }] = await Promise.all([import(pathToFileURL(join(root, 'server/store.ts')).href), import(pathToFileURL(join(root, 'server/hidden-story.ts')).href)]);
  const normal = await readJson(join(inputs, 'pheme/converted-normal.json'));
  const tool = await readJson(join(inputs, 'pheme/converted-tool.json'));
  const bot = await readJson(join(inputs, 'hinano/package.json'));
  const hidden = await readJson(join(inputs, 'hidden-story/converted.native.json'));
  const daily = await readJson(join(inputs, 'hidden-story/daily-config.json'));
  const normalMeta = await readJson(join(inputs, 'pheme/normal-structured.json'));
  const toolMeta = await readJson(join(inputs, 'pheme/tool-call-structured.json'));
  const hiddenMeta = await readJson(join(inputs, 'hidden-story/source-structured.json'));
  const sourceFiles = [
    { id: 'pheme-normal', path: normalMeta.file_path, expected: normal.program.provenance.sourceHash },
    { id: 'pheme-tool', path: toolMeta.file_path, expected: tool.program.provenance.sourceHash },
    { id: 'bot-original', path: resolve(args[1]) },
    { id: 'hidden-story', path: hiddenMeta.source.path, expected: hidden.source.hash },
  ];
  for (const source of sourceFiles) { const before = await sha(source.path); check(!source.expected || before === source.expected, 'PREPARED_SOURCE_HASH_MISMATCH'); report.sources.push({ id: source.id, before }); }
  check(bot.provenance.mode === 'nonsexual-adaptation' || bot.provenance.mode === 'synthetic', 'NONSEXUAL_BOT_REQUIRED');
  check(daily.contentPolicy === 'nonsexual', 'NONSEXUAL_HIDDEN_POLICY_REQUIRED');
  store = new Store(dbPath);
  const hiddenStore = new HiddenStoryStore(store.product);
  const importedBot = store.native.importPackage(bot);
  const importedHidden = hiddenStore.import({ title: 'Local Hidden Story daily preview', conversion: hidden });
  report.native = { scenes: importedBot.scenes.length, actions: importedBot.actions.length, lore: importedBot.lore.length, assets: importedBot.assets.length, originalBodiesCopied: 0, originalImagesCopied: 0 };
  report.hidden = { imported: true, controls: importedHidden.program.controls.length, contentPolicy: daily.contentPolicy };
  for (const [variant, converted] of [['normal', normal], ['tool-call', tool]]) {
    const preset = store.product.promptPreset({ title: `Local Phēmē ${variant}`, role: 'main', text: '', program: converted.program });
    const chat = store.createChat(`Local native preview (${variant})`);
    store.settings(chat.id, chat.settingsRevision, { ...chat.settings, translation: false, status: false });
    const branchId = `main:${chat.id}`;
    let native = store.native.attach(chat.id, { branchId, packageId: importedBot.id, packageRevision: importedBot.revision, expectedRevision: 0, expectedSourceRevision: null, expectedSourceHash: null, idempotencyKey: randomUUID() });
    for (const command of [{ kind: 'language', value: 'kr' }, { kind: 'scene', id: importedBot.scenes[0].id }, { kind: 'clear-pending' }]) native = store.native.command(chat.id, { branchId, expectedRevision: native.revision, expectedSourceRevision: null, expectedSourceHash: null, idempotencyKey: randomUUID(), command });
    const prior = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, { expectedRevision: prior.revision, attachments: [], creative: prior.creative, routes: { main: null, translation: null, status: null, image: null }, image: false, prompts: { main: { id: preset.id, revision: preset.revision } }, promptControls: { [`${preset.id}@${preset.revision}`]: { values: converted.suggestedCombination.values, combinations: [converted.suggestedCombination], selectedCombinationId: converted.suggestedCombination.id } }, hiddenStory: { module: { id: importedHidden.id, revision: importedHidden.revision }, config: daily, insertion: 'before-current' } });
    const current = store.chat(chat.id);
    const run = store.createRun(chat.id, { branchId, request: 'Synthetic preview: describe a quiet, nonsexual day at the library.', expectedRevision: null, expectedSettingsRevision: current.settingsRevision, idempotencyKey: randomUUID() }, selected => { const profile = store.product.snapshot(chat.id); return { chatId: chat.id, parentRevision: null, settingsRevision: selected.settingsRevision, settings: selected.settings, request: 'Synthetic preview: describe a quiet, nonsexual day at the library.', history: [], resources: store.product.resources(chat.id, profile), profile }; }).run;
    const compiled = run.snapshot.promptCompilation;
    check(compiled?.messages.length > 0 && run.snapshot.hiddenStory && run.snapshot.nativeBot, 'RUNTIME_ASSEMBLY_MISSING');
    check(compiled.messages.some(message => message.role === 'user'), 'USER_ROLE_MISSING');
    check(run.snapshot.hiddenStory.config.contentPolicy === 'nonsexual', 'FROZEN_POLICY_MISMATCH');
    check(run.snapshot.hiddenStory.messages.every(hiddenMessage => compiled.messages.some(message => message.id === hiddenMessage.id && JSON.stringify(message.content) === JSON.stringify(hiddenMessage.content))), 'HIDDEN_MESSAGES_NOT_INSERTED');
    check(compiled.messages.some(message => message.content.some(part => part.text?.includes(importedBot.instructions))), 'NATIVE_INSTRUCTIONS_MISSING');
    check(Object.values(run.snapshot.profile.routes).every(value => value === null), 'MODEL_ROUTE_PRESENT');
    store.finishRun(run.id, 'cancelled', 'Local preview only; no provider execution.');
    report.previews.push({ variant, chatId: chat.id, presetId: preset.id, controls: converted.program.controls.length, blocks: converted.program.blocks.length, messages: compiled.messages.length, roles: compiled.messages.map(message => message.role), cacheAnchors: compiled.cachePlan.length, hiddenMessages: run.snapshot.hiddenStory.messages.length, nativeInstructionsPresent: true, nativeCommands: 3, pendingCleared: store.native.snapshot(chat.id, branchId).pending === null, runStatus: store.run(run.id).status });
  }
  const count = table => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  report.counts = { chats: count('chats'), runs: count('runs'), sources: count('sources'), attempts: count('attempts'), jobs: count('jobs'), connections: store.product.all('connection').length, models: store.product.all('model').length, presets: store.product.all('prompt-preset').length };
  check(report.counts.attempts === 0 && report.counts.jobs === 0 && report.counts.sources === 0 && report.counts.connections === 0 && report.counts.models === 0, 'NO_EXECUTION_INVARIANT');
  check(Number(store.db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running','waiting_for_state')").get().n) === 0, 'ACTIVE_RUN_REMAINS');
  const comparison = await readJson(join(inputs, 'pheme/conversion-verification.json'));
  report.priorSourceComparison = { reusedEvidence: 'pheme/conversion-verification.json', newlyExecuted: false, cases: comparison.variants.reduce((sum, item) => sum + item.cases.length, 0), allMatched: comparison.variants.every(item => item.cases.every(test => test.matches)), controlsPerVariant: comparison.variants.map(item => item.controls) };
  for (let i = 0; i < sourceFiles.length; i++) { report.sources[i].after = await sha(sourceFiles[i].path); report.sources[i].unchanged = report.sources[i].before === report.sources[i].after; check(report.sources[i].unchanged, 'ORIGINAL_CHANGED'); }
  check((await fingerprint()).hash === report.sourceHash, 'SOURCE_CHANGED_DURING_LOCAL_ASSEMBLY');
  report.identityVerifiedAt = new Date().toISOString();
  report.status = 'PASS';
} catch {
  // Do not echo validator messages: malformed private packages may include prose.
  report.failure = 'LOCAL_ASSEMBLY_FAILED; inspect inputs and contracts locally without logging private bodies.';
  process.exitCode = 1;
} finally {
  store?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const escaped = dbPath.replaceAll("'", "''");
  await writeFile(join(directory, 'OPEN-PREVIEW.md'), `# Local preview\n\nRun from the repository root after npm run build:\n\n\`\`\`powershell\n$env:NR_DB = '${escaped}'\n$env:NR_PORT = '4311'\n$env:NR_PROVIDER_ORIGINS = ''\n$env:NR_TEST_MODE = '0'\nnode dist/server/index.js\n\`\`\`\n\nBoth presets and nonsexual native/hidden settings are stored locally. No model connection is configured. Two cancelled synthetic preview Runs retain private compiled inputs; no source or provider attempt was created. This DB and its reports must stay ignored.\n`);
  console.log(JSON.stringify({ status: report.status, directory: relative(root, directory), attempts: report.counts?.attempts ?? null, previews: report.previews.length }));
}
