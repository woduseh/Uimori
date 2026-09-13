import { expect, test } from 'vitest';
import { defaultProfile, type ProfileSnapshot } from '../core/product.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import {
  evaluatePromptExpression,
  validatePromptProgram,
  type PromptExpression,
  type PromptTemplate,
} from '../core/prompt-program.js';
import {
  resolveTemplateVariables,
  resolveTemplateVariableContext,
  TEMPLATE_VARIABLE_LIMITS,
  validateTemplateVariableDefaults,
} from '../core/template-variables.js';
import { executionContext } from '../core/execution-context.js';
import { compiledPackages } from '../core/package-context.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { resolvePackageStart } from '../core/package-start.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { createPackageExtensionHost } from '../server/extension-materials.js';
import type { RunSnapshot } from '../core/types.js';
import { inspectRuntimeValue } from '../core/prompt-values.js';
import { validateChatVariableState } from '../core/chat-variables.js';

function pkg(id: string): ContentPackage {
  return {
    version: 1,
    id,
    revision: 1,
    title: id,
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
  };
}
function profile(): ProfileSnapshot {
  return { ...defaultProfile('chat'), contents: [], models: {} };
}
const lookup = (name: string): PromptExpression => ({
  op: 'get',
  args: [{ op: 'coalesce', args: [{ context: ['variables'] }, { literal: {} }] }, name],
});

test('declarations preserve authored keys and strings while rejecting unsafe data and bounded overflows', () => {
  const values = { '한 글': '  value\n', '': '', zero: '0', literal: '{{getvar::other}}' };
  expect(validateTemplateVariableDefaults(values)).toEqual(values);
  expect(
    validatePromptProgram({ version: 1, controls: [], blocks: [], variableDefaults: values })
      .variableDefaults
  ).toEqual(values);
  expect(
    validateContentPackage({ ...pkg('p'), variableDefaults: { values, attachmentRoles: ['bot'] } })
      .variableDefaults?.values
  ).toEqual(values);
  for (const invalid of [
    null,
    [],
    { x: 1 },
    { x: null },
    { x: {} },
    JSON.parse('{"__proto__":"x"}'),
    { constructor: 'x' },
    { prototype: 'x' },
    { x: 'x'.repeat(TEMPLATE_VARIABLE_LIMITS.maxValueChars + 1) },
    Object.fromEntries(
      Array.from({ length: TEMPLATE_VARIABLE_LIMITS.maxEntries + 1 }, (_, i) => [String(i), ''])
    ),
  ])
    expect(() => validateTemplateVariableDefaults(invalid)).toThrow();
  for (const attachmentRoles of [[], ['bot', 'bot'], ['unknown']])
    expect(() =>
      validateContentPackage({ ...pkg('p'), variableDefaults: { values, attachmentRoles } })
    ).toThrow();
  let read = false;
  expect(() =>
    validateTemplateVariableDefaults({
      get x() {
        read = true;
        return '';
      },
    })
  ).toThrow();
  expect(read).toBe(false);
});

test('attachment order and eligible roles take precedence over the main preset without mutable overrides', () => {
  const p = profile();
  const bot = {
    ...pkg('bot'),
    variableDefaults: { values: { shared: 'bot', empty: '' }, attachmentRoles: ['bot' as const] },
  };
  const module = {
    ...pkg('module'),
    variableDefaults: { values: { shared: 'module', module: 'yes' } },
  };
  const persona = { ...pkg('persona'), variableDefaults: { values: { persona: 'yes' } } };
  p.packages = [bot, module, persona];
  p.packageAttachments = [
    { id: bot.id, revision: 1, role: 'module' },
    { id: module.id, revision: 1, role: 'module' },
    { id: bot.id, revision: 1, role: 'bot' },
    { id: persona.id, revision: 1, role: 'persona' },
  ];
  p.promptPresets = {
    main: {
      id: 'preset',
      revision: 1,
      title: '',
      role: 'main',
      program: {
        version: 1,
        controls: [],
        blocks: [],
        variableDefaults: { shared: 'preset', fallback: 'yes', empty: 'fallback' },
      },
    },
  };
  p.personaReference = false;
  const before = structuredClone(p);
  expect(resolveTemplateVariables(p)).toEqual({
    shared: 'module',
    module: 'yes',
    empty: '',
    fallback: 'yes',
  });
  expect(resolveTemplateVariables(p, 'translation')?.persona).toBe('yes');
  expect(p).toEqual(before);
  p.packageAttachments.reverse();
  expect(resolveTemplateVariables(p)?.shared).toBe('bot');
});

