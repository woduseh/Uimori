import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod/v4';
import { allEndpoints, type Endpoint, isAppErrorCode } from '#contracts';
import * as contracts from '#contracts';
import { allOperations } from '#contracts/operations';
import * as operations from '#contracts/operations';
import { allCommands } from '../server/commands/index.js';
import { appearanceCases } from './stale-tab/appearance.js';
import { chatCases } from './stale-tab/chat.js';
import { chatSettingsCases } from './stale-tab/chat-settings.js';
import { deletionCases } from './stale-tab/deletion.js';
import {
  type Answer,
  call,
  conflict,
  deleted,
  type Domain,
  type DomainCases,
  type Entry,
  type Input,
  startStaleTabApp,
  stopStaleTabApp,
} from './stale-tab/harness.js';
import { libraryCases } from './stale-tab/library.js';
import { personalWorkspaceCases } from './stale-tab/personal-workspace.js';
import { promptsCases } from './stale-tab/prompts.js';
import { providersCases } from './stale-tab/providers.js';
import { readerCases } from './stale-tab/reader.js';
import { resourceEditorsCases } from './stale-tab/resource-editors.js';
import { analyzeSchema, revisionFields, targetPaths, valuesAtPath } from './stale-tab/schema.js';
import { transferCases } from './stale-tab/transfer.js';
import { translationCases } from './stale-tab/translation.js';

const domainFiles: DomainCases[] = [
  appearanceCases,
  chatCases,
  chatSettingsCases,
  deletionCases,
  libraryCases,
  personalWorkspaceCases,
  promptsCases,
  providersCases,
  readerCases,
  resourceEditorsCases,
  transferCases,
  translationCases,
];
const caseEntries: Record<string, Entry> = Object.fromEntries(
  domainFiles.flatMap(({ domain, entries }) =>
    Object.entries(entries as Record<string, Entry>).map(([key, entry]) => [
      `${domain}.${key}`,
      entry,
    ])
  )
);

const same = (left: Answer, right: Answer) =>
  left.status === right.status && left.code === right.code;

beforeAll(startStaleTabApp);
afterAll(stopStaleTabApp);

const endpointEntries = Object.entries(allEndpoints).flatMap(([domain, endpoints]) =>
  Object.entries(endpoints).map(([key, endpoint]) => ({
    domain: domain as Domain,
    name: `${domain}.${key}`,
    endpoint: endpoint as Endpoint,
  }))
);
const commandOperations = new Map(
  Object.entries(allCommands).map(([name, command]) => [name, command.op])
);
const httpEntries = endpointEntries.filter(
  ({ endpoint }) => !commandOperations.has(endpoint.operation)
);
const operationFor = (domain: Domain, name: string) =>
  Object.values(allOperations[domain]).find((operation) => operation.name === name);
const matrix: Record<string, Entry> = Object.fromEntries(
  httpEntries.flatMap(({ name }) => (caseEntries[name] ? [[name, caseEntries[name]]] : []))
);
const analysisByName = new Map(
  httpEntries.map(({ domain, name, endpoint }) => [
    name,
    analyzeSchema(operationFor(domain, endpoint.operation)!.input),
  ])
);
const analysisOf = (name: string) => analysisByName.get(name)!;
const requiredBranchesOf = (name: string) =>
  analysisOf(name).branches.filter(
    (branch) => branch.revisions.length > 0 || branch.targets.length > 0
  );

test('every endpoint names an operation of its own domain and every operation is served', () => {
  expect(Object.keys(allOperations).sort()).toEqual(Object.keys(allEndpoints).sort());
  for (const { domain, name, endpoint } of endpointEntries) {
    expect(endpoint.operation.startsWith(`${domain}.`), name).toBe(true);
    const operation = operationFor(domain, endpoint.operation);
    expect(operation, `${name} → ${endpoint.operation}`).toBeDefined();
    if (operation && 'kind' in operation && operation.kind === 'command')
      expect(
        commandOperations.get(operation.name),
        `${name}: register the command in allCommands`
      ).toBe(operation);
  }
  const served = new Set(endpointEntries.map(({ endpoint }) => endpoint.operation));
  for (const operations of Object.values(allOperations))
    for (const operation of Object.values(operations))
      expect(served.has(operation.name), `${operation.name} has no endpoint`).toBe(true);
});

