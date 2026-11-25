import { luaCodeMask } from './lua-code-mask.js';
import { analyzeCbs, type CbsRange, type CbsReference } from './cbs-analysis.js';
import { nativeRisuSources, type RisuContentSource } from './risu-native.js';

export type CbsVariableScope = CbsReference['scope'];
export type CbsVariableAccess = CbsReference['access'] | 'default' | 'define';
export type CbsUseOrigin = 'cbs' | 'lua' | 'trigger' | 'default' | 'toggle';
export type CbsUseLocation = {
  section: string;
  item: number | null;
  label: string;
  field: string;
  path: string;
};
export type CbsVariableUse = CbsUseLocation & {
  access: CbsVariableAccess;
  origin: CbsUseOrigin;
  range: CbsRange;
};
export type CbsDirectUse = CbsVariableUse & {
  scope: CbsVariableScope;
  name: string;
  dynamic: boolean;
};
export type CbsReferenceInput = {
  cbs: (CbsUseLocation & { text: string })[];
  lua: (CbsUseLocation & { text: string })[];
  direct: CbsDirectUse[];
};
export type CbsVariableReferences = {
  scope: CbsVariableScope;
  name: string;
  toggle: string | null;
  uses: CbsVariableUse[];
  reads: number;
  writes: number;
  defined: boolean;
};
export type CbsReferenceFindingCode =
  | 'read-without-default'
  | 'never-read'
  | 'toggle-unused'
  | 'toggle-undefined';
export type CbsReferenceFinding = {
  code: CbsReferenceFindingCode;
  scope: CbsVariableScope;
  name: string;
  certain: boolean;
};
export type CbsDynamicCounts = Record<CbsVariableScope, { reads: number; writes: number }>;
export type CbsReferenceIndex = {
  variables: CbsVariableReferences[];
  findings: CbsReferenceFinding[];
  dynamic: CbsDynamicCounts;
};

type FoundReference = {
  scope: CbsVariableScope;
  name: string;
  access: CbsReference['access'];
  dynamic: boolean;
  range: CbsRange;
};

const TOGGLE_PREFIX = 'toggle_';
const luaFunctions: Record<string, [CbsVariableScope, CbsReference['access'], string]> = {
  getChatVar: ['chat', 'read', ''],
  setChatVar: ['chat', 'write', ''],
  setChatVarChanged: ['chat', 'write', ''],
  getState: ['chat', 'read', '__'],
  setState: ['chat', 'write', '__'],
  setStateChanged: ['chat', 'write', '__'],
  getGlobalVar: ['global', 'read', ''],
};
const luaCall = new RegExp(`\\b(${Object.keys(luaFunctions).join('|')})\\s*\\(`, 'g');
const luaLiteralArgument = /^\s*[A-Za-z_][\w.]*\s*,\s*(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1\s*[,)]/;

function cbsReferences(text: string): FoundReference[] {
  if (!text.includes('{{')) return [];
  return analyzeCbs(text).references.map((reference) => ({
    scope: reference.scope,
    name: reference.name,
    access: reference.access,
    dynamic: reference.dynamic,
    range: { from: reference.from, to: reference.to },
  }));
}

function luaReferences(text: string): FoundReference[] {
  const found = cbsReferences(text);
  for (const match of luaCodeMask(text).matchAll(luaCall)) {
    const [scope, access, prefix] = luaFunctions[match[1]!]!;
    const start = match.index + match[0].length;
    const literal = luaLiteralArgument.exec(text.slice(start, start + 4096));
    if (!literal) {
      found.push({
        scope,
        access,
        name: '',
        dynamic: true,
        range: { from: match.index, to: start },
      });
      continue;
    }
    const from = start + literal[0].indexOf(literal[1]!) + 1;
    found.push({
      scope,
      access,
      name: prefix + literal[2]!,
      dynamic: false,
      range: { from, to: from + literal[2]!.length },
    });
  }
  return found;
}

