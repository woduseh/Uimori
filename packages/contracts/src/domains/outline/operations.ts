import { z } from 'zod/v4';
import { defineCommandOperation } from '../../split-operation.js';
import { nonBlank } from '../text.js';
import {
  OUTLINE_BATCH_LIMIT,
  OUTLINE_INTENT_MAX,
  OUTLINE_LEVELS,
  OUTLINE_POSITION_MAX,
  OUTLINE_RELATED_LIMIT,
  OUTLINE_TITLE_MAX,
  type OutlineLevel,
  type OutlineWritingOrigin,
} from './limits.js';

const chatId = nonBlank(120);
const outlineNodeId = nonBlank(100);
const outlineLevel = z.enum(OUTLINE_LEVELS);
const outlineRevision = z.int().min(1).max(1_000_000_000);
const outlinePosition = z.int().min(0).max(OUTLINE_POSITION_MAX);
const relatedIds = z
  .array(outlineNodeId)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate related outline IDs')
  .describe(
    `Ids of up to ${OUTLINE_RELATED_LIMIT} other plans in the same chat that this item relates to.`
  );

const createOutlineOperation = z
  .strictObject({
    op: z.literal('create'),
    ref: nonBlank(100)
      .describe(
        'Temporary name for the new item, so later operations in this call can use it as parentRef.'
      )
      .optional(),
    parentRef: nonBlank(100)
      .describe('Parent created earlier in this call, by its ref.')
      .optional(),
    parentId: outlineNodeId
      .nullable()
      .describe('Id of an existing parent item, or null for the top level.')
      .optional(),
    level: outlineLevel.describe('Kind of the new item.'),
    title: nonBlank(OUTLINE_TITLE_MAX).describe('Title of the item.'),
    intent: z
      .string()
      .max(OUTLINE_INTENT_MAX)
      .describe('The writing brief of the item: what it should achieve.'),
    position: outlinePosition.describe('Index among the siblings under the parent.').optional(),
    relatedIds: relatedIds.optional(),
    fixed: z
      .boolean()
      .describe('Mark the item as one the author wants kept during elaboration.')
      .optional(),
  })
  .refine(
    (item) => !(item.parentRef !== undefined && item.parentId !== undefined),
    'Send parentRef or parentId, not both'
  );

const updateOutlineOperation = z
  .strictObject({
    op: z.literal('update'),
    id: outlineNodeId.describe('Id of the existing item.'),
    expectedRevision: outlineRevision.describe('Current revision of the item, from outline.read.'),
    level: outlineLevel
      .describe(
        'Change the kind; it must stay smaller than its parent and larger than its children.'
      )
      .optional(),
    title: nonBlank(OUTLINE_TITLE_MAX).describe('Title of the item.').optional(),
    intent: z
      .string()
      .max(OUTLINE_INTENT_MAX)
      .describe('The writing brief of the item: what it should achieve.')
      .optional(),
    fixed: z
      .boolean()
      .describe('Mark the item as one the author wants kept during elaboration.')
      .optional(),
    relatedIds: relatedIds.optional(),
  })
  .refine(
    (item) =>
      item.level !== undefined ||
      item.title !== undefined ||
      item.intent !== undefined ||
      item.fixed !== undefined ||
      item.relatedIds !== undefined,
    'Expected at least one field to update'
  );

const moveOutlineOperation = z.strictObject({
  op: z.literal('move'),
  id: outlineNodeId.describe('Id of the existing item.'),
  expectedRevision: outlineRevision.describe('Current revision of the item, from outline.read.'),
  parentId: outlineNodeId
    .nullable()
    .describe('Id of an existing parent item, or null for the top level.')
    .optional(),
  position: outlinePosition.describe('Index among the siblings under the parent.'),
});

const removeOutlineOperation = z.strictObject({
  op: z.literal('remove'),
  id: outlineNodeId.describe('Id of the existing item.'),
  expectedRevision: outlineRevision.describe('Current revision of the item, from outline.read.'),
});

export const outlineOperation = z.discriminatedUnion('op', [
  createOutlineOperation,
  updateOutlineOperation,
  moveOutlineOperation,
  removeOutlineOperation,
]);

export type OutlineOperation = z.output<typeof outlineOperation>;

export type OutlineCreatedNode = { ref?: string; id: string };

export type OutlineFocus = { nodeId: string; level: OutlineLevel; title: string } | null;

export type OutlineProgress = {
  state: 'planned' | 'scheduled' | 'writing' | 'written' | 'failed' | 'cancelled';
  commandId: string | null;
  runId: string | null;
  sourceRevision: string | null;
};

export type OutlineWriting = {
  sourceRevision: string;
  sourceHash: string;
  nodeId: string;
  origin: OutlineWritingOrigin;
  current: boolean;
  createdAt: string;
};

export type OutlineNode = {
  id: string;
  chatId: string;
  parentId: string | null;
  level: OutlineLevel;
  position: number;
  title: string;
  intent: string;
  fixed: boolean;
  revision: number;
  progress: OutlineProgress;
  relatedIds?: string[];
  writings?: OutlineWriting[];
  createdAt: string;
  updatedAt: string;
};

export type OutlineDetail = {
  chatId: string;
  focusId: string | null;
  nodes: OutlineNode[];
};

export type OutlineApplyResult = {
  detail: OutlineDetail;
  created: OutlineCreatedNode[];
};

export const setOutlineFocusHead = z.strictObject({ chatId });
export const setOutlineFocusBody = z.strictObject({ nodeId: outlineNodeId.nullable() });

export const applyOutlineHead = z.strictObject({
  chatId,
  idempotencyKey: nonBlank(120),
});

export const applyOutlineBody = z.strictObject({
  operations: z
    .array(outlineOperation)
    .min(1)
    .max(OUTLINE_BATCH_LIMIT)
    .refine((operations) => {
      const refs = new Set<string>();
      for (const item of operations) {
        if (item.op !== 'create' || item.ref === undefined) continue;
        if (refs.has(item.ref)) return false;
        refs.add(item.ref);
      }
      return true;
    }, 'Duplicate outline ref in batch')
    .describe('Operations applied in order; all of them save or none does.'),
});

export const outlineOperations = {
  setFocus: defineCommandOperation<OutlineFocus>()({
    name: 'outline.setFocus',
    head: setOutlineFocusHead,
    body: setOutlineFocusBody,
  }),
  apply: defineCommandOperation<OutlineApplyResult>()({
    name: 'outline.apply',
    head: applyOutlineHead,
    body: applyOutlineBody,
  }),
};
