import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';

const id = nonBlank(100);
export const resourceKind = z.enum([
  'content',
  'prompt-preset',
  'prompt-workspace',
  'theme',
  'illustration-preset',
]);
const resourceModel = z.record(z.string(), z.unknown());
const savedResource = z.looseObject({ revision });
const saveResult = {
  saved: savedResource,
  created: z.boolean(),
  creationOrganizationRevision: revision.optional(),
};
const resourceTarget = { kind: resourceKind, id };

export const saveResourceInput = z.strictObject({
  kind: resourceKind,
  id: id.nullable().optional(),
  expectedRevision: revision.optional(),
  model: resourceModel,
  idempotencyKey: nonBlank(200).optional(),
});
export type SaveResource = z.infer<typeof saveResourceInput>;

const cloneSource = { sourceId: id, expectedSourceRevision: revision, title: nonBlank(200) };
export const cloneResourceInput = z.discriminatedUnion('kind', [
  z.strictObject({ ...cloneSource, kind: z.literal('content') }),
  z.strictObject({
    ...cloneSource,
    kind: z.literal('prompt-preset'),
    syncNativeName: z.boolean().optional(),
  }),
]);
export type CloneResource = z.infer<typeof cloneResourceInput>;

export const resourceEditorOperations = {
  readResource: defineOperation(
    'resourceEditors.readResource',
    z.strictObject(resourceTarget),
    savedResource
  ),
  readPreviousResource: defineOperation(
    'resourceEditors.readPreviousResource',
    z.strictObject(resourceTarget),
    z.strictObject({ savedRevision: revision, model: resourceModel })
  ),
  saveResource: defineOperation(
    'resourceEditors.saveResource',
    saveResourceInput,
    z.strictObject(saveResult)
  ),
  cloneResource: defineOperation(
    'resourceEditors.cloneResource',
    cloneResourceInput,
    z.strictObject({ ...saveResult, source: z.strictObject({ id: z.string(), revision }) })
  ),
  undoResource: defineOperation(
    'resourceEditors.undoResource',
    z.strictObject({ ...resourceTarget, expectedRevision: revision }),
    z.strictObject(saveResult)
  ),
};
