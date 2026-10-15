import { illustrationPresetCatalog, deleteIllustrationPreset } from './illustration-presets.js';
import { emptyIllustrationPreset } from '../core/illustration-presets.js';
import { themeCatalog, deleteTheme } from './themes.js';
import { THEME_COLOR_KEYS, THEME_SLOTS, BUILTIN_THEMES, themeDefinition } from '../core/themes.js';
import type { ProviderTool } from '../core/transport.js';
import type { ResourceKind, ResourceModel } from '../core/resource-editing.js';
import { editableResource } from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import { cloneResource, readResource, saveResource, undoResource } from './resource-service.js';
import { deleteLibraryItem } from './library-deletion.js';
import { fields, record, number, text, HttpError } from './request-validation.js';
import { patchHelperResource, readHelperResource } from './helper-resource-editing.js';

const kind = {
  type: 'string',
  enum: ['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'],
};
const string = { type: 'string' };
const revision = { type: 'integer', minimum: 1 };
type ResourceMutationTarget = { kind: ResourceKind; id: string | null };
type ResourceToolDefinition = ProviderTool &
  (
    | { effect: 'read' }
    | {
        effect: 'mutation';
        target: (args: Record<string, unknown>) => ResourceMutationTarget | null;
      }
  );
function resourceTarget(args: Record<string, unknown>): ResourceMutationTarget | null {
  if (!kind.enum.includes(String(args.kind))) return null;
  if (args.id != null && typeof args.id !== 'string') return null;
  return {
    kind: args.kind as ResourceKind,
    id: args.kind === 'prompt-workspace' ? 'current' : ((args.id as string | null) ?? null),
  };
}
const resourceTools: ResourceToolDefinition[] = [
  {
    name: 'illustration-preset.list',
    effect: 'read',
    description:
      'List illustration preset names, revisions and selections. Read a recipe with resource.read kind=illustration-preset.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'illustration-preset.guide',
    effect: 'read',
    description:
      'Read the portable illustration preset authoring contract. Saving and selecting are separate; this tool never generates images.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.list',
    effect: 'read',
    description:
      'List saved and built-in presentation themes with current selections. Themes do not affect model inputs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.guide',
    effect: 'read',
    description:
      'Read the theme authoring contract and example before editing. Save with resource.save kind=theme; selecting it is separate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resource.read',
    effect: 'read',
    description:
      'Read a compact resource overview, then follow readyPaths into authored fields. Native promptTemplate array pages return block metadata and textLengths without bodies by default. Set includeBodies:true for a path read of the promptTemplate array to include all authored text/innerFormat/defaultText per block when each fits the 24000-character result budget; nextOffset continues unread blocks, and oversized single blocks expose omittedBodyPaths for exact follow-up reads. This does not evaluate CBS. Metadata over 200 units appears instead under block.previews[field] with text, full length and a path for exact reads. Use limit:50 to inspect up to 50 blocks, following nextOffset. Use path for one read or paths for 1-16 reads of the same revision, never both. Batch items keep individual results/errors; resubmit paths.slice(nextIndex) for unreturned paths. Shared fields/offset/limit and textOffset/textLimit apply to every path. Object and array pages preserve exact small scalar values. A missing optional field returns exists:false with its path. The complete response stays within 24000 serialized characters. Revision is required for resource.patch and resource.clone.',
    inputSchema: {
      type: 'object',
      properties: {
        kind,
        id: string,
        path: string,
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', maxLength: 1024 },
        },
        fields: { type: 'array', items: string, maxItems: 50 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        textOffset: { type: 'integer', minimum: 0 },
        textLimit: { type: 'integer', minimum: 1, maximum: 10000 },
        includeBodies: { type: 'boolean' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.patch',
    effect: 'mutation',
    target: resourceTarget,
    description:
      'Edit existing native card/module or prompt-preset fields with the latest revision. Use resource.read paths or a library editTarget. set changes simple typed fields; replaceText changes one unique literal excerpt. A prompt-preset display name is /title, independent of /program/nativeRisuPreset/preset/name; change both explicitly when needed. Native prompt text/options and /values are editable. If toggle definitions change, stale saved values are reconciled and resetKeys reports dropped or reset control IDs; explicit invalid /values edits are still rejected. Set source.translationGuidePath to {instructions:string,terms:[{source:string,target:string,note?:string}]} for a complete translation guide. insert/remove use indexed paths in card character_book/entries, module lorebook, translationGuide/terms, or native preset promptTemplate. Insert one object or remove one item; absent card books/module lore are created on first insert. move is only for promptTemplate: from and path are full indexed paths in the same array, with destination indexed AFTER removal. Changes run sequentially, so later paths refer to the already changed array. All changes validate and save together with one undo; a failure saves nothing. Projection fields such as package.lore/body/starts are read only.',
    inputSchema: {
      type: 'object',
      properties: {
        kind,
        id: string,
        expectedRevision: revision,
        changes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: string,
              op: { type: 'string', enum: ['set', 'replaceText', 'insert', 'remove', 'move'] },
              from: string,
              value: {},
              oldText: string,
              newText: string,
            },
            required: ['path', 'op'],
            additionalProperties: false,
          },
        },
      },
      required: ['kind', 'id', 'expectedRevision', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.clone',
    effect: 'mutation',
    target: (args) =>
      args.kind === 'content' || args.kind === 'prompt-preset'
        ? { kind: args.kind, id: null }
        : null,
    description:
      'Create an independent copy of a saved bot/persona/module or prompt preset without reading or resending its full model. Requires sourceId, expectedSourceRevision and the new display title. Returns a new id/revision and the copied source id/revision; patch the returned id to edit the copy. Preserves prompt blocks, controls, defaults and current values. Native preset name is independent and preserved by default; syncNativeName:true updates it to the new title. Content copies follow native naming and start with no relatedIds. Does not copy unsaved editor input, saved option combinations, folder placement, active selections, chat history or undo history, and never edits the source. Singleton prompt-workspace is not supported.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['content', 'prompt-preset'] },
        sourceId: string,
        expectedSourceRevision: revision,
        title: string,
        syncNativeName: { type: 'boolean' },
      },
      required: ['kind', 'sourceId', 'expectedSourceRevision', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.save',
    effect: 'mutation',
    target: resourceTarget,
    description:
      'Create an application resource, or save a complete editable model for kinds without partial editing. Use resource.clone to copy saved content or a prompt preset. For existing native card/module or prompt-preset edits use resource.patch so unrelated fields stay intact. Use latest revision for existing IDs; omit id/revision to create. There is no server draft or separate apply step. A draft/proposal request does not authorize saving.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: string, expectedRevision: revision, model: { type: 'object' } },
      required: ['kind', 'model'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.undo',
    effect: 'mutation',
    target: resourceTarget,
    description: 'Restore the immediately previous saved resource using its current revision.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: string, expectedRevision: revision },
      required: ['kind', 'id', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.delete',
    effect: 'mutation',
    target: resourceTarget,
    description:
      'Remove a bot/persona/module or preset from the library using its current revision.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['content', 'prompt-preset', 'theme', 'illustration-preset'],
        },
        id: string,
        expectedRevision: revision,
      },
      required: ['kind', 'id', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'image.update-metadata',
    effect: 'mutation',
    target: (args) =>
      typeof args.contentId === 'string' ? { kind: 'content', id: args.contentId } : null,
    description:
      'Edit an image display name and description used for JEV image selection. Does not change image bytes, IDs, or native script reference names. Read the owning content first.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: string,
        imageId: string,
        expectedRevision: revision,
        title: string,
        description: string,
      },
      required: ['contentId', 'imageId', 'expectedRevision', 'title', 'description'],
      additionalProperties: false,
    },
  },
];
export const RESOURCE_TOOLS: ProviderTool[] = resourceTools.map((definition) => {
  const { effect: _effect, ...tool } = definition;
  if ('target' in tool) {
    const { target: _target, ...schema } = tool;
    return schema;
  }
  return tool;
});

/** Shared resource effects: draft protection and receipts follow the same tool definition. */
export function helperResourceOperation(
  name: string,
  args: Record<string, unknown> = {}
): { readOnly: true } | { readOnly: false; target: ResourceMutationTarget | null } | undefined {
  const definition = resourceTools.find((tool) => tool.name === name);
  if (!definition) return undefined;
  return definition.effect === 'read'
    ? { readOnly: true }
    : { readOnly: false, target: definition.target(args) };
}
const summary = (result: ReturnType<typeof saveResource>) => ({
  created: result.created,
  revision: result.saved.revision,
  ...('id' in result.saved
    ? { id: result.saved.id, title: result.saved.title }
    : { id: 'current' }),
});

export function invokeResourceTool(
  store: Store,
  name: string,
  args: Record<string, unknown>
): unknown {
  if (name === 'illustration-preset.list') {
    const catalog = illustrationPresetCatalog(store);
    return {
      ...catalog,
      presets: catalog.presets.map(({ id, revision, title, description, generator }) => ({
        id,
        revision,
        title,
        description,
        generator,
      })),
    };
  }
  if (name === 'illustration-preset.guide')
    return {
      example: emptyIllustrationPreset(),
      contract:
        'Save with resource.save kind=illustration-preset. Required title and generator (codex or comfyui), optional description and styleGuidance, comfyui: {workflow, negativeGuidance}. workflow is API-format JSON with {{prompt}}, {{negative}}, {{seed}} placeholders; an empty workflow is valid for Codex but cannot generate with ComfyUI. The selected recipe chooses the generator and uses its shared local environment. No provider IDs, credentials, automatic-generation policies or chat reference images belong here. Portable exports are v2; v1 infers comfyui when a workflow exists, otherwise codex. Saving an in-use preset affects future reservations; existing jobs and retries keep frozen input. Saving a new preset does not select it. User selection priority: chat, bot, global. No image generation on save.',
    };
  if (name === 'theme.list') return themeCatalog(store);
  if (name === 'theme.guide')
    return {
      colors: THEME_COLOR_KEYS,
      slots: THEME_SLOTS,
      optionalSlots: ['portrait', 'request-persona'],
      example: themeDefinition(BUILTIN_THEMES[1]),
      contract:
        'Save with resource.save kind=theme. title required. colors.light/dark map the documented names without -- to hex colors. appCss styles the app; messageCss is a low-priority layer in each Risu message ShadowRoot. templateHtml needs exactly one native slot for each name: request, heading, body, actions; templateCss styles that layout ShadowRoot. Optional single portrait and request-persona slots project app-owned portraits and zoom controls; request-persona belongs beside submitted user input. An optional data-uimori-body-scroll marker on the body slot opts into bounded inner scrolling with reading/navigation support. Do not hardcode character URLs. Empty HTML uses the default. No JavaScript or CBS in themes. Preserve reading preferences and bot HTML. Use responsive CSS. Stable data-uimori-part hooks: scene, scene-frame, request, heading, body, actions, composer-input, scene-portraits, portrait-group, bot-portrait, persona-portrait. Layout and palette selection are independent server preferences; saved theme colors remain portable. External images remain URL references; data URLs travel with JSON. Saving does not select. Full guide: docs/THEME-AUTHORING.md.',
    };
  if (name === 'image.update-metadata') {
    const id = text(args.contentId, 'content ID', 100);
    const content = readResource(store, 'content', id) as Content;
    const imageId = text(args.imageId, 'image ID', 200);
    if (!content.package.images?.some((image) => image.id === imageId))
      throw new HttpError(404, '이미지를 찾을 수 없어요.');
    const title = text(args.title, 'image title', 200);
    const description = text(args.description, 'image description', 2000, true);
    return summary(
      saveResource(store, {
        kind: 'content',
        id,
        expectedRevision: number(args.expectedRevision, 'revision'),
        model: {
          ...editableResource('content', content),
          package: {
            ...content.package,
            images: content.package.images.map((image) =>
              image.id === imageId ? { ...image, title, description } : image
            ),
          },
        } as ResourceModel,
      })
    );
  }
  if (
    !['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'].includes(
      String(args.kind)
    )
  )
    throw new HttpError(400, '자료 종류를 확인해 주세요.');
  const kind = args.kind as ResourceKind;
  if (name === 'resource.clone') {
    fields(args, ['kind', 'sourceId', 'expectedSourceRevision', 'title', 'syncNativeName']);
    if (args.syncNativeName !== undefined && typeof args.syncNativeName !== 'boolean')
      throw new HttpError(400, '내부 이름 동기화 옵션을 확인해 주세요.');
    if (kind !== 'content' && kind !== 'prompt-preset')
      throw new HttpError(400, '봇·페르소나·모듈과 프롬프트 프리셋만 복제할 수 있어요.');
    const result = cloneResource(store, {
      kind,
      sourceId: text(args.sourceId, 'source resource ID', 100),
      expectedSourceRevision: number(args.expectedSourceRevision, 'source revision'),
      title: text(args.title, 'title', 200),
      ...(args.syncNativeName === undefined ? {} : { syncNativeName: args.syncNativeName }),
    });
    return { ...summary(result), source: result.source };
  }
  const id = args.id == null ? null : text(args.id, 'resource ID', 100);
  if (name === 'resource.read') return readHelperResource(store, kind, id ?? 'current', args);
  if (name === 'resource.patch') {
    if (!id) throw new HttpError(400, '자료 ID가 필요해요.');
    return patchHelperResource(
      store,
      kind,
      id,
      number(args.expectedRevision, 'revision'),
      args.changes
    );
  }
  const expectedRevision =
    args.expectedRevision === undefined ? undefined : number(args.expectedRevision, 'revision');
  if (name === 'resource.save')
    return summary(
      saveResource(store, {
        kind,
        id,
        expectedRevision,
        model: record(args.model) as ResourceModel,
      })
    );
  if (!id || expectedRevision === undefined)
    throw new HttpError(400, '자료 ID와 수정 번호가 필요해요.');
  if (name === 'resource.undo') return summary(undoResource(store, kind, id, expectedRevision));
  if (name === 'resource.delete' && kind === 'illustration-preset')
    return deleteIllustrationPreset(store, id, expectedRevision);
  if (name === 'resource.delete' && kind === 'theme')
    return deleteTheme(store, id, expectedRevision);
  if (name === 'resource.delete' && (kind === 'content' || kind === 'prompt-preset'))
    return deleteLibraryItem(store, kind, id, { expectedRevision });
  throw new HttpError(400, '지원하지 않는 자료 작업이에요.');
}