export function createCbsReferenceIndexer() {
  let cache = new Map<string, FoundReference[]>();
  return (input: CbsReferenceInput): CbsReferenceIndex => {
    const next = new Map<string, FoundReference[]>();
    const read = (key: string, text: string, scan: (text: string) => FoundReference[]) => {
      let found = next.get(key) ?? cache.get(key);
      if (!found) found = scan(text);
      next.set(key, found);
      return found;
    };
    const variables = new Map<string, CbsVariableReferences>();
    const dynamic: CbsDynamicCounts = {
      chat: { reads: 0, writes: 0 },
      temp: { reads: 0, writes: 0 },
      global: { reads: 0, writes: 0 },
    };
    const add = (use: CbsDirectUse) => {
      if (use.dynamic) {
        if (use.access === 'read') dynamic[use.scope].reads++;
        else if (use.access === 'write' || use.access === 'update') dynamic[use.scope].writes++;
        return;
      }
      if (!use.name) return;
      const id = `${use.scope}:${use.name}`;
      let entry = variables.get(id);
      if (!entry) {
        entry = {
          scope: use.scope,
          name: use.name,
          toggle:
            use.scope === 'global' && use.name.startsWith(TOGGLE_PREFIX)
              ? use.name.slice(TOGGLE_PREFIX.length)
              : null,
          uses: [],
          reads: 0,
          writes: 0,
          defined: false,
        };
        variables.set(id, entry);
      }
      const { scope: _scope, name: _name, dynamic: _dynamic, ...rest } = use;
      entry.uses.push(rest);
      if (use.access === 'read') entry.reads++;
      else if (use.access === 'write' || use.access === 'update') entry.writes++;
      else entry.defined = true;
    };
    const scanTexts = (
      texts: CbsReferenceInput['cbs'],
      origin: 'cbs' | 'lua',
      scan: (text: string) => FoundReference[]
    ) => {
      for (const { text, ...location } of texts)
        for (const reference of read(`${origin}:${text}`, text, scan))
          add({ ...location, ...reference, origin });
    };
    scanTexts(input.cbs, 'cbs', cbsReferences);
    scanTexts(input.lua, 'lua', luaReferences);
    for (const use of input.direct) add(use);
    cache = next;
    const sorted = [...variables.values()].sort(
      (a, b) =>
        Number(a.toggle !== null) - Number(b.toggle !== null) ||
        a.scope.localeCompare(b.scope) ||
        a.name.localeCompare(b.name)
    );
    const findings: CbsReferenceFinding[] = [];
    for (const entry of sorted) {
      const finding = (code: CbsReferenceFindingCode, certain: boolean) =>
        findings.push({ code, scope: entry.scope, name: entry.name, certain });
      if (entry.scope === 'chat') {
        if (entry.reads && !entry.writes && !entry.defined)
          finding('read-without-default', !dynamic.chat.writes);
        if (!entry.reads && (entry.writes || entry.defined))
          finding('never-read', !dynamic.chat.reads);
      } else if (entry.toggle !== null) {
        if (entry.defined && !entry.reads) finding('toggle-unused', !dynamic.global.reads);
        if (!entry.defined && entry.reads) finding('toggle-undefined', true);
      }
    }
    return { variables: sorted, findings, dynamic };
  };
}

export function indexCbsReferences(input: CbsReferenceInput): CbsReferenceIndex {
  return createCbsReferenceIndexer()(input);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown) => (Array.isArray(value) ? value : []);

function lines(source: string) {
  const result: { text: string; range: CbsRange }[] = [];
  let from = 0;
  for (const text of source.split('\n')) {
    result.push({ text: text.replace(/\r$/u, ''), range: { from, to: from + text.length } });
    from += text.length + 1;
  }
  return result;
}

function defaultUses(source: string, location: CbsUseLocation): CbsDirectUse[] {
  const seen = new Set<string>();
  return lines(source).flatMap(({ text, range }) => {
    const [key, value] = text.split('=');
    if (!key || !value || seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...location,
        scope: 'chat' as const,
        name: key,
        dynamic: false,
        access: 'default' as const,
        origin: 'default' as const,
        range: { from: range.from, to: range.from + key.length },
      },
    ];
  });
}

