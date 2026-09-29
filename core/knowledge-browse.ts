import { createHash } from 'node:crypto';
import type { Resource, ToolEvent } from './types.js';

const MAX_CHARS = 24_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const excerpt = (value: string, limit: number) => {
  let end = Math.min(value.length, limit);
  if (end > 0 && (value.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return value.slice(0, end);
};
type Group = {
  type: 'package' | 'folder';
  key: string;
  title: string;
  packageId: string;
  role: string;
  sourceScope: string | null;
  revision: number;
  children: (Group | Resource)[];
  resourceCount: number;
};
const isGroup = (item: Group | Resource): item is Group => 'children' in item;

/** Build the small navigation view once; its owning Run snapshot controls the lifetime. */
export function createKnowledgeBrowser(
  resources: readonly Resource[],
  context: { chatId: string; role: string }
) {
  // Build once for this frozen corpus, without constructing a second full-body JSON copy.
  const contentHashes = new Map(resources.map((resource) => [resource.id, digest(resource.text)]));
  const stamp = createHash('sha256').update(JSON.stringify(context));
  for (const resource of resources) {
    const source = resource.risuSource;
    stamp.update(
      JSON.stringify([
        resource.id,
        resource.revision,
        digest(resource.title),
        digest(resource.description),
        resource.kind,
        resource.loading,
        source
          ? [source.contentId, source.sourceRole, source.sourceScope, digest(source.sourceName)]
          : null,
        resource.loreFolder,
        resource.relatedIds,
        contentHashes.get(resource.id),
      ])
    );
  }
  const version = stamp.digest('hex');
  const root: (Group | Resource)[] = [];
  const groups = new Map<string, Group>();
  const group = (
    type: Group['type'],
    key: string,
    title: string,
    resource: Resource,
    parent: (Group | Resource)[]
  ) => {
    let found = groups.get(key);
    if (!found) {
      const source = resource.risuSource!;
      found = {
        type,
        key,
        title,
        packageId: source.contentId,
        role: source.sourceRole,
        sourceScope: source.sourceScope ?? null,
        revision: resource.revision,
        children: [],
        resourceCount: 0,
      };
      groups.set(key, found);
      parent.push(found);
    }
    return found;
  };
  for (const resource of resources) {
    const source = resource.risuSource;
    if (!source?.contentId) {
      root.push(resource);
      continue;
    }
    const key = JSON.stringify([
      source.contentId,
      source.sourceRole,
      source.sourceScope ?? null,
      resource.revision,
    ]);
    const pack = group('package', key, source.sourceName, resource, root);
    pack.resourceCount++;
    if (!resource.loreFolder) {
      pack.children.push(resource);
      continue;
    }
    const folder = group(
      'folder',
      JSON.stringify([key, resource.loreFolder.id]),
      resource.loreFolder.name,
      resource,
      pack.children
    );
    folder.resourceCount++;
    folder.children.push(resource);
  }
  const nodeRef = (entry: Group) =>
    `kb:${digest(JSON.stringify([version, entry.type, entry.key]))}`;
  const byRef = new Map([...groups.values()].map((entry) => [nodeRef(entry), entry]));
  const allowedIds = new Set(resources.map((resource) => resource.id));
  return (action: { callId: string; name: string; args: Record<string, unknown> }): ToolEvent => {
    const { args } = action;
    const fail = (code: string, nextRead?: unknown): ToolEvent => ({
      ...action,
      args: {},
      denied: true,
      errorKind: 'recoverable',
      result: { code, returned: false, ...(nextRead ? { nextRead } : {}) },
    });
    if (
      Object.keys(args).some(
        (key) => !['mode', 'nodeRef', 'offset', 'limit', 'expectedVersion'].includes(key)
      ) ||
      (args.nodeRef !== undefined &&
        (typeof args.nodeRef !== 'string' || !args.nodeRef || args.nodeRef.length > 100)) ||
      (args.expectedVersion !== undefined &&
        (typeof args.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(args.expectedVersion)))
    )
      return fail('INVALID_ARGUMENTS');
    const offset = args.offset ?? 0,
      limit = args.limit ?? 20;
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      !Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100
    )
      return fail('INVALID_ARGUMENTS');

    const next = (nodeRef: string | undefined, at: number) => ({
      name: 'knowledge.search',
      arguments: {
        mode: 'browse',
        ...(nodeRef ? { nodeRef } : {}),
        offset: at,
        limit,
        expectedVersion: version,
      },
    });
    if (args.expectedVersion !== undefined && args.expectedVersion !== version)
      return fail('KNOWLEDGE_VIEW_CHANGED', next(undefined, 0));
    if (Number(offset) > 0 && args.expectedVersion === undefined)
      return fail('KNOWLEDGE_VERSION_REQUIRED', next(args.nodeRef as string | undefined, 0));

    const selected = args.nodeRef === undefined ? null : byRef.get(String(args.nodeRef));
    if (selected === undefined) return fail('RESOURCE_UNAVAILABLE', next(undefined, 0));
    const candidates = selected ? selected.children : root;
    if (Number(offset) > candidates.length) return fail('INVALID_ARGUMENTS');
    const describe = (item: Group | Resource) => {
      const title = excerpt(item.title, 200);
      if (isGroup(item))
        return {
          type: item.type,
          nodeRef: nodeRef(item),
          title,
          titleTruncated: title.length < item.title.length,
          packageId: item.packageId,
          role: item.role,
          sourceScope: item.sourceScope,
          revision: item.revision,
          childCount: item.children.length,
          resourceCount: item.resourceCount,
          nextRead: next(nodeRef(item), 0),
        };
      const description = excerpt(item.description, 160);
      const related = item.relatedIds?.filter((id) => allowedIds.has(id)) ?? [];
      return {
        type: 'reference',
        id: item.id,
        revision: item.revision,
        kind: item.kind,
        title,
        description,
        sourceHash: contentHashes.get(item.id),
        sourceKind: item.sourceKind,
        loading: item.loading ?? 'discoverable',
        textLength: item.text.length,
        unit: 'utf16-code-unit',
        relatedIds: related.slice(0, 16),
        relatedCount: related.length,
        metadataPreview: {
          title: { totalChars: item.title.length, returnedChars: title.length },
          description: { totalChars: item.description.length, returnedChars: description.length },
          relatedIds: { total: related.length, returned: Math.min(16, related.length) },
        },
        nextRead: {
          name: item.kind === 'skill' ? 'skills.load' : 'knowledge.read',
          arguments: {
            ...(item.kind === 'skill' ? { id: item.id } : { ids: [item.id] }),
            offset: 0,
            limit: 4096,
          },
        },
      };
    };
    const items: ReturnType<typeof describe>[] = [];
    const result = () => {
      const end = Number(offset) + items.length;
      return {
        scope: { ...context, nodeRef: args.nodeRef ?? null },
        version,
        items,
        total: candidates.length,
        offset,
        coverage: {
          content: 'metadata-only',
          scopeResources: selected?.resourceCount ?? resources.length,
          returned: items.length,
        },
        nextOffset: end < candidates.length ? end : null,
        nextRead: end < candidates.length ? next(args.nodeRef as string | undefined, end) : null,
      };
    };
    for (const item of candidates.slice(Number(offset), Number(offset) + Number(limit))) {
      items.push(describe(item));
      if (JSON.stringify(result()).length > MAX_CHARS) {
        items.pop();
        if (!items.length) return fail('RESULT_METADATA_TOO_LARGE');
        break;
      }
    }
    return {
      ...action,
      args: {
        mode: 'browse',
        ...(args.nodeRef ? { nodeRef: args.nodeRef } : {}),
        offset,
        limit,
        expectedVersion: version,
      },
      denied: false,
      result: result(),
    };
  };
}