test('legacy contexts omit variables and native missing lookup remains null', () => {
  const p = profile();
  expect(resolveTemplateVariables(p)).toBeUndefined();
  const snapshot: RunSnapshot = {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'Continue',
    history: [],
    resources: [],
    profile: p,
  };
  expect(executionContext(snapshot)).not.toHaveProperty('variables');
  expect(executionContext(snapshot)).not.toHaveProperty('variableStateRevision');
  expect(packageIdentityFromProfile(p)).not.toHaveProperty('variables');
  expect(packageIdentityFromProfile(p)).not.toHaveProperty('variableStateRevision');
  expect(resolveTemplateVariableContext(p)).toEqual({});
  expect(snapshot.profile).not.toHaveProperty('variableState');
  expect(
    evaluatePromptExpression(lookup('missing'), {}, { runtime: executionContext(snapshot) })
  ).toBeNull();
});

test('frozen branch overrides beat attachment and preset defaults while empty and dropped keys stay distinct', () => {
  const p = profile();
  const first = {
    ...pkg('first'),
    variableDefaults: {
      values: { shared: 'first', blank: 'first blank', dropped: 'restored package' },
    },
  };
  const second = { ...pkg('second'), variableDefaults: { values: { shared: 'second' } } };
  p.packages = [first, second];
  p.packageAttachments = [
    { id: first.id, revision: 1, role: 'bot' },
    { id: second.id, revision: 1, role: 'module' },
  ];
  p.promptPresets = {
    main: {
      id: 'preset',
      revision: 1,
      title: '',
      role: 'main',
      program: {
        version: 1,
        controls: [],
        blocks: [],
        variableDefaults: { shared: 'preset', presetOnly: 'preset fallback' },
      },
    },
  };
  p.variableState = {
    revision: 3,
    values: {
      shared: 'override',
      blank: '',
      dropped: 'temporary',
      presetOnly: 'temporary',
      ' 한 글 😀 ': '  {{literal}}\n',
      '': 'empty key',
    },
  };
  const frozen = structuredClone(p);
  const context = resolveTemplateVariableContext(frozen);
  expect(context).toEqual({
    variableStateRevision: 3,
    variables: {
      shared: 'override',
      blank: '',
      dropped: 'temporary',
      presetOnly: 'temporary',
      ' 한 글 😀 ': '  {{literal}}\n',
      '': 'empty key',
    },
  });
  p.variableState = { revision: 4, values: { shared: 'next', blank: '' } };
  expect(resolveTemplateVariables(p)).toEqual({
    shared: 'next',
    blank: '',
    dropped: 'restored package',
    presetOnly: 'preset fallback',
  });
  expect(resolveTemplateVariableContext(frozen)).toEqual(context);
  context.variables!.shared = 'mutated projection';
  expect(frozen.variableState!.values.shared).toBe('override');
  expect(resolveTemplateVariables(frozen)!.shared).toBe('override');
});

test('variable projections remain read-only and retain revisions across ABA values', () => {
  const p = profile();
  p.variableState = { revision: 1, values: { score: '1' } };
  const first = structuredClone(p);
  const a = resolveTemplateVariableContext(first);
  p.variableState = { revision: 2, values: { score: '2' } };
  expect(resolveTemplateVariableContext(p)).toEqual({
    variableStateRevision: 2,
    variables: { score: '2' },
  });
  p.variableState = { revision: 3, values: { score: '1' } };
  expect(resolveTemplateVariableContext(p)).toEqual({
    variableStateRevision: 3,
    variables: a.variables,
  });
  expect(resolveTemplateVariableContext(first)).toEqual(a);
  expect(first.variableState).toEqual({ revision: 1, values: { score: '1' } });
  const before = structuredClone(p);
  packageIdentityFromProfile(p);
  resolveTemplateVariables(p);
  expect(p).toEqual(before);
});

test.each(['entries', 'characters'] as const)(
  'override and default %s limits apply to the resolved union',
  (kind) => {
    const p = profile();
    const values = (prefix: string) =>
      kind === 'entries'
        ? Object.fromEntries(
            Array.from({ length: 1100 }, (_, index) => [`${prefix}${index}`, 'value'])
          )
        : Object.fromEntries(
            Array.from({ length: 3 }, (_, index) => [`${prefix}${index}`, 'x'.repeat(180000)])
          );
    const defaults = values('default');
    const overrides = values('override');
    const data = { ...pkg('bot'), variableDefaults: { values: defaults } };
    p.packages = [data];
    p.packageAttachments = [{ id: data.id, revision: 1, role: 'bot' }];
    p.variableState = { revision: 9, values: overrides };
    expect(() => validateTemplateVariableDefaults(defaults)).not.toThrow();
    expect(() => validateChatVariableState(p.variableState)).not.toThrow();
    const before = structuredClone(p);
    expect(resolveTemplateVariableContext(p)).toEqual({
      variableStateRevision: 9,
      variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT',
    });
    expect(resolveTemplateVariables(p)).toBeUndefined();
    expect(p).toEqual(before);
    // Replacing the same keys does not double-count authored defaults.
    p.variableState = {
      revision: 10,
      values: Object.fromEntries(Object.keys(defaults).map((key) => [key, 'override'])),
    };
    expect(resolveTemplateVariableContext(p)).toEqual({
      variableStateRevision: 10,
      variables: p.variableState.values,
    });
  }
);

