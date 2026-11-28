import type { z } from 'zod/v4';

const revisionPattern = /(?:^|\.)(?:expected[A-Z]\w*|\w+Revision)$/u;
const targetPattern = /(?:^|\.)(?:id|\w+Id)$/u;
const nonTargetPattern = /(?:^|\.)clientId$/u;

type ZodDef = {
  type?: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  items?: z.ZodType[];
  options?: z.ZodType[];
  discriminator?: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
  valueType?: z.ZodType;
  values?: unknown[];
  entries?: Record<string, string | number>;
  getter?: () => z.ZodType;
};

type ZodInternals = {
  def?: ZodDef;
  innerType?: z.ZodType;
};

type ExpandedOption = {
  schema: z.ZodType;
  labelParts: string[];
  checks: ((value: unknown) => boolean)[];
};

export type SchemaBranch = {
  label: string;
  matches: (input: Record<string, unknown>) => boolean;
  revisions: string[];
  targets: string[];
};

export type SchemaAnalysis = {
  revisions: string[];
  targets: string[];
  branches: SchemaBranch[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const internalsOf = (schema: unknown): ZodInternals | undefined =>
  schema && typeof schema === 'object' ? (schema as { _zod?: ZodInternals })._zod : undefined;

const defOf = (schema: unknown): ZodDef | undefined => internalsOf(schema)?.def;

function unwrapTransparent(schema: z.ZodType, blocked: Set<unknown>): z.ZodType {
  let current: z.ZodType = schema;
  const seen = new Set<unknown>();
  while (!seen.has(current) && !blocked.has(current)) {
    seen.add(current);
    const internals = internalsOf(current);
    const def = internals?.def;
    if (!def) break;
    if (def.type === 'lazy') {
      const next = internals.innerType ?? def.getter?.();
      if (!next) break;
      current = next;
      continue;
    }
    if (def.type === 'pipe') {
      const input = def.in;
      const output = def.out;
      const inputType = defOf(input)?.type;
      if (input && inputType !== 'custom' && inputType !== 'transform') {
        current = input;
        continue;
      }
      if (output) {
        current = output;
        continue;
      }
      break;
    }
    if (def.innerType) {
      current = def.innerType;
      continue;
    }
    break;
  }
  return current;
}

function isObjectOrExpandableUnion(schema: z.ZodType, ancestors: Set<unknown>): boolean {
  const inner = unwrapTransparent(schema, ancestors);
  if (ancestors.has(inner)) return false;
  const def = defOf(inner);
  if (!def) return false;
  if (def.type === 'object') return true;
  if (def.type !== 'union') return false;
  if (typeof def.discriminator === 'string') return true;
  const options = def.options ?? [];
  if (options.length < 2) return false;
  ancestors.add(inner);
  try {
    return options.every((option) => isObjectOrExpandableUnion(option, ancestors));
  } finally {
    ancestors.delete(inner);
  }
}

function isExpandableUnion(schema: z.ZodType, ancestors: Set<unknown>): boolean {
  const inner = unwrapTransparent(schema, ancestors);
  if (ancestors.has(inner)) return false;
  const def = defOf(inner);
  if (!def || def.type !== 'union') return false;
  if (typeof def.discriminator === 'string') return true;
  const options = def.options ?? [];
  if (options.length < 2) return false;
  ancestors.add(inner);
  try {
    return options.every((option) => isObjectOrExpandableUnion(option, ancestors));
  } finally {
    ancestors.delete(inner);
  }
}

function literalValues(schema: z.ZodType | undefined): unknown[] {
  if (!schema) return [];
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const collect = (node: z.ZodType) => {
    const inner = unwrapTransparent(node, seen);
    if (seen.has(inner)) return;
    seen.add(inner);
    const def = defOf(inner);
    if (!def) return;
    if (def.type === 'literal') {
      for (const value of def.values ?? []) if (!found.includes(value)) found.push(value);
      return;
    }
    if (def.type === 'enum') {
      for (const value of Object.values(def.entries ?? {}))
        if (!found.includes(value)) found.push(value);
      return;
    }
    if (def.type === 'boolean') {
      for (const value of [true, false]) if (!found.includes(value)) found.push(value);
      return;
    }
    if (def.type === 'union') for (const option of def.options ?? []) collect(option);
  };
  collect(schema);
  return found;
}

function objectShape(schema: z.ZodType, ancestors: Set<unknown>): Record<string, z.ZodType> {
  const inner = unwrapTransparent(schema, ancestors);
  const def = defOf(inner);
  return def?.type === 'object' ? (def.shape ?? {}) : {};
}

function distinguishingKey(
  groups: ExpandedOption[][],
  ancestors: Set<unknown>
): string | undefined {
  const shapes = groups.map((group) =>
    group.map((option) => objectShape(option.schema, ancestors))
  );
  const first = shapes[0]?.[0];
  if (!first) return undefined;
  for (const key of Object.keys(first)) {
    if (!shapes.every((group) => group.every((shape) => Object.hasOwn(shape, key)))) continue;
    const groupSets = shapes.map((group) => {
      const values = new Set<unknown>();
      for (const shape of group) {
        const vals = literalValues(shape[key]);
        if (!vals.length) return null;
        for (const value of vals) values.add(value);
      }
      return values;
    });
    if (groupSets.some((set) => set === null)) continue;
    const sets = groupSets as Set<unknown>[];
    let disjoint = true;
    for (let left = 0; left < sets.length && disjoint; left++) {
      for (let right = left + 1; right < sets.length; right++) {
        for (const value of sets[left]!) {
          if (sets[right]!.has(value)) {
            disjoint = false;
            break;
          }
        }
      }
    }
    if (disjoint) return key;
  }
  return undefined;
}

function expandUnionOptions(unionSchema: z.ZodType, ancestors: Set<unknown>): ExpandedOption[] {
  const def = defOf(unionSchema);
  if (!def || def.type !== 'union') return [];
  const options = def.options ?? [];
  ancestors.add(unionSchema);
  try {
    if (typeof def.discriminator === 'string') {
      const discriminator = def.discriminator;
      const expanded: ExpandedOption[] = [];
      for (const option of options) {
        const inner = unwrapTransparent(option, ancestors);
        const subOptions = isExpandableUnion(inner, ancestors)
          ? expandUnionOptions(inner, ancestors)
          : [{ schema: option, labelParts: [], checks: [] }];
        for (const sub of subOptions) {
          if (sub.labelParts.some((part) => part.startsWith(`${discriminator}=`))) {
            expanded.push(sub);
            continue;
          }
          const shape = objectShape(sub.schema, ancestors);
          const values = literalValues(shape[discriminator]);
          if (values.length) {
            for (const value of values) {
              expanded.push({
                schema: sub.schema,
                labelParts: [`${discriminator}=${String(value)}`, ...sub.labelParts],
                checks: [
                  (candidate) => isRecord(candidate) && candidate[discriminator] === value,
                  ...sub.checks,
                ],
              });
            }
          } else {
            expanded.push({
              schema: sub.schema,
              labelParts: [`${discriminator}=?`, ...sub.labelParts],
              checks: sub.checks,
            });
          }
        }
      }
      return expanded;
    }

    const groups = options.map((option) => {
      const inner = unwrapTransparent(option, ancestors);
      return isExpandableUnion(inner, ancestors)
        ? expandUnionOptions(inner, ancestors)
        : [{ schema: option, labelParts: [], checks: [] }];
    });
    const key = distinguishingKey(groups, ancestors);
    if (key) {
      return groups.flatMap((group) =>
        group.map((option) => {
          const values = literalValues(objectShape(option.schema, ancestors)[key]);
          const part = `${key}=${values.map(String).join('|')}`;
          return {
            schema: option.schema,
            labelParts: [part, ...option.labelParts],
            checks: option.checks,
          };
        })
      );
    }
    const allKeySets = groups.map(
      (group) =>
        new Set(group.flatMap((option) => Object.keys(objectShape(option.schema, ancestors))))
    );
    return groups.flatMap((group, index) => {
      const otherKeys = new Set(
        allKeySets.flatMap((set, other) => (other === index ? [] : [...set]))
      );
      const unique = [...allKeySets[index]!].filter((name) => !otherKeys.has(name)).sort();
      const part = unique.length ? `keys=${unique.join('+')}` : `option=${index + 1}`;
      return group.map((option) => ({
        schema: option.schema,
        labelParts: [part, ...option.labelParts],
        checks: option.checks,
      }));
    });
  } finally {
    ancestors.delete(unionSchema);
  }
}

function collectFieldPaths(schema: z.ZodType, basePath = ''): string[] {
  const found = new Set<string>();
  const ancestors = new Set<unknown>();
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object' || ancestors.has(value)) return;
    const internals = internalsOf(value);
    const def = internals?.def;
    if (!def) return;
    ancestors.add(value);
    try {
      switch (def.type) {
        case 'object':
          for (const [key, child] of Object.entries(def.shape ?? {})) {
            const next = path ? `${path}.${key}` : key;
            found.add(next);
            visit(child, next);
          }
          break;
        case 'array':
          visit(def.element, path ? `${path}[]` : '[]');
          break;
        case 'tuple':
          for (const [index, item] of (def.items ?? []).entries()) visit(item, `${path}[${index}]`);
          break;
        case 'union':
          for (const option of def.options ?? []) visit(option, path);
          break;
        case 'intersection':
          visit(def.left, path);
          visit(def.right, path);
          break;
        case 'pipe':
          visit(def.in, path);
          visit(def.out, path);
          break;
        case 'record':
        case 'map':
          visit(def.valueType, path ? `${path}.*` : '*');
          break;
        case 'set':
          visit(def.valueType, path ? `${path}[]` : '[]');
          break;
        case 'lazy':
          visit(internals.innerType ?? def.getter?.(), path);
          break;
        default:
          if (def.innerType) visit(def.innerType, path);
          break;
      }
    } finally {
      ancestors.delete(value);
    }
  };
  visit(schema, basePath);
  return [...found].sort();
}

export function valuesAtPath(input: unknown, path: string): unknown[] {
  let current: unknown[] = [input];
  for (const segment of path.split('.')) {
    if (segment === '*') {
      const next: unknown[] = [];
      for (const item of current) if (isRecord(item)) next.push(...Object.values(item));
      current = next;
      continue;
    }
    const head = /^[^[]*/u.exec(segment)?.[0] ?? '';
    if (head) current = current.map((item) => (isRecord(item) ? item[head] : undefined));
    let rest = segment.slice(head.length);
    while (rest.length) {
      if (rest.startsWith('[]')) {
        const next: unknown[] = [];
        for (const item of current) if (Array.isArray(item)) next.push(...item);
        current = next;
        rest = rest.slice(2);
        continue;
      }
      const match = /^\[(\d+)\]/u.exec(rest);
      if (!match) break;
      const index = Number(match[1]);
      const next: unknown[] = [];
      for (const item of current) if (Array.isArray(item)) next.push(item[index]);
      current = next;
      rest = rest.slice(match[0].length);
    }
  }
  return current;
}

const isRevisionPath = (path: string) => revisionPattern.test(path);
const isTargetPath = (path: string) => targetPattern.test(path) && !nonTargetPattern.test(path);

export const revisionFields = (schema: z.ZodType): string[] =>
  collectFieldPaths(schema).filter(isRevisionPath);

export const targetPaths = (schema: z.ZodType): string[] =>
  collectFieldPaths(schema).filter(isTargetPath);

function collectBranches(rootSchema: z.ZodType): SchemaBranch[] {
  const branches: SchemaBranch[] = [];
  const ancestors = new Set<unknown>();

  const walk = (
    current: unknown,
    path: string,
    outerLabels: string[],
    outerMatch: (root: Record<string, unknown>) => boolean
  ) => {
    if (!current || typeof current !== 'object' || ancestors.has(current)) return;
    const unwrapped = unwrapTransparent(current as z.ZodType, ancestors);
    if (ancestors.has(unwrapped)) return;
    const def = defOf(unwrapped);
    if (!def) return;

    if (isExpandableUnion(unwrapped, ancestors)) {
      const expanded = expandUnionOptions(unwrapped, ancestors);
      ancestors.add(current);
      if (unwrapped !== current) ancestors.add(unwrapped);
      try {
        for (const option of expanded) {
          const prefixedParts = option.labelParts.map((part) => (path ? `${path}.${part}` : part));
          const label = [...outerLabels, ...prefixedParts].join(', ');
          const matchesAtPath = (root: Record<string, unknown>) => {
            if (!outerMatch(root)) return false;
            const candidates = path ? valuesAtPath(root, path) : [root];
            return candidates.some(
              (candidate) =>
                option.schema.safeParse(candidate).success &&
                option.checks.every((check) => check(candidate))
            );
          };
          const fields = collectFieldPaths(option.schema, path);
          branches.push({
            label,
            matches: matchesAtPath,
            revisions: fields.filter(isRevisionPath),
            targets: fields.filter(isTargetPath),
          });
          const leafShape = objectShape(option.schema, ancestors);
          for (const [key, child] of Object.entries(leafShape))
            walk(
              child,
              path ? `${path}.${key}` : key,
              [...outerLabels, ...prefixedParts],
              matchesAtPath
            );
        }
      } finally {
        ancestors.delete(current);
        if (unwrapped !== current) ancestors.delete(unwrapped);
      }
      return;
    }

    ancestors.add(current);
    if (unwrapped !== current) ancestors.add(unwrapped);
    try {
      switch (def.type) {
        case 'object':
          for (const [key, child] of Object.entries(def.shape ?? {}))
            walk(child, path ? `${path}.${key}` : key, outerLabels, outerMatch);
          break;
        case 'array':
          walk(def.element, path ? `${path}[]` : '[]', outerLabels, outerMatch);
          break;
        case 'tuple':
          for (const [index, item] of (def.items ?? []).entries())
            walk(item, `${path}[${index}]`, outerLabels, outerMatch);
          break;
        case 'intersection':
          walk(def.left, path, outerLabels, outerMatch);
          walk(def.right, path, outerLabels, outerMatch);
          break;
        case 'record':
        case 'map':
          walk(def.valueType, path ? `${path}.*` : '*', outerLabels, outerMatch);
          break;
        case 'set':
          walk(def.valueType, path ? `${path}[]` : '[]', outerLabels, outerMatch);
          break;
        default:
          break;
      }
    } finally {
      ancestors.delete(current);
      if (unwrapped !== current) ancestors.delete(unwrapped);
    }
  };

  walk(rootSchema, '', [], () => true);
  return branches;
}

export function analyzeSchema(schema: z.ZodType): SchemaAnalysis {
  const fields = collectFieldPaths(schema);
  return {
    revisions: fields.filter(isRevisionPath),
    targets: fields.filter(isTargetPath),
    branches: collectBranches(schema),
  };
}
