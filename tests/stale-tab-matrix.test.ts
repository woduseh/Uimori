import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod/v4';
import { allEndpoints, type Endpoint, isAppErrorCode } from '#contracts';
import * as contracts from '#contracts';
import { allOperations } from '#contracts/operations';
import * as operations from '#contracts/operations';
import { appearanceCases } from './stale-tab/appearance.js';
import { deletionCases } from './stale-tab/deletion.js';
import {
  type Answer,
  call,
  conflict,
  deleted,
  type Domain,
  type DomainCases,
  type Entry,
  startStaleTabApp,
  stopStaleTabApp,
} from './stale-tab/harness.js';
import { libraryCases } from './stale-tab/library.js';
import { personalWorkspaceCases } from './stale-tab/personal-workspace.js';
import { promptsCases } from './stale-tab/prompts.js';
import { providersCases } from './stale-tab/providers.js';
import { readerCases } from './stale-tab/reader.js';
import { resourceEditorsCases } from './stale-tab/resource-editors.js';
import { translationCases } from './stale-tab/translation.js';

const domainFiles: DomainCases[] = [
  appearanceCases,
  deletionCases,
  libraryCases,
  personalWorkspaceCases,
  promptsCases,
  providersCases,
  readerCases,
  resourceEditorsCases,
  translationCases,
];
const matrix: Record<string, Entry> = Object.fromEntries(
  domainFiles.flatMap(({ domain, entries }) =>
    Object.entries(entries as Record<string, Entry>).map(([key, entry]) => [
      `${domain}.${key}`,
      entry,
    ])
  )
);

const revisionField = /^expected[A-Z]\w*$|^\w+Revision$/u;
const targetField = /^(?:id|\w+Id)$/u;
const same = (left: Answer, right: Answer) =>
  left.status === right.status && left.code === right.code;

beforeAll(startStaleTabApp);
afterAll(stopStaleTabApp);

function fieldNames(schema: z.ZodType): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const internals = (value as { _zod?: { def?: Record<string, unknown>; innerType?: unknown } })
      ._zod;
    const def = internals?.def;
    if (!def) {
      for (const child of Object.values(value)) visit(child);
      return;
    }
    if (def.type === 'lazy') visit(internals.innerType);
    if (def.type === 'object')
      for (const [key, child] of Object.entries(def.shape as object)) {
        found.add(key);
        visit(child);
      }
    for (const [key, child] of Object.entries(def)) if (key !== 'shape') visit(child);
  };
  visit(schema);
  return [...found].sort();
}
const revisionFields = (schema: z.ZodType) =>
  fieldNames(schema).filter((name) => revisionField.test(name));
const targetFields = (schema: z.ZodType) =>
  fieldNames(schema).filter((name) => targetField.test(name));

const endpointEntries = Object.entries(allEndpoints).flatMap(([domain, endpoints]) =>
  Object.entries(endpoints).map(([key, endpoint]) => ({
    domain: domain as Domain,
    name: `${domain}.${key}`,
    endpoint: endpoint as Endpoint,
  }))
);
const operationFor = (domain: Domain, name: string) =>
  Object.values(allOperations[domain]).find((operation) => operation.name === name);
const inputOf = (name: string) => {
  const { domain, endpoint } = endpointEntries.find((item) => item.name === name)!;
  return operationFor(domain, endpoint.operation)!.input;
};

test('every endpoint names an operation of its own domain and every operation is served', () => {
  expect(Object.keys(allOperations).sort()).toEqual(Object.keys(allEndpoints).sort());
  for (const { domain, name, endpoint } of endpointEntries) {
    expect(endpoint.operation.startsWith(`${domain}.`), name).toBe(true);
    expect(
      operationFor(domain, endpoint.operation),
      `${name} → ${endpoint.operation}`
    ).toBeDefined();
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

test('the field walker reads through unions, refinements and nested objects', () => {
  const { appearance, library, resourceEditors, prompts } = allOperations;
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
  ).toEqual(['expectedOrder', 'workspaceRevision']);
  expect(targetFields(allOperations['personal-workspace'].addBookmark.input)).toEqual([
    'chatId',
    'id',
    'sourceId',
  ]);
});

test('every endpoint that carries a revision or names a target has a stale-tab matrix entry', () => {
  const missing = endpointEntries
    .filter(({ name }) => {
      const input = inputOf(name);
      return revisionFields(input).length > 0 || targetFields(input).length > 0;
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
  expect(Object.keys(matrix).filter((name) => !known.has(name))).toEqual([]);
  for (const [name, entry] of Object.entries(matrix)) {
    if ('exempt' in entry) {
      expect(entry.exempt.length, name).toBeGreaterThan(20);
      continue;
    }
    for (const item of entry.cases) {
      const label = `${name} with ${item.when}`;
      expect(isAppErrorCode(item.answer.code), `${label}: ${item.answer.code}`).toBe(true);
      if (!same(item.answer, conflict) && !same(item.answer, deleted))
        expect(item.reason, `${label} answers ${item.answer.code} and needs a reason`).toBeTruthy();
    }
  }
});

const probes = Object.entries(matrix).flatMap(([name, entry]) =>
  'exempt' in entry ? [] : entry.cases.map((item) => ({ name, ...item }))
);

test.each(probes)('$name with $when answers $answer.code', async (item) => {
  const { endpoint } = endpointEntries.find((entry) => entry.name === item.name)!;
  const revisions = revisionFields(inputOf(item.name));
  const { input, control } = await item.arrange();
  if (revisions.length && !item.targetRevision)
    expect(control, 'a target reached through a shared revision needs a control').toBeDefined();
  const sent = Object.keys(input).filter((key) => revisions.includes(key));
  const stale = sent.filter((key) => typeof input[key] === 'number');
  if (!same(item.answer, conflict) && revisions.length)
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
