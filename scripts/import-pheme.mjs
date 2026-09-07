// Local-only structured import. Obtain source JSON through RisuToki read_content first.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'output/native-porting/pheme');
const hash = value => createHash('sha256').update(value).digest('hex');
const modules = join(output, 'runtime');
await mkdir(modules, { recursive: true });
for (const name of ['prompt-program', 'pheme-converter']) {
  const source = await readFile(join(root, `core/${name}.ts`), 'utf8');
  await writeFile(join(modules, `${name}.js`), stripTypeScriptTypes(source, { mode: 'transform' }));
}
const { convertPhemePreset } = await import(pathToFileURL(join(modules, 'pheme-converter.js')).href);
const { compilePromptProgram } = await import(pathToFileURL(join(modules, 'prompt-program.js')).href);

// Independent restricted reference evaluator for the known source surface. This evaluates only
// synthetic comparison values; it is not shipped as a runtime or a general CBS interpreter.
function reference(source, values, slots, slot) {
  let text = source;
  const display = value => value === null || value === undefined ? 'null' : typeof value === 'boolean' ? value ? '1' : '0' : String(value);
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    text = text.replace(/\{\{(getglobalvar|and|any|equal|notequal|greater|greaterequal|length|replace)::([^{}]*)\}\}/gu, (_, op, raw) => {
      const args = raw.split('::'); changed = true;
      if (op === 'getglobalvar') return display(values[args[0].slice(7)]);
      if (op === 'and') return args[0] === '1' && args[1] === '1' ? '1' : '0';
      if (op === 'any') return args.includes('1') ? '1' : '0';
      if (op === 'equal') return args[0] === args[1] ? '1' : '0';
      if (op === 'notequal') return args[0] !== args[1] ? '1' : '0';
      if (op === 'greater') return Number(args[0]) > Number(args[1]) ? '1' : '0';
      if (op === 'greaterequal') return Number(args[0]) >= Number(args[1]) ? '1' : '0';
      if (op === 'length') return String(args[0].length);
      if (op === 'replace') return args[0].replaceAll(args[1], args[2]);
      throw new Error('REFERENCE_OPERATION_UNSUPPORTED');
    });
    if (!changed) break;
    if (pass === 49) throw new Error('REFERENCE_EXPRESSION_LIMIT');
  }
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    text = text.replace(/\{\{#when::([^{}]*)\}\}((?:(?!\{\{#when::)[\s\S])*?)\{\{\/when\}\}/gu, (_, condition, body) => {
      changed = true; const parts = condition.split('::'); let enabled;
      if (parts.length === 1) enabled = parts[0] === '1' || parts[0] === 'true';
      else if (parts[0] === 'toggle') enabled = ['1','true'].includes(display(values[parts[1]]));
      else if (parts[1] === 'tis') enabled = display(values[parts[0]]) === parts[2];
      else if (parts[1] === 'tisnot') enabled = display(values[parts[0]]) !== parts[2];
      else throw new Error('REFERENCE_CONDITION_UNSUPPORTED');
      if (!body.includes('\n')) { const split = body.indexOf('{{:else}}'); return split < 0 ? enabled ? body : '' : enabled ? body.slice(0, split) : body.slice(split + 9); }
      let lines = body.split('\n'); const split = lines.findIndex(line => line.trim() === '{{:else}}');
      lines = split < 0 ? enabled ? lines : [] : enabled ? lines.slice(0, split) : lines.slice(split + 1);
      let start = 0, end = lines.length;
      while (start < end && !lines[start].trim()) start++;
      while (end > start && !lines[end - 1].trim()) end--;
      return lines.slice(start, end).join('\n');
    });
    if (!changed) break;
    if (pass === 99) throw new Error('REFERENCE_CONDITION_LIMIT');
  }
  text = text.replaceAll('{{char}}', slots.char);
  if (slot) text = text.replace('{{slot}}', slots[slot]);
  if (text.includes('{{') || text.includes('}}')) throw new Error('REFERENCE_UNRESOLVED_SYNTAX');
  return text;
}

