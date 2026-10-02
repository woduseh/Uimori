import { illustrationPresetCatalog, deleteIllustrationPreset } from './illustration-presets.js';
import { emptyIllustrationPreset } from '../core/illustration-presets.js';
import { themeCatalog, deleteTheme } from './themes.js';
import { THEME_COLOR_KEYS, THEME_SLOTS, BUILTIN_THEMES, themeDefinition } from '../core/themes.js';
import type { ProviderTool } from '../core/transport.js';
import type { ResourceKind, ResourceModel } from '../core/resource-editing.js';
import { editableResource } from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import { readResource, saveResource, undoResource } from './resource-service.js';
import { deleteLibraryItem } from './library-deletion.js';
import { record, number, text, HttpError } from './request-validation.js';
import { patchHelperResource, readHelperResource } from './helper-resource-editing.js';

const kind = {
  type: 'string',
  enum: ['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'],
};
const string = { type: 'string' };
const revision = { type: 'integer', minimum: 1 };
export const RESOURCE_TOOLS: ProviderTool[] = [
  {
    name: 'illustration-preset.list',
    description:
      'List illustration preset names, revisions and selections. Read a recipe with resource.read kind=illustration-preset.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'illustration-preset.guide',
    description:
      'Read the portable illustration preset authoring contract. Saving and selecting are separate; this tool never generates images.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.list',
    description:
      'List saved and built-in presentation themes with current selections. Themes do not affect model inputs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.guide',
    description:
      'Read the theme authoring contract and example before editing. Save with resource.save kind=theme; selecting it is separate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resource.read',
    description:
      'Read a compact resource overview, then follow JSON Pointer paths into its authored fields. Use path for one read or paths for 1-16 reads of the same resource revision, never both. Batch items keep individual results/errors; resubmit paths.slice(nextIndex) for unreturned paths. Shared fields/offset/limit and textOffset/textLimit apply to every path; each item nextOffset continues its own page. Object and array pages list paths and exact small scalar values. A missing optional field returns exists:false with its patchable path. The complete response stays within 24000 serialized characters. Revision is required for resource.patch.',
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
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.patch',
    description:
      'Edit existing native card/module or prompt-preset authored fields with the latest revision. Use resource.read paths or a library editTarget. set changes a simple typed field, including native prompt text/options and preset values; replaceText changes one unique literal excerpt. Set source.translationGuidePath from resource.read to {instructions:string,terms:[{source:string,target:string,note?:string}]} to create or replace a card/module translation guide. insert/remove use an indexed path only in card character_book/entries, module lorebook, or translationGuide/terms. Insert one entry object or remove the indexed entry. A missing card book or module lorebook is created on first insert. All changes save together with one undo. Projection fields such as package.lore/body/starts are read only.',
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
              op: { type: 'string', enum: ['set', 'replaceText', 'insert', 'remove'] },
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
    name: 'resource.save',
    description:
      'Create an application resource, or save a complete editable model for kinds without partial editing. For existing native card/module content use resource.read then resource.patch, so unrelated authored fields stay intact. Use latest revision for existing IDs; omit id/revision to create. There is no server draft or separate apply step. A draft/proposal request does not authorize saving.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: string, expectedRevision: revision, model: { type: 'object' } },
      required: ['kind', 'model'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.undo',
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
      presets: catalog.presets.map(({ id, revision, title, description }) => ({
        id,
        revision,
        title,
        description,
      })),
    };
  }
  if (name === 'illustration-preset.guide')
    return {
      example: emptyIllustrationPreset(),
      contract:
        'Save with resource.save kind=illustration-preset. Required title, optional description and styleGuidance, comfyui: {workflow, negativeGuidance}. workflow is API-format JSON with {{prompt}}, {{negative}}, {{seed}} placeholders; an empty workflow is valid for Codex but cannot generate with ComfyUI. No provider IDs, credentials, automatic-generation policies or chat reference images belong here. Saving an in-use preset affects future reservations; existing jobs and retries keep frozen input. Saving a new preset does not select it. User selection priority: chat, bot, global. No image generation on save.',
    };
  if (name === 'theme.list') return themeCatalog(store);
  if (name === 'theme.guide')
    return {
      colors: THEME_COLOR_KEYS,
      slots: THEME_SLOTS,
      optionalSlots: ['portrait'],
      example: themeDefinition(BUILTIN_THEMES[1]),
      contract:
        'Save with resource.save kind=theme. title required. colors.light/dark map the documented names without -- to hex colors. appCss styles the app; messageCss is a low-priority layer in each Risu message ShadowRoot. templateHtml needs exactly one native slot for each name: request, heading, body, actions; templateCss styles that layout ShadowRoot. Optional single portrait slot projects app-owned current bot/persona portraits and zoom controls; do not hardcode character URLs. Empty HTML uses the default. No JavaScript or CBS in themes. Preserve reading preferences and bot HTML. Use responsive CSS. Stable data-uimori-part hooks: scene, scene-frame, request, heading, body, actions, composer-input, scene-portraits, portrait-group, bot-portrait, persona-portrait. Layout and palette selection are independent server preferences; saved theme colors remain portable. External images remain URL references; data URLs travel with JSON. Saving does not select. Full guide: docs/THEME-AUTHORING.md.',
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
    throw new HttpError(400, '자료 ID와 개정 번호가 필요해요.');
  if (name === 'resource.undo') return summary(undoResource(store, kind, id, expectedRevision));
  if (name === 'resource.delete' && kind === 'illustration-preset')
    return deleteIllustrationPreset(store, id, expectedRevision);
  if (name === 'resource.delete' && kind === 'theme')
    return deleteTheme(store, id, expectedRevision);
  if (name === 'resource.delete' && (kind === 'content' || kind === 'prompt-preset'))
    return deleteLibraryItem(store, kind, id, { expectedRevision });
  throw new HttpError(400, '지원하지 않는 자료 작업이에요.');
}