test('shared state validation rejects unsafe prototypes, accessors and impossible revisions without reading getters', () => {
  let reads = 0;
  const invalid = [
    {
      get revision() {
        reads++;
        return 1;
      },
      values: {},
    },
    {
      revision: 1,
      get values() {
        reads++;
        return {};
      },
    },
    {
      revision: 1,
      values: {
        get score() {
          reads++;
          return '1';
        },
      },
    },
    Object.assign(Object.create({ inherited: true }), { revision: 1, values: {} }),
    { revision: 1, values: Object.assign(Object.create({ inherited: 'bad' }), { score: '1' }) },
    { revision: 0, values: { score: '' } },
    { revision: -1, values: {} },
    { revision: 0.5, values: {} },
    { revision: Number.MAX_SAFE_INTEGER + 1, values: {} },
    { revision: 1, values: {}, extra: '' },
    { revision: 1, values: {}, [Symbol('hidden')]: 'bad' },
  ];
  for (const state of invalid) expect(() => validateChatVariableState(state)).toThrow();
  expect(reads).toBe(0);
  expect(validateChatVariableState({ revision: 0, values: {} })).toEqual({
    revision: 0,
    values: {},
  });
  const accepted = { revision: 1, values: { score: '1' } };
  const cloned = validateChatVariableState(accepted);
  cloned.values.score = '2';
  expect(accepted.values.score).toBe('1');
});

test('variable declarations and the prior runtime retain independent size caps', () => {
  const runtime = {
    input: 'a'.repeat(900_000),
    variables: { key: 'value', padding: 'b'.repeat(150_000) },
  };
  expect(() => inspectRuntimeValue(runtime)).toThrow('PROMPT_VALUE_LIMIT');
  expect(evaluatePromptExpression(lookup('key'), {}, { runtime })).toBe('value');
  const nearLimit = { input: 'a'.repeat(999_980) };
  expect(() => inspectRuntimeValue(nearLimit)).not.toThrow();
  expect(
    evaluatePromptExpression(
      lookup('key'),
      {},
      {
        runtime: { ...nearLimit, variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' },
      }
    )
  ).toBeNull();
  expect(() =>
    evaluatePromptExpression(
      lookup('key'),
      {},
      {
        runtime: { ...runtime, input: 'a'.repeat(1_000_001) },
      }
    )
  ).toThrow('PROMPT_VALUE_LIMIT');
  expect(() =>
    evaluatePromptExpression(
      lookup('key'),
      {},
      {
        runtime: { input: '', variables: { key: 'a'.repeat(1_000_001) } },
      }
    )
  ).toThrow('PROMPT_VALUE_LIMIT');
  let read = false;
  expect(() =>
    evaluatePromptExpression(
      lookup('key'),
      {},
      {
        runtime: {
          variables: { key: '' },
          get hostile() {
            read = true;
            return '';
          },
        },
      }
    )
  ).toThrow('PROMPT_INVALID_RUNTIME_VALUE');
  expect(read).toBe(false);
});

test('generic runtime variables preserve historical arbitrary JSON values', () => {
  const variables = { count: 2, enabled: true, items: ['a', 3, null], nested: { value: false } };
  expect(
    evaluatePromptExpression({ context: ['variables'] }, {}, { runtime: { variables } })
  ).toEqual(variables);
  expect(
    evaluatePromptExpression(
      { op: 'get', args: [{ context: ['variables'] }, 1] },
      {},
      {
        runtime: { variables: ['first', { second: 2 }] },
      }
    )
  ).toEqual({ second: 2 });
});

test('aggregate overflow disables the whole variable layer with warnings and preserved text fallbacks', () => {
  const template: PromptTemplate = [{ kind: 'value', expression: lookup('key0') }];
  const makeValues = (prefix: string) =>
    Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`${prefix}${i}`, 'value']));
  const data: ContentPackage = {
    ...pkg('bot'),
    body: 'preserved body',
    bodyTemplate: template,
    variableDefaults: { values: makeValues('key') },
    lore: [
      {
        id: 'lore',
        title: '',
        description: '',
        loading: 'pinned',
        text: 'preserved lore',
        template,
      },
    ],
    starts: [{ id: 'start', title: 'start', text: 'preserved start', mode: 'authored', template }],
    instructions: [{ id: 'vars', target: 'main', text: 'preserved instruction', template }],
  };
  const second = { ...pkg('module'), variableDefaults: { values: makeValues('other') } };
  const p = profile();
  p.packages = [data, second];
  p.packageAttachments = [
    { id: data.id, revision: 1, role: 'bot' },
    { id: second.id, revision: 1, role: 'module' },
  ];
  const before = structuredClone(p);
  expect(resolveTemplateVariables(p)).toBeUndefined();
  expect(resolveTemplateVariableContext(p)).toEqual({
    variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT',
  });
  const identity = packageIdentityFromProfile(p);
  expect(resolvePackageStart(data, 'start', {}, identity)).toMatchObject({
    text: 'preserved start',
    templateWarning: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT',
  });
  const snapshot: RunSnapshot = {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'Continue',
    history: [],
    resources: [],
    profile: p,
  };
  const compiled = compiledPackages(snapshot, 'main')[0];
  expect(compiled.resources.map((item) => item.text)).toEqual(['preserved body', 'preserved lore']);
  expect(compiled.unavailableInstructions).toEqual([
    { id: 'vars', code: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' },
  ]);
  expect(compileSnapshotPrompt(snapshot).promptCompilation?.warnings).toContain(
    'TEMPLATE_VARIABLE_DEFAULTS_LIMIT'
  );
  expect(
    evaluatePromptExpression(lookup('key0'), {}, { runtime: executionContext(snapshot) })
  ).toBeNull();
  expect(p).toEqual(before);
});