const slots = { char: 'Synthetic character', persona: 'Synthetic persona', description: 'Synthetic setting', lorebook: 'Synthetic lore', memory: 'Synthetic memory', authorNote: 'Synthetic note', globalNote: 'Synthetic global note', postEverything: 'Synthetic post material' };
const history = [
  { id: 'greeting', role: 'assistant', text: 'Synthetic greeting' },
  { id: 'u1', role: 'user', text: 'Synthetic earlier user' },
  { id: 'a1', role: 'assistant', text: 'Synthetic earlier reply' },
  { id: 'u2', role: 'user', text: 'Synthetic recent user' },
  { id: 'a2', role: 'assistant', text: 'Synthetic recent reply' },
  { id: 'current', role: 'user', text: 'Synthetic current input', current: true },
];
const report = { verifier: 'independent-restricted-cbs-reference-1', scope: 'Ordered logical messages under one-text-per-slot context; no provider wire or literary-quality claim.', variants: [] };
for (const [name, variant] of [['normal', 'normal'], ['tool-call', 'tool-call']]) {
  const path = join(output, `${name}-structured.json`);
  const within = relative(output, path); if (isAbsolute(within) || within.startsWith('..')) throw new Error('PRIVATE_OUTPUT_PATH_REQUIRED');
  const input = JSON.parse(await readFile(path, 'utf8'));
  const sourceHash = hash(await readFile(input.file_path));
  const converted = convertPhemePreset(input, { sourceHash, variant });
  const destination = join(output, `converted-${variant === 'normal' ? 'normal' : 'tool'}.json`);
  await writeFile(destination, JSON.stringify(converted, null, 2));
  const base = converted.suggestedCombination.values;
  const cases = [{ id: 'unset', values: {} }, { id: 'suggested-native', values: base }];
  for (const c of converted.program.controls) {
    const values = { ...base, [c.id]: c.type === 'boolean' ? true : c.type === 'select' ? c.options.at(-1).value : c.id.includes('length') ? '2400' : 'Synthetic reference' };
    cases.push({ id: c.id, values });
  }
  for (const mode of ['0','1','2']) cases.push({ id: `mode-${mode}-all-flags`, values: { ...base, ...Object.fromEntries(converted.program.controls.filter(c => c.type === 'boolean').map(c => [c.id, true])), pheme_session_mode: mode } });
  const results = [];
  for (const scenario of cases) {
    const compilation = compilePromptProgram(converted.program, { values: scenario.values, slots, history });
    const expected = [];
    for (const item of input.promptTemplate) {
      if (item.type === 'cache') continue;
      if (item.type === 'chat') {
        const offset = n => Math.max(0, n < 0 ? history.length + n : n);
        expected.push(...history.slice(offset(item.rangeStart), item.rangeEnd === 'end' ? history.length : offset(item.rangeEnd)).map(h => ({ role: h.role, text: h.text })));
      } else {
        const slot = ({ persona: 'persona', description: 'description', lorebook: 'lorebook', memory: 'memory', authornote: 'authorNote', postEverything: 'postEverything' })[item.type] ?? (item.type2 === 'globalNote' ? 'globalNote' : undefined);
        const text = item.type === 'plain' ? reference(item.text, compilation.values, slots, slot) : item.innerFormat ? reference(item.innerFormat, compilation.values, slots, slot) : slots[slot];
        const role = item.role ?? item.role2 ?? 'system';
        if (text) expected.push({ role: role === 'bot' ? 'assistant' : role, text });
      }
    }
    const actual = compilation.messages.map(message => ({ role: message.role, text: message.content[0].text }));
    const matches = JSON.stringify(actual) === JSON.stringify(expected);
    if (!matches) {
      const index = actual.findIndex((message, i) => JSON.stringify(message) !== JSON.stringify(expected[i]));
      results.push({ id: scenario.id, matches, firstDifferentMessage: index, actualHash: hash(JSON.stringify(actual)), expectedHash: hash(JSON.stringify(expected)) });
    } else results.push({ id: scenario.id, matches, messages: actual.length, cacheAnchors: compilation.cachePlan.length, outputHash: hash(JSON.stringify(actual)) });
  }
  report.variants.push({ variant, sourceHash, blocks: converted.program.blocks.length, controls: converted.program.controls.length, cases: results });
}
await writeFile(join(output, 'conversion-verification.json'), JSON.stringify(report, null, 2));
const failures = report.variants.flatMap(v => v.cases.filter(c => !c.matches).map(c => ({ variant: v.variant, case: c.id, index: c.firstDifferentMessage })));
console.log(JSON.stringify({ variants: report.variants.map(v => ({ variant: v.variant, controls: v.controls, blocks: v.blocks, cases: v.cases.length })), failures, report: 'output/native-porting/pheme/conversion-verification.json' }));
if (failures.length) process.exitCode = 1;