test('every endpoint and operation set the contracts export is in the registries', () => {
  const exported = (suffix: string, from: Record<string, unknown>, registry: object) => {
    const sets = Object.entries(from)
      .filter(([name]) => name.endsWith(suffix) && name !== `all${suffix}`)
      .map(([, value]) => value);
    expect(new Set(Object.values(registry))).toEqual(new Set(sets));
  };
  exported('Endpoints', contracts, allEndpoints);
  exported('Operations', operations, allOperations);
  const domains = readdirSync(join(import.meta.dirname, '../packages/contracts/src/domains'), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  expect(Object.keys(allEndpoints)).toHaveLength(domains.length);
});

test('the schema walker collects nested targets, reused schemas and union branches', () => {
  const { appearance, chat, library, prompts, reader, resourceEditors, transfer } = allOperations;
  const personal = allOperations['personal-workspace'];
  expect(revisionFields(appearance.selectTheme.input)).toEqual(['expectedRevision']);
  expect(revisionFields(library.moveItems.input)).toEqual(['expectedRevision']);
  expect(revisionFields(library.updateFolder.input)).toEqual(['expectedRevision']);
  expect(revisionFields(resourceEditors.cloneResource.input)).toEqual(['expectedSourceRevision']);
  expect(revisionFields(prompts.updateCombination.input)).toEqual([
    'expectedRevision',
    'sourceRevision',
  ]);
  expect(
    revisionFields(
      z.strictObject({
        expectedOrder: z.array(z.string()),
        nested: z.strictObject({ workspaceRevision: z.int() }),
        revision: z.int(),
        expectation: z.string(),
      })
    )
  ).toEqual(['expectedOrder', 'nested.workspaceRevision']);
  expect(targetPaths(personal.addBookmark.input)).toEqual([
    'chatId',
    'id',
    'target.chatId',
    'target.sourceId',
  ]);
  expect(targetPaths(personal.readReadingPositions.input)).toEqual(['chatId']);
  expect(targetPaths(prompts.updateModelWorkspace.input)).toEqual([
    'contextModel.id',
    'helperModel.id',
    'routes.main.id',
    'routes.translation.id',
    'scriptModel.id',
    'titleModel.id',
  ]);
  expect(targetPaths(transfer.applyArchive.input)).toEqual([
    'modelBindings[].model.id',
    'preparedId',
  ]);
  expect(analyzeSchema(appearance.selectTheme.input).branches.map((b) => b.label)).toEqual([
    'dimension=theme, scope=global',
    'dimension=theme, scope=bot',
    'dimension=theme, scope=chat',
    'dimension=palette, scope=global',
    'dimension=palette, scope=bot',
    'dimension=palette, scope=chat',
    'dimension=storyUi',
  ]);
  expect(analyzeSchema(library.moveItems.input).branches.map((b) => b.label)).toEqual([
    'category=bot|persona|module',
    'category=prompts',
  ]);
  expect(analyzeSchema(reader.readResponseStream.input).branches).toEqual([]);
  expect(analyzeSchema(chat.updateGenerationDefaults.input).branches).toEqual([]);
  expect(
    analyzeSchema(personal.searchManuscripts.input)
      .branches.filter((branch) => branch.revisions.length > 0 || branch.targets.length > 0)
      .map((branch) => branch.label)
  ).toEqual(['scope=chat', 'scope=bot']);
  expect(
    analyzeSchema(transfer.applyFile.input)
      .branches.filter((branch) => branch.revisions.length > 0 || branch.targets.length > 0)
      .map((branch) => branch.label)
  ).toEqual(['modelBindings[].mode=local']);
  const recursive: z.ZodType = z.lazy(() =>
    z.strictObject({ id: z.string(), child: recursive.optional() })
  );
  expect(targetPaths(recursive)).toEqual(['id']);
  expect(
    valuesAtPath(
      { modelBindings: [{ model: { id: 'a' } }, { model: { id: 'b' } }] },
      'modelBindings[].model.id'
    )
  ).toEqual(['a', 'b']);

  const nestedArrayUnion = z.strictObject({
    items: z.array(
      z.discriminatedUnion('mode', [
        z.strictObject({
          mode: z.literal('a'),
          child: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('x'), id: z.string() }),
            z.strictObject({ kind: z.literal('y'), id: z.string() }),
          ]),
        }),
        z.strictObject({
          mode: z.literal('b'),
          child: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('x'), id: z.string() }),
            z.strictObject({ kind: z.literal('y'), id: z.string() }),
          ]),
        }),
      ])
    ),
  });
  const pairedInput = {
    items: [
      { mode: 'a', child: { kind: 'x', id: '1' } },
      { mode: 'b', child: { kind: 'y', id: '2' } },
    ],
  };
  expect(
    analyzeSchema(nestedArrayUnion)
      .branches.filter((branch) => branch.matches(pairedInput))
      .map((branch) => branch.label)
  ).toEqual([
    'items[].mode=a',
    'items[].mode=a, items[].child.kind=x',
    'items[].mode=b',
    'items[].mode=b, items[].child.kind=y',
  ]);
});

