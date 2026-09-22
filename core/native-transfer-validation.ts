import { validateRisuContent, type RisuContent } from './risu-content.js';
import { IDENTITY_PATTERN } from './identity.js';
import { resolvePackageGraph } from './package-graph.js';
import { PACKAGE_IMAGE_MIMES } from './package-images.js';
import {
  resolveEditablePromptValues,
  resolveControlValues,
  validateEditableRisuPrompt,
  validateControlDefinitions,
} from './risu-prompt.js';
import { matchesPromptCombination } from './prompt-combinations.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  NATIVE_TRANSFER_MAX_BYTES,
  type NativeTransferFile,
  type NativeTransferPrepare,
} from './native-transfer.js';

export class NativeTransferError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new NativeTransferError(`NATIVE_TRANSFER_${code}`);
};
function object(value: unknown, fields: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')
    )
  )
    fail('FIELDS');
  return value as Record<string, any>;
}
function text(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail('TEXT');
}
function list(value: unknown, max: number): any[] {
  if (!Array.isArray(value) || value.length > max) fail('LIST');
  return value as any[];
}
function identity(value: unknown) {
  text(value, 100);
  if (!IDENTITY_PATTERN.test(value)) fail('IDENTITY');
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('REVISION');
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail('DUPLICATE');
}
function origin(value: unknown) {
  if (value === undefined) return;
  const item = object(value, ['format', 'digest', 'entryKey', 'sourceId', 'sourceRevision']);
  if (item.format !== NATIVE_TRANSFER_FORMAT || !/^[a-f0-9]{64}$/u.test(item.digest))
    fail('ORIGIN');
  identity(item.entryKey);
  identity(item.sourceId);
  revision(item.sourceRevision);
}

export type ValidatedNativeTransfer = {
  file: NativeTransferFile;
  /** Effective graph only. Authored source refs in file remain unchanged. */
  packages: Map<string, RisuContent>;
  persistOrder: string[];
  entries: NativeTransferPrepare['entries'];
  modelRequirements: NativeTransferPrepare['modelRequirements'];
  warnings: NativeTransferPrepare['warnings'];
};