const toggleMarkers = new Set(['group', 'groupEnd', 'caption', 'divider']);
function toggleUses(source: string, location: CbsUseLocation): CbsDirectUse[] {
  return lines(source).flatMap(({ text, range }) => {
    const [key, label, type] = text.split('=');
    if (!key || !label || toggleMarkers.has(type ?? '')) return [];
    return [
      {
        ...location,
        scope: 'global' as const,
        name: TOGGLE_PREFIX + key,
        dynamic: false,
        access: 'define' as const,
        origin: 'toggle' as const,
        range: { from: range.from, to: range.from + key.length },
      },
    ];
  });
}

export function regexPatternUsesCbs(entry: unknown) {
  const script = object(entry);
  if (script.ableFlag !== true) return false;
  return [...string(script.flag).matchAll(/<([^>]+)>/gu)].some((match) =>
    match[1]!.split(',').some((meta) => meta.trim() === 'cbs')
  );
}

function regexTexts(entries: unknown[], section: string, base: string): CbsReferenceInput['cbs'] {
  return entries.flatMap((raw, item) => {
    const entry = object(raw);
    const label = string(entry.comment);
    const key = (primary: string, legacy: string) =>
      entry[primary] == null && entry[legacy] != null ? legacy : primary;
    return [
      ...(regexPatternUsesCbs(entry)
        ? [
            {
              section,
              item,
              label,
              field: 'in',
              path: `${base}/${item}/${key('in', 'find')}`,
              text: string(entry.in ?? entry.find),
            },
          ]
        : []),
      {
        section,
        item,
        label,
        field: 'out',
        path: `${base}/${item}/${key('out', 'replace')}`,
        text: string(entry.out ?? entry.replace),
      },
    ];
  });
}

function triggerInput(entries: unknown[], section: string, base: string) {
  const input: CbsReferenceInput = { cbs: [], lua: [], direct: [] };
  entries.forEach((raw, item) => {
    const trigger = object(raw);
    const label = string(trigger.comment);
    const at = (field: string, key: string): CbsUseLocation => ({
      section,
      item,
      label,
      field,
      path: `${base}/${item}/${field.replace('.', '/')}/${key}`,
    });
    const variable = (value: unknown, access: 'read' | 'write', field: string, key = 'var') => {
      const name = string(value);
      if (!name) return;
      input.direct.push({
        ...at(field, key),
        scope: 'chat',
        name,
        dynamic: name.includes('{{'),
        access,
        origin: 'trigger',
        range: { from: 0, to: 0 },
      });
    };
    list(trigger.conditions).forEach((rawCondition, index) => {
      const condition = object(rawCondition);
      if (condition.type === 'var') variable(condition.var, 'read', `conditions.${index}`);
    });
    list(trigger.effect).forEach((rawEffect, index) => {
      const effect = object(rawEffect);
      if (effect.type === 'triggerlua')
        input.lua.push({ ...at(`effect.${index}`, 'code'), text: string(effect.code) });
      else {
        if (effect.type === 'v2If' || effect.type === 'v2IfAdvanced') {
          for (const key of ['source', 'target'] as const) {
            const value = effect[key];
            if (typeof value !== 'string') continue;
            input.cbs.push({ ...at(`effect.${index}`, key), text: value });
            if ((effect.type === 'v2If' && key === 'source') || effect[`${key}Type`] === 'var')
              variable(value, 'read', `effect.${index}`, key);
          }
        }
        if (effect.type === 'setvar' || effect.type === 'v2SetVar')
          variable(effect.var, 'write', `effect.${index}`);
        if (typeof effect.value === 'string')
          input.cbs.push({ ...at(`effect.${index}`, 'value'), text: effect.value });
      }
    });
  });
  return input;
}

function merge(...parts: CbsReferenceInput[]): CbsReferenceInput {
  return {
    cbs: parts.flatMap((part) => part.cbs),
    lua: parts.flatMap((part) => part.lua),
    direct: parts.flatMap((part) => part.direct),
  };
}