function findMissingTargets(entries: Record<string, Entry>): string[] {
  const missingTargets: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const { endpoint } = endpointEntries.find((item) => item.name === name)!;
    const { revisions, targets } = analysisOf(name);
    if ('exempt' in entry) {
      expect(
        revisions.length > 0 || targets.length > 0,
        `${name} has no revision or target field; remove the stale exemption`
      ).toBe(true);
      expect(entry.exempt.trim().length, name).toBeGreaterThan(20);
    } else {
      expect(entry.cases.length, `${name} needs at least one case`).toBeGreaterThan(0);
      for (const item of entry.cases) {
        const label = `${name} with ${item.when}`;
        expect(isAppErrorCode(item.answer.code), `${label}: ${item.answer.code}`).toBe(true);
        const defaultAnswer =
          endpoint.method === 'GET'
            ? same(item.answer, deleted)
            : same(item.answer, conflict) || same(item.answer, deleted);
        if (!defaultAnswer)
          expect(
            item.reason?.trim().length ?? 0,
            `${label} (${endpoint.method}) answers ${item.answer.code} and needs a reason of 20+ characters`
          ).toBeGreaterThanOrEqual(20);
        if (item.target !== undefined)
          expect(
            targets.includes(item.target),
            `${label} names unknown target ${item.target} (known: ${targets.join(', ') || 'none'})`
          ).toBe(true);
      }
    }

    const exemptTargets = entry.exemptTargets ?? {};
    for (const [target, reason] of Object.entries(exemptTargets)) {
      expect(
        targets.length >= 2 && targets.includes(target),
        `${name} exemptTargets names unknown or unneeded target ${target}`
      ).toBe(true);
      expect(
        reason.trim().length,
        `${name} exemptTargets.${target} needs a reason of 20+ characters`
      ).toBeGreaterThanOrEqual(20);
    }

    const requiredBranchLabels = new Set(requiredBranchesOf(name).map((branch) => branch.label));
    for (const [branch, reason] of Object.entries(entry.exemptBranches ?? {})) {
      expect(
        requiredBranchLabels.has(branch),
        `${name} exemptBranches names unknown or non-target branch ${branch}`
      ).toBe(true);
      expect(
        reason.trim().length,
        `${name} exemptBranches[${branch}] needs a reason of 20+ characters`
      ).toBeGreaterThanOrEqual(20);
    }

    if (targets.length >= 2) {
      const covered =
        'cases' in entry
          ? new Set(entry.cases.flatMap((item) => (item.target ? [item.target] : [])))
          : new Set<string>();
      for (const target of targets) {
        if (covered.has(target) && Object.hasOwn(exemptTargets, target))
          expect.fail(
            `${name} target ${target} is both covered by a case and listed in exemptTargets`
          );
        if (!covered.has(target) && !Object.hasOwn(exemptTargets, target))
          missingTargets.push(`${name} target ${target}`);
      }
    }
  }
  return missingTargets;
}

async function findMissingBranches(
  entries: Record<string, Entry>,
  inputsByName: Map<string, Input[]>
): Promise<string[]> {
  const missingBranches: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const branches = requiredBranchesOf(name);
    if (!branches.length) continue;
    const exemptBranches = entry.exemptBranches ?? {};
    let inputs: Input[];
    if ('exempt' in entry) {
      inputs = [];
    } else {
      const cached = inputsByName.get(name);
      if (cached) {
        inputs = cached;
      } else {
        inputs = [];
        for (const item of entry.cases) inputs.push((await item.arrange()).input);
      }
    }
    for (const branch of branches) {
      const covered = inputs.some((input) => branch.matches(input));
      if (covered && Object.hasOwn(exemptBranches, branch.label))
        expect.fail(
          `${name} branch ${branch.label} is both covered by a case and listed in exemptBranches`
        );
      if (!covered && !Object.hasOwn(exemptBranches, branch.label))
        missingBranches.push(`${name} branch ${branch.label}`);
    }
  }
  return missingBranches;
}