test.each([false, true])(
  'frozen variables agree in body, lore, starts, instructions, main prompts and model materials (overrides: %s)',
  async (overrides) => {
    const p = profile();
    if (overrides) p.variableState = { revision: 7, values: { '한 글': 'frozen {{literal}}' } };
    const authoredDefault = overrides ? 'authored fallback' : 'frozen {{literal}}';
    const template: PromptTemplate = [{ kind: 'value', expression: lookup('한 글') }];
    const data: ContentPackage = {
      ...pkg('bot'),
      body: 'preserved source',
      bodyTemplate: template,
      variableDefaults: { values: { '한 글': authoredDefault }, attachmentRoles: ['bot'] },
      lore: [
        {
          id: 'lore',
          title: '',
          description: '',
          text: 'preserved lore',
          template,
          loading: 'pinned',
        },
      ],
      starts: [
        { id: 'start', title: 'start', text: 'preserved start', template, mode: 'authored' },
      ],
      instructions: [
        { id: 'instruction', target: 'main', text: 'preserved instruction', template },
      ],
    };
    p.packages = [data];
    const ref = { id: data.id, revision: data.revision, role: 'bot' as const };
    p.packageAttachments = [ref];
    p.promptPresets = {
      main: {
        id: 'preset',
        revision: 1,
        title: '',
        role: 'main',
        program: {
          version: 1,
          controls: [],
          variableDefaults: { '한 글': 'preset fallback' },
          blocks: [
            { id: 'vars', title: '', kind: 'message', role: 'system', template },
            { id: 'current', title: '', kind: 'current' },
          ],
        },
      },
    };
    const snapshot: RunSnapshot = {
      chatId: 'chat',
      parentRevision: null,
      settingsRevision: 1,
      settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
      request: 'Continue',
      history: [],
      resources: [],
      profile: p,
    };
    const original = structuredClone(snapshot);
    const identity = packageIdentityFromProfile(p);
    const resources = compilePackageAttachment(data, ref, {
      chatId: 'chat',
      target: 'main',
      identity,
      resourcesOnly: true,
    }).resources;
    expect(resources.map((r) => r.text)).toEqual(['frozen {{literal}}', 'frozen {{literal}}']);
    expect(compiledPackages(snapshot, 'main')[0].resources).toEqual(resources);
    expect(compiledPackages(snapshot, 'main')[0].instructions[0].text).toBe('frozen {{literal}}');
    expect(resolvePackageStart(data, 'start', {}, identity).text).toBe('frozen {{literal}}');
    expect(JSON.stringify(compileSnapshotPrompt(snapshot).promptCompilation?.messages)).toContain(
      'frozen {{literal}}'
    );
    const broker = createPackageExtensionHost(
      { api: 'uimori-state-action-v1', source: '', capabilities: ['materials.read.self'] },
      p,
      ref,
      () => {}
    );
    data.variableDefaults!.values['한 글'] = 'later edit';
    if (overrides) p.variableState = { revision: 8, values: { '한 글': 'later override' } };
    const read = await broker(
      'materials.read',
      { id: resources[0].id },
      new AbortController().signal
    );
    expect(read).toMatchObject({ text: 'frozen {{literal}}' });
    data.variableDefaults!.values['한 글'] = authoredDefault;
    if (overrides) p.variableState = structuredClone(original.profile!.variableState);
    expect(snapshot).toEqual(original);
  }
);
