import { parse } from '@babel/parser';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamFile = 'src/ts/process/scriptings.ts';
const snapshotFile = 'third_party/risuai/cad8595a/SNAPSHOT.json';
const uimoriFile = 'server/risu-native-lua.ts';
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (items) => [...items].sort(order);
const hash = (value) => createHash('sha256').update(value).digest('hex');

const usage = `Usage: node scripts/risu-lua-diff.mjs --risu <local Risu Git checkout> [--base <ref>] [--ref <ref>] [--json] [--check]

Compare the upstream scripting source at two fixed Git commits. The default base
is the upstream source commit in ${snapshotFile}, not a claim about the exact
Risu version supported by Uimori; the default target is HEAD. Uncommitted files
are ignored. This is a review aid, not a compatibility test or an updater.

--json   Print a machine-readable report
--check  Exit 1 if the tracked upstream source changed; errors exit 2
--help   Show this help
`;

function optionsFrom(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--risu', '--base', '--ref', '--json', '--check', '--help'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (Object.hasOwn(result, key)) throw new Error(`Repeated argument: ${arg}`);
    if (['risu', 'base', 'ref'].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[key] = value;
    } else result[key] = true;
  }
  if (!result.help && !result.risu) throw new Error('Missing required --risu checkout');
  return result;
}

function git(checkout, args, description) {
  try {
    return execFileSync(
      'git',
      ['--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '-C', checkout, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
      }
    );
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    throw new Error(`${description}${detail ? `: ${detail}` : ''}`);
  }
}

function resolveCommit(checkout, ref, label) {
  const commit = git(
    checkout,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    `Cannot resolve ${label} ref ${JSON.stringify(ref)} to a commit`
  ).trim();
  if (!/^[a-f\d]{40,64}$/.test(commit)) throw new Error(`Unexpected Git commit ID for ${label}`);
  return commit;
}

function sourceAt(checkout, commit, label) {
  return git(
    checkout,
    ['cat-file', 'blob', `${commit}:${upstreamFile}`],
    `Cannot read ${upstreamFile} at ${label} commit ${commit}`
  );
}

function syntax(source, label) {
  try {
    return parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (error) {
    throw new Error(`Cannot parse ${label}: ${error.message}`);
  }
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else {
    if (typeof value.type === 'string') visit(value);
    for (const [key, child] of Object.entries(value)) {
      if (
        !['loc', 'leadingComments', 'innerComments', 'trailingComments', 'comments'].includes(key)
      ) {
        walk(child, visit);
      }
    }
  }
}

function contract(label, detail) {
  throw new Error(`Unrecognized ${label} extraction contract: ${detail}`);
}

function getMemberCall(node, objectName, propertyName) {
  const callee = node.type === 'CallExpression' && node.callee;
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === propertyName &&
    callee.object.type === 'MemberExpression' &&
    !callee.object.computed &&
    callee.object.object.type === 'Identifier' &&
    callee.object.object.name === objectName &&
    callee.object.property.type === 'Identifier' &&
    callee.object.property.name === 'global'
  );
}