test('every endpoint that carries a revision or names a target has a stale-tab matrix entry and target coverage', () => {
  const missing = httpEntries
    .filter(({ name }) => {
      const { revisions, targets } = analysisOf(name);
      return revisions.length > 0 || targets.length > 0;
    })
    .map(({ name }) => name)
    .filter((name) => !Object.hasOwn(matrix, name));
  expect(
    missing,
    'Add an entry to the domain case file in tests/stale-tab/ for each endpoint listed (a new domain gets its own file, listed in domainFiles in tests/stale-tab-matrix.test.ts): a case that deletes or hides the target and expects 409 REVISION_CONFLICT for a write or 404 LIBRARY_ITEM_DELETED for a read or selection, or { exempt: reason } when nothing can be deleted underneath it.'
  ).toEqual([]);
  const domains = domainFiles.map(({ domain }) => domain);
  expect(domains, 'one case file per domain').toEqual([...new Set(domains)]);
  const known = new Set(endpointEntries.map(({ name }) => name));
  expect(Object.keys(caseEntries).filter((name) => !known.has(name))).toEqual([]);

  expect(
    findMissingTargets(matrix),
    'Add a case with target: "<path>" or an exemptTargets entry (20+ chars) for each missing target listed'
  ).toEqual([]);
});

test('a blanket endpoint exemption does not skip missing targets or union branches', async () => {
  const blanket: Record<string, Entry> = {
    'transfer.applyArchive': {
      exempt: 'Blanket exemption without per-target or per-branch reasons.',
    },
  };
  expect(findMissingTargets(blanket)).toEqual([
    'transfer.applyArchive target modelBindings[].model.id',
    'transfer.applyArchive target preparedId',
  ]);
  expect(await findMissingBranches(blanket, new Map())).toEqual([
    'transfer.applyArchive branch modelBindings[].mode=local',
  ]);
});

const probes = Object.entries(matrix).flatMap(([name, entry]) =>
  'exempt' in entry ? [] : entry.cases.map((item) => ({ name, ...item }))
);
const observedInputs = new Map<string, Input[]>();

test.each(probes)('$name with $when answers $answer.code', async (item) => {
  const { endpoint } = endpointEntries.find((entry) => entry.name === item.name)!;
  const revisions = analysisOf(item.name).revisions;
  const { input, control } = await item.arrange();
  const list = observedInputs.get(item.name) ?? [];
  list.push(input);
  observedInputs.set(item.name, list);
  if (item.target) {
    const probed = valuesAtPath(input, item.target);
    expect(
      probed.some((value) => value !== undefined && value !== null),
      `${item.name} target ${item.target} must be populated in input`
    ).toBe(true);
    if (control) {
      const live = valuesAtPath(control, item.target);
      expect(
        live.some((value) => value !== undefined && value !== null),
        `${item.name} target ${item.target} must be populated in control`
      ).toBe(true);
      expect(
        probed,
        `${item.name} target ${item.target} must differ between input and control`
      ).not.toEqual(live);
    }
  }
  if (revisions.length && !item.targetRevision)
    expect(control, 'a target reached through a shared revision needs a control').toBeDefined();
  const sent = Object.keys(input).filter((key) => revisions.includes(key));
  const stale = sent.filter((key) => typeof input[key] === 'number');
  if (!same(item.answer, conflict) && revisions.length && !item.targetRevision)
    expect(stale, 'a numeric top-level revision to send one ahead').not.toEqual([]);
  if (!same(item.answer, conflict) && stale.length) {
    const bumped = Object.fromEntries(stale.map((key) => [key, Number(input[key]) + 1]));
    const first = await call(endpoint, { ...input, ...bumped });
    expect(first, 'a stale revision answers before the target lookup').toMatchObject({
      status: 409,
      body: { code: 'REVISION_CONFLICT' },
    });
  }
  const response = await call(endpoint, input);
  expect({ status: response.status, body: response.body }).toEqual({
    status: item.answer.status,
    body: { code: item.answer.code },
  });
  if (control) {
    for (const key of sent)
      expect(control[key], `the control sends the same ${key}`).toEqual(input[key]);
    const live = await call(endpoint, control);
    expect(live.status, `the same revision with a live target: ${JSON.stringify(live.body)}`).toBe(
      200
    );
  }
});

test('every endpoint covers every union branch carrying a revision or target', async () => {
  expect(
    await findMissingBranches(matrix, observedInputs),
    'Add a case whose input matches each branch listed, or list it in exemptBranches with a reason of 20+ characters'
  ).toEqual([]);
});