/** Structural, metadata and graph validation only. No destination lookup, evaluation or writes. */
export function validateNativeTransfer(value: unknown): ValidatedNativeTransfer {
  const raw = object(value, [
    'format',
    'version',
    'roots',
    'contents',
    'prompts',
    'images',
    'sourceFiles',
  ]);
  if (raw.format !== NATIVE_TRANSFER_FORMAT || raw.version !== NATIVE_TRANSFER_VERSION)
    fail('FORMAT');
  const contents = list(raw.contents, 1000),
    prompts = list(raw.prompts, 1000);
  if (contents.length + prompts.length > 1000) fail('ENTRY_LIMIT');
  const roots = list(raw.roots, 1000);
  if (!roots.length) fail('ROOTS');
  const images = list(raw.images, 10_000);
  for (const entry of contents) {
    object(entry, ['key', 'source', 'modules', 'origin']);
    identity(entry.key);
    origin(entry.origin);
    const source = object(entry.source, [
      'id',
      'revision',
      'kind',
      'title',
      'description',
      'text',
      'loading',
      'relatedIds',
      'package',
    ]);
    identity(source.id);
    revision(source.revision);
    if (
      !['bot', 'persona', 'module'].includes(source.kind) ||
      !['pinned', 'discoverable'].includes(source.loading)
    )
      fail('CONTENT');
    text(source.title, 200);
    text(source.description, 4000, true);
    text(source.text, 1_000_000, true);
    const related = list(source.relatedIds, 100);
    related.forEach(identity);
    unique(related);
    const modules = list(entry.modules, 100);
    modules.forEach(identity);
    unique(modules);
    {
      const pkg = validateRisuContent(source.package);
      if (
        pkg.id !== source.id ||
        pkg.revision !== source.revision ||
        pkg.title !== source.title ||
        pkg.description !== source.description ||
        pkg.body !== source.text
      )
        fail('CONTENT_IDENTITY');
      if ((pkg.modules?.length ?? 0) !== modules.length) fail('MODULE_BINDINGS');
    }
  }
  const warnings: NativeTransferPrepare['warnings'] = [];
  let combinationCount = 0;
  for (const entry of prompts) {
    object(entry, ['key', 'source', 'combinations', 'origin']);
    identity(entry.key);
    origin(entry.origin);
    const source = object(entry.source, ['id', 'revision', 'title', 'role', 'program', 'values']);
    identity(source.id);
    revision(source.revision);
    text(source.title, 200);
    if (!['main', 'translation'].includes(source.role)) fail('PROMPT_ROLE');
    const program = validateEditableRisuPrompt(source.program);
    if (source.role !== 'main' && program.collaboration) fail('PROMPT_ROLE');
    resolveEditablePromptValues(program, source.values ?? {});
    for (const combination of list(entry.combinations, 1000)) {
      if (++combinationCount > 1000) fail('COMBINATION_LIMIT');
      object(combination, ['id', 'revision', 'title', 'role', 'values', 'owner', 'controls']);
      identity(combination.id);
      revision(combination.revision);
      text(combination.title, 200);
      const owner = object(combination.owner, ['kind', 'id']);
      if (owner.kind !== 'preset' || owner.id !== source.id || combination.role !== source.role)
        fail('COMBINATION_OWNER');
      resolveControlValues(validateControlDefinitions(combination.controls), combination.values);
      if (
        !matchesPromptCombination(
          combination,
          owner as { kind: 'preset'; id: string },
          source.role,
          program
        )
      )
        warnings.push({
          code: 'COMBINATION_INACTIVE',
          key: entry.key,
          message: `옵션 조합 “${combination.title}”은 이전 옵션 정의를 보존하며 현재 프롬프트에는 적용되지 않아요.`,
        });
    }
  }
  unique([...contents, ...prompts].map((entry) => entry.key));
  if (raw.sourceFiles !== undefined) {
    const entryKeys = new Set([...contents, ...prompts].map((entry) => entry.key));
    const attached = list(raw.sourceFiles, 1000);
    for (const item of attached) {
      object(item, ['entryKey', 'name', 'mediaType', 'hash', 'base64']);
      identity(item.entryKey);
      text(item.name, 255);
      text(item.mediaType, 200);
      if (
        !entryKeys.has(item.entryKey) ||
        /[/\\]/u.test(item.name) ||
        [...item.name].some((character) => character.charCodeAt(0) < 32) ||
        ['.', '..'].includes(item.name) ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(item.mediaType) ||
        typeof item.hash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(item.hash)
      )
        fail('SOURCE_FILE');
      text(item.base64, NATIVE_TRANSFER_MAX_BYTES, true);
    }
    unique(attached.map((item) => JSON.stringify([item.entryKey, item.name])));
  }
  unique(contents.map((entry) => entry.source.id));
  unique(prompts.map((entry) => entry.source.id));
  unique(prompts.flatMap((entry) => entry.combinations.map((item: any) => item.id)));
  const contentByKey = new Map(contents.map((entry) => [entry.key as string, entry]));
  const contentById = new Map(contents.map((entry) => [entry.source.id as string, entry]));
  const packages = new Map<string, RisuContent>();
  for (const entry of contents) {
    for (const [index, key] of entry.modules.entries()) {
      const dependency = contentByKey.get(key);
      if (
        !dependency?.source.package ||
        dependency.source.id !== entry.source.package.modules[index].id
      )
        fail('MODULE_BINDINGS');
    }
    packages.set(
      entry.key,
      validateRisuContent({
        ...entry.source.package,
        ...(entry.source.package.modules !== undefined
          ? {
              modules: entry.modules.map((key: string) => {
                const source = contentByKey.get(key)!.source;
                return { id: source.id, revision: source.revision };
              }),
            }
          : {}),
      })
    );
    if (entry.source.relatedIds.some((id: string) => !contentById.has(id)))
      warnings.push({
        code: 'EXTERNAL_RELATED_IDS',
        key: entry.key,
        message: '파일에 없는 관련 자료는 자동 연결하지 않아요.',
      });
  }
  const reached = new Set<string>(),
    persistOrder: string[] = [];
  const rootKeys = new Set<string>();
  for (const root of roots) {
    object(root, ['kind', 'key']);
    identity(root.key);
    if (rootKeys.has(root.key)) fail('DUPLICATE_ROOT');
    rootKeys.add(root.key);
    if (root.kind === 'prompt-preset') {
      if (!prompts.some((entry) => entry.key === root.key)) fail('ROOTS');
      reached.add(root.key);
    } else if (root.kind === 'content') {
      const entry = contentByKey.get(root.key);
      if (!entry) fail('ROOTS');
      const graph = resolvePackageGraph(
        {
          read: (ref) => {
            const item = contentById.get(ref.id);
            const pkg = item && packages.get(item.key);
            if (!pkg || pkg.revision !== ref.revision) fail('MODULE_BINDINGS');
            return pkg;
          },
        },
        [{ id: entry.source.id, revision: entry.source.revision, role: entry.source.kind }]
      );
      for (const ref of graph.persistOrder) {
        const key = contentById.get(ref.id)!.key;
        if (!reached.has(key)) persistOrder.push(key);
        reached.add(key);
      }
    } else fail('ROOTS');
  }
  if (reached.size !== contents.length + prompts.length) fail('UNUSED_ENTRIES');
  const expectedImages = new Map<string, string>();
  for (const pkg of packages.values())
    for (const image of pkg.images ?? []) {
      if (expectedImages.has(image.blobHash) && expectedImages.get(image.blobHash) !== image.mime)
        fail('IMAGE_REFERENCES');
      expectedImages.set(image.blobHash, image.mime);
    }
  for (const image of images) {
    object(image, ['id', 'revision', 'hash', 'mime', 'base64']);
    if (
      typeof image.hash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(image.hash) ||
      image.id !== image.hash ||
      image.revision !== 1 ||
      !PACKAGE_IMAGE_MIMES.includes(image.mime) ||
      (expectedImages.has(image.hash) && expectedImages.get(image.hash) !== image.mime)
    )
      fail('IMAGE_REFERENCES');
    text(image.base64, 90 * 1024 * 1024);
  }
  unique(images.map((image) => image.hash));
  const includedImages = new Set(images.map((image) => image.hash));
  if ([...expectedImages.keys()].some((hash) => !includedImages.has(hash)))
    fail('IMAGE_REFERENCES');
  const file = structuredClone(raw) as NativeTransferFile;
  const entries: NativeTransferPrepare['entries'] = [
    ...file.contents.map((entry) => ({
      key: entry.key,
      kind: 'content' as const,
      title: entry.source.title,
      category: entry.source.kind,
      root: rootKeys.has(entry.key),
    })),
    ...file.prompts.map((entry) => ({
      key: entry.key,
      kind: 'prompt-preset' as const,
      title: entry.source.title,
      category: entry.source.role,
      root: rootKeys.has(entry.key),
    })),
  ];
  const modelRequirements = file.prompts.flatMap((entry) =>
    (entry.source.program.collaboration?.agents ?? []).flatMap((agent) =>
      agent.model
        ? [
            {
              key: `${entry.key}/${agent.id}`,
              promptKey: entry.key,
              promptTitle: entry.source.title,
              agentId: agent.id,
              agentTitle: agent.title,
              sourceModelId: agent.model.id,
            },
          ]
        : []
    )
  );
  return { file, packages, persistOrder, entries, modelRequirements, warnings };
}