function extractUpstream(source, label) {
  const ast = syntax(source, `${label} ${upstreamFile}`);
  const apis = new Map();
  const wrappers = [];
  const switches = [];
  walk(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'declareAPI'
    ) {
      const [name, fn] = node.arguments;
      if (
        node.arguments.length !== 2 ||
        name?.type !== 'StringLiteral' ||
        !name.value ||
        !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn?.type)
      ) {
        contract(label, 'declareAPI requires a literal name and an inline function');
      }
      const declaration = {
        line: node.loc.start.line,
        signature: source.slice(fn.start, fn.body.start).trim(),
        bodySha256: hash(source.slice(fn.body.start, fn.body.end)),
      };
      const entries = apis.get(name.value) ?? [];
      entries.push(declaration);
      apis.set(name.value, entries);
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'luaCodeWrapper')
      wrappers.push(node);
    if (
      node.type === 'SwitchStatement' &&
      node.discriminant.type === 'Identifier' &&
      node.discriminant.name === 'mode'
    ) {
      const called = new Set();
      walk(node, (child) => {
        if (
          getMemberCall(child, 'luaEngine', 'get') &&
          child.arguments[0]?.type === 'StringLiteral'
        ) {
          called.add(child.arguments[0].value);
        }
      });
      if (called.has('onInput') && called.has('callListenMain')) switches.push(node);
    }
  });
  if (!apis.size) contract(label, 'no static declareAPI calls found');
  if (wrappers.length !== 1) contract(label, 'expected one luaCodeWrapper function');
  if (switches.length !== 1) contract(label, 'expected one Lua mode dispatch switch');

  const templates = [];
  walk(wrappers[0].body, (node) => {
    if (node.type === 'ReturnStatement' && node.argument?.type === 'TemplateLiteral') {
      templates.push(node.argument);
    }
  });
  const template = templates[0];
  if (
    templates.length !== 1 ||
    template.expressions.length !== 1 ||
    template.expressions[0].type !== 'Identifier' ||
    template.expressions[0].name !== 'code'
  ) {
    contract(
      label,
      'expected luaCodeWrapper to return a template containing the code interpolation'
    );
  }
  const lua = template.quasis.map((quasi) => quasi.value.raw).join('');
  const helpers = new Set();
  for (const match of lua.matchAll(/^function\s+([A-Za-z_]\w*)\s*\(/gm)) helpers.add(match[1]);
  for (const match of lua.matchAll(/^([A-Za-z_]\w*)\s*=\s*function\s*\(/gm)) helpers.add(match[1]);
  for (const match of lua.matchAll(/^([A-Za-z_]\w*)\s*=\s*async\s*\(\s*function\s*\(/gm))
    helpers.add(match[1]);
  const listener = lua.match(
    /^function\s+listenEdit\s*\(\s*([A-Za-z_]\w*)\s*,[^\r\n]*\)\s*\r?\n([\s\S]*?)^end\s*$/m
  );
  if (!listener || !helpers.has('getChat'))
    contract(label, 'expected Lua getChat and listenEdit helpers');
  const forward = new RegExp(`\\b${listener[1]}\\s*==\\s*(['"])([^'"]+)\\1`, 'g');
  const reverse = new RegExp(`(['"])([^'"]+)\\1\\s*==\\s*${listener[1]}\\b`, 'g');
  const listeners = new Set(
    [...listener[2].matchAll(forward), ...listener[2].matchAll(reverse)].map((match) => match[2])
  );
  if (!listeners.size) contract(label, 'expected literal listenEdit event checks');

  const dispatch = new Map();
  const cases = switches[0].cases;
  for (let i = 0; i < cases.length; i++) {
    const current = cases[i];
    if (!current.test) continue;
    if (current.test.type !== 'StringLiteral')
      contract(label, 'expected literal Lua dispatch cases');
    let body = i;
    while (body < cases.length && !cases[body].consequent.length) body++;
    if (body === cases.length) contract(label, 'Lua dispatch case falls through without a body');
    if (dispatch.has(current.test.value)) contract(label, 'duplicate Lua dispatch case');
    const statements = cases[body].consequent;
    const bodyText = source.slice(statements[0].start, statements.at(-1).end);
    const targets = new Set();
    for (const statement of statements) {
      walk(statement, (node) => {
        if (
          getMemberCall(node, 'luaEngine', 'get') &&
          node.arguments[0]?.type === 'StringLiteral'
        ) {
          targets.add(node.arguments[0].value);
        }
      });
    }
    dispatch.set(current.test.value, {
      line: current.loc.start.line,
      targets: sorted(targets),
      bodySha256: hash(bodyText),
    });
  }
  return {
    apis,
    dispatch,
    listeners,
    wrapper: {
      sha256: hash(source.slice(wrappers[0].start, wrappers[0].end)),
      line: wrappers[0].loc.start.line,
      helpers: sorted(helpers),
    },
  };
}

function extractUimori(source) {
  const ast = syntax(source, uimoriFile);
  const templates = new Map();
  walk(ast, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      ['RISU_NATIVE_LUA_PRELUDE', 'RISU_NATIVE_LUA_DISPATCH'].includes(node.id.name)
    ) {
      const init = node.init;
      if (
        init?.type !== 'TaggedTemplateExpression' ||
        init.tag.type !== 'MemberExpression' ||
        init.tag.object.type !== 'Identifier' ||
        init.tag.object.name !== 'String' ||
        init.tag.property.type !== 'Identifier' ||
        init.tag.property.name !== 'raw' ||
        init.quasi.expressions.length
      ) {
        contract('Uimori', `expected a static String.raw template for ${node.id.name}`);
      }
      if (templates.has(node.id.name)) contract('Uimori', `duplicate ${node.id.name} template`);
      templates.set(node.id.name, init.quasi.quasis[0].value.raw);
    }
  });
  const lua = templates.get('RISU_NATIVE_LUA_PRELUDE');
  const dispatch = templates.get('RISU_NATIVE_LUA_DISPATCH');
  if (!lua || !dispatch) contract('Uimori', 'expected native Lua prelude and dispatch templates');
  const unsupportedBlock = lua.match(/\blocal\s+__unsupported\s*=\s*\{([^}]*)\}/);
  if (!unsupportedBlock) contract('Uimori', 'expected an explicit unsupported API list');
  const unsupported = new Set(
    [...unsupportedBlock[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)].map((match) => match[1])
  );
  const exposed = new Set();
  for (const match of lua.matchAll(/^function\s+([A-Za-z_]\w*)\s*\(/gm)) exposed.add(match[1]);
  for (const match of lua.matchAll(/^\s*env\.([A-Za-z_]\w*)\s*=\s*function\s*\(/gm))
    exposed.add(match[1]);
  if (!unsupported.size || !exposed.size)
    contract('Uimori', 'empty exposed or unsupported inventory');
  for (const name of unsupported) exposed.delete(name);
  const editBlock = lua.match(/\blocal\s+__callbacks\s*=\s*\{((?:[^{}]|\{\})+)\}/);
  const handlerBlock = dispatch.match(
    /\blocal\s+name\s*=\s*\(\s*\{([^}]+)\}\s*\)\s*\[\s*event\s*\]/
  );
  if (!editBlock || !handlerBlock) contract('Uimori', 'expected static edit and callback maps');
  const editEvents = new Set(
    [...editBlock[1].matchAll(/([A-Za-z_]\w*)\s*=\s*\{\s*\}/g)].map((match) => match[1])
  );
  const handlers = [
    ...handlerBlock[1].matchAll(/([A-Za-z_]\w*)\s*=\s*['"]([A-Za-z_]\w*)['"]/g),
  ].map((match) => ({ event: match[1], handler: match[2] }));
  if (!editEvents.size || !handlers.length) contract('Uimori', 'empty static callback inventory');
  return { exposed, unsupported, editEvents, handlers };
}

function changes(before, after) {
  return {
    added: sorted([...after].filter((name) => !before.has(name))),
    removed: sorted([...before].filter((name) => !after.has(name))),
  };
}

function classify(name, inventory) {
  if (inventory.unsupported.has(name)) return 'explicitly-unsupported';
  if (inventory.exposed.has(name)) return 'exposed';
  return 'unclassified';
}

function apiComparison(base, target, inventory) {
  const names = changes(new Set(base.keys()), new Set(target.keys()));
  const row = (name, entries) => ({
    name,
    exposure: classify(name, inventory),
    declarations: entries,
  });
  const allNames = sorted(new Set([...base.keys(), ...target.keys()]));
  const changed = [];
  for (const name of sorted([...base.keys()].filter((entry) => target.has(entry)))) {
    const before = base.get(name);
    const after = target.get(name);
    const kinds = [];
    if (before.length !== after.length) kinds.push('declaration-count');
    if (
      JSON.stringify(before.map((entry) => entry.signature)) !==
      JSON.stringify(after.map((entry) => entry.signature))
    )
      kinds.push('signature');
    if (
      JSON.stringify(before.map((entry) => entry.bodySha256)) !==
      JSON.stringify(after.map((entry) => entry.bodySha256))
    )
      kinds.push('body');
    if (kinds.length)
      changed.push({
        name,
        exposure: classify(name, inventory),
        changes: kinds,
        base: before,
        target: after,
      });
  }
  return {
    added: names.added.map((name) => row(name, target.get(name))),
    removed: names.removed.map((name) => row(name, base.get(name))),
    changed,
    inventory: allNames.map((name) => ({
      name,
      exposure: classify(name, inventory),
      baseDeclarations: base.get(name)?.length ?? 0,
      targetDeclarations: target.get(name)?.length ?? 0,
    })),
  };
}

function dispatchComparison(base, target, inventory) {
  const names = changes(new Set(base.keys()), new Set(target.keys()));
  const changed = sorted(
    [...base.keys()].filter(
      (name) => target.has(name) && base.get(name).bodySha256 !== target.get(name).bodySha256
    )
  );
  const eventExposure = (name, event) =>
    (inventory.editEvents.has(name) && event.targets.includes('callListenMain')) ||
    inventory.handlers.some(
      (entry) =>
        (name === entry.event || name === entry.handler) && event.targets.includes(entry.handler)
    )
      ? 'statically-observed'
      : 'unclassified';
  return {
    added: names.added.map((name) => ({
      name,
      uimori: eventExposure(name, target.get(name)),
      ...target.get(name),
    })),
    removed: names.removed.map((name) => ({
      name,
      uimori: eventExposure(name, base.get(name)),
      ...base.get(name),
    })),
    changed: changed.map((name) => ({
      name,
      uimori: eventExposure(name, target.get(name)),
      base: base.get(name),
      target: target.get(name),
    })),
  };
}

function report(options) {
  const snapshot = JSON.parse(readFileSync(path.join(root, snapshotFile), 'utf8'));
  const snapshotCommit = snapshot?.upstream?.commit;
  if (typeof snapshotCommit !== 'string' || !/^[a-f\d]{40,64}$/.test(snapshotCommit)) {
    throw new Error(`Invalid upstream commit in ${snapshotFile}`);
  }
  const checkout = path.resolve(options.risu);
  if (
    git(
      checkout,
      ['rev-parse', '--is-inside-work-tree'],
      'Cannot access Risu Git checkout'
    ).trim() !== 'true'
  ) {
    throw new Error('The --risu path must be inside a Git working tree');
  }
  const baseRef = options.base ?? snapshotCommit;
  const targetRef = options.ref ?? 'HEAD';
  // Resolve both names first; all subsequent reads use the immutable commits.
  const baseCommit = resolveCommit(checkout, baseRef, 'base');
  const targetCommit = resolveCommit(checkout, targetRef, 'target');
  const baseSource = sourceAt(checkout, baseCommit, 'base');
  const targetSource = sourceAt(checkout, targetCommit, 'target');
  const base = extractUpstream(baseSource, 'base');
  const target = extractUpstream(targetSource, 'target');
  const uimoriSource = readFileSync(path.join(root, uimoriFile), 'utf8');
  const inventory = extractUimori(uimoriSource);
  const allNames = new Set([
    ...base.apis.keys(),
    ...target.apis.keys(),
    ...base.wrapper.helpers,
    ...target.wrapper.helpers,
  ]);
  return {
    schemaVersion: 1,
    scope: {
      upstreamFile,
      snapshotFile,
      note: 'Snapshot commit is an upstream source baseline, not the exact Uimori support version; scriptings.ts is not a vendored snapshot file. Only this upstream file is compared; indirect dependencies need separate review. Git working-tree changes are ignored. Callback and helper inventories use best-effort literal patterns and may be incomplete; dynamic dispatch is not enumerated.',
      exposureNote:
        'Observed static exact-name inventory only; exposed or statically observed does not mean semantically compatible. Lua helpers and host *Main APIs are distinct names.',
    },
    checkout,
    base: { ref: baseRef, commit: baseCommit, sourceSha256: hash(baseSource) },
    target: { ref: targetRef, commit: targetCommit, sourceSha256: hash(targetSource) },
    drift: baseSource !== targetSource,
    hostApis: apiComparison(base.apis, target.apis, inventory),
    callbacks: {
      dispatch: dispatchComparison(base.dispatch, target.dispatch, inventory),
      listenEdit: changes(base.listeners, target.listeners),
      note: 'listenEdit additions and removals describe recognized literal comparisons, not an exhaustive event contract.',
    },
    luaWrapper: {
      changed: base.wrapper.sha256 !== target.wrapper.sha256,
      base: base.wrapper,
      target: target.wrapper,
      helpers: changes(new Set(base.wrapper.helpers), new Set(target.wrapper.helpers)),
      inventory: sorted(new Set([...base.wrapper.helpers, ...target.wrapper.helpers])).map(
        (name) => ({
          name,
          exposure: classify(name, inventory),
          base: base.wrapper.helpers.includes(name),
          target: target.wrapper.helpers.includes(name),
        })
      ),
      note: 'Whole wrapper fingerprint; helper names are a best-effort static inventory. Any wrapper change requires review.',
    },
    uimori: {
      source: uimoriFile,
      sourceSha256: hash(uimoriSource),
      exposed: sorted(inventory.exposed),
      explicitlyUnsupported: sorted(inventory.unsupported),
      unclassified: sorted(
        [...allNames].filter((name) => classify(name, inventory) === 'unclassified')
      ),
      callbacks: { editEvents: sorted(inventory.editEvents), staticHandlers: inventory.handlers },
    },
  };
}

function printReport(result) {
  const lines = [
    'Risu Lua upstream source comparison (read-only)',
    `Base:   ${result.base.ref} -> ${result.base.commit}`,
    `Target: ${result.target.ref} -> ${result.target.commit}`,
    `Tracked source: ${result.scope.upstreamFile}`,
    `Source changed: ${result.drift ? 'yes' : 'no'}`,
    `Source SHA-256: ${result.base.sourceSha256} -> ${result.target.sourceSha256}`,
    result.scope.note,
    result.scope.exposureNote,
    '',
    'Host declareAPI:',
  ];
  const apis = result.hostApis;
  for (const item of apis.added)
    lines.push(`  + ${item.name} [${item.exposure}], ${item.declarations.length} declaration(s)`);
  for (const item of apis.removed)
    lines.push(`  - ${item.name} [${item.exposure}], ${item.declarations.length} declaration(s)`);
  for (const item of apis.changed) {
    lines.push(
      `  ~ ${item.name} [${item.exposure}]: ${item.changes.join(', ')} (base lines ${item.base.map((v) => v.line).join(', ')}; target lines ${item.target.map((v) => v.line).join(', ')})`
    );
    if (item.changes.includes('signature')) {
      for (const declaration of item.base) lines.push(`    base:   ${declaration.signature}`);
      for (const declaration of item.target) lines.push(`    target: ${declaration.signature}`);
    }
  }
  if (!apis.added.length && !apis.removed.length && !apis.changed.length)
    lines.push('  No extracted declaration changes.');
  const duplicates = apis.inventory.filter(
    (item) => item.baseDeclarations > 1 || item.targetDeclarations > 1
  );
  if (duplicates.length) {
    lines.push(
      `  Multiple registrations (base -> target): ${duplicates.map((item) => `${item.name} ${item.baseDeclarations} -> ${item.targetDeclarations}`).join(', ')}`
    );
  }
  lines.push('', 'Lua dispatch events:');
  const events = result.callbacks.dispatch;
  for (const item of events.added)
    lines.push(
      `  + ${item.name} -> ${item.targets.join(', ') || '(no static callback)'} [Uimori: ${item.uimori}]`
    );
  for (const item of events.removed)
    lines.push(
      `  - ${item.name} -> ${item.targets.join(', ') || '(no static callback)'} [Uimori: ${item.uimori}]`
    );
  for (const item of events.changed)
    lines.push(`  ~ ${item.name}: dispatch body changed [Uimori: ${item.uimori}]`);
  if (!events.added.length && !events.removed.length && !events.changed.length)
    lines.push('  No extracted dispatch changes.');
  const listeners = result.callbacks.listenEdit;
  lines.push(`listenEdit literal checks newly observed: ${listeners.added.join(', ') || '(none)'}`);
  lines.push(
    `listenEdit literal checks no longer observed: ${listeners.removed.join(', ') || '(none)'}`
  );
  lines.push(`Lua wrapper changed: ${result.luaWrapper.changed ? 'yes; review required' : 'no'}`);
  lines.push(
    `Wrapper helper names newly observed: ${result.luaWrapper.helpers.added.join(', ') || '(none)'}`
  );
  lines.push(
    `Wrapper helper names no longer observed: ${result.luaWrapper.helpers.removed.join(', ') || '(none)'}`
  );
  lines.push(
    `Target wrapper helpers: ${
      result.luaWrapper.inventory
        .filter((item) => item.target)
        .map((item) => `${item.name} [${item.exposure}]`)
        .join(', ') || '(none)'
    }`
  );
  lines.push('', `Uimori exact-name inventory from ${result.uimori.source}:`);
  lines.push(`  exposed: ${result.uimori.exposed.join(', ') || '(none)'}`);
  lines.push(
    `  explicitly unsupported: ${result.uimori.explicitlyUnsupported.join(', ') || '(none)'}`
  );
  lines.push(`  unclassified upstream names: ${result.uimori.unclassified.join(', ') || '(none)'}`);
  if (result.drift)
    lines.push(
      '',
      `Review full source diff in the Risu checkout: git diff ${result.base.commit} ${result.target.commit} -- ${result.scope.upstreamFile}`
    );
  return `${lines.join('\n')}\n`;
}

try {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) process.stdout.write(usage);
  else {
    const result = report(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(result, null, 2)}\n` : printReport(result)
    );
    if (options.check && result.drift) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`risu-lua-diff: ${error.message}\n`);
  process.exitCode = 2;
}