export function nativeRisuContentReferenceInput(native: RisuContentSource): CbsReferenceInput {
  const module = native.module;
  const sources = nativeRisuSources(native);
  const standalone = sources.standalone;
  const card = native.card;
  const text = (
    section: string,
    field: string,
    value: unknown,
    path: string,
    item: number | null = null
  ) => ({
    section,
    item,
    label: '',
    field,
    path,
    text: string(value),
  });
  const cbs: CbsReferenceInput['cbs'] = [
    text(
      'basic',
      'description',
      standalone ? module?.description : card.description,
      `${sources.root}/description`
    ),
  ];
  if (!standalone) {
    cbs.push(text('greetings', 'first_mes', card.first_mes, '/card/first_mes', 0));
    cbs.push(
      ...list(card.alternate_greetings).map((greeting, index) =>
        text(
          'greetings',
          'alternate_greetings',
          greeting,
          `/card/alternate_greetings/${index}`,
          index + 1
        )
      ),
      text(
        'instructions',
        'post_history_instructions',
        card.post_history_instructions,
        '/card/post_history_instructions'
      ),
      text('instructions', 'mes_example', card.mes_example, '/card/mes_example')
    );
  }
  const lore = list(sources.lore.entries).flatMap((entry, index) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? [{ entry: entry as Record<string, unknown>, index }]
      : []
  );
  cbs.push(
    ...lore.map(({ entry, index }, item) => ({
      section: 'lore',
      item,
      label: string(entry.comment ?? entry.name),
      field: 'content',
      path: `${sources.lore.path}/${index}/content`,
      text: string(entry.content),
    }))
  );
  for (const background of sources.backgrounds)
    cbs.push(text('display', background.field, background.text, background.path));
  const variables = ({ field, path }: { field: string; path: string }): CbsUseLocation => ({
    section: 'variables',
    item: null,
    label: '',
    field,
    path,
  });
  return merge(
    {
      cbs: [...cbs, ...regexTexts(list(sources.regex.entries), 'regex', sources.regex.path)].filter(
        (entry) => entry.text
      ),
      lua: [],
      direct: [
        ...defaultUses(sources.defaultVariables.text, variables(sources.defaultVariables)),
        ...toggleUses(sources.toggles.text, variables(sources.toggles)),
      ],
    },
    triggerInput(list(sources.triggers.entries), 'triggers', sources.triggers.path)
  );
}

export function nativeRisuPresetReferenceInput(preset: Record<string, unknown>): CbsReferenceInput {
  const cbs: CbsReferenceInput['cbs'] = [];
  list(preset.promptTemplate).forEach((raw, item) => {
    const block = object(raw);
    for (const field of ['text', 'innerFormat', 'defaultText'])
      if (string(block[field]))
        cbs.push({
          section: 'blocks',
          item,
          label: string(block.name),
          field,
          path: `/promptTemplate/${item}/${field}`,
          text: string(block[field]),
        });
  });
  cbs.push(
    ...regexTexts(
      list(preset.regex ?? preset.presetRegex),
      'regex',
      preset.regex == null && preset.presetRegex != null ? '/presetRegex' : '/regex'
    ).filter((entry) => entry.text)
  );
  const variables = (field: string): CbsUseLocation => ({
    section: 'variables',
    item: null,
    label: '',
    field,
    path: `/${field}`,
  });
  return {
    cbs,
    lua: [],
    direct: [
      ...defaultUses(
        string(preset.templateDefaultVariables),
        variables('templateDefaultVariables')
      ),
      ...toggleUses(
        string(preset.customPromptTemplateToggle),
        variables('customPromptTemplateToggle')
      ),
    ],
  };
}

export function cbsVariableNames(index: CbsReferenceIndex): Record<CbsVariableScope, string[]> {
  const names: Record<CbsVariableScope, string[]> = { chat: [], temp: [], global: [] };
  for (const entry of index.variables) names[entry.scope].push(entry.name);
  return names;
}
