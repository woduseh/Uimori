import { indexCbsReferences } from '../core/cbs-references.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { Content, PromptPreset } from '../core/product.js';
import {
  nativeRisuRegexEntries,
  nativeRisuSources,
  type RisuContentSource,
} from '../core/risu-native.js';
import { declaredToggleVariables } from '../core/risu-effective-controls.js';
import { countTextTokens } from '../core/text-tokens.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import { readResource } from './resource-service.js';
import {
  analyzeCbsText,
  cbsTextFindings,
  CODE_DIAGNOSIS_SECTIONS,
  codeDiagnosisReferenceInput,
  diagnoseRisuCode,
  PRESET_DIAGNOSIS_SECTIONS,
  textPosition,
  type CodeDiagnosisSection,
  type CodeDiagnosisTarget,
  type CodeFinding,
} from './risu-code-diagnosis.js';
import { NATIVE_RISU_REGEX_MODES, processNativeRisuText } from './risu-native-render.js';
import { nativeRisuDraftPreview, nativeRisuStartPreview } from './risu-native-preview.js';
import type { Store } from './store.js';

const MAX_RESULT_TOKENS = 12_000;
const MAX_CBS_TEXT = 200_000;
const MAX_TRACE_TEXT = 20_000;
const LIST_CAP = 100;
const USES_CAP = 20;
const EXCERPT_CHARS = 160;
const STEP_CONTEXT = 120;
const PAGE_CHARS = 8000;

const resourceKind: Json = {
  type: 'string',
  enum: ['content', 'prompt-preset'],
  description: 'content is a saved bot, persona or module; prompt-preset a prompt preset.',
};
const resourceId: Json = {
  type: 'string',
  description:
    'Id of the saved resource. In a chat, the bot is the role=bot item in writing.packages.',
};
const offset: Json = {
  type: 'integer',
  minimum: 0,
  description: 'Entry offset. Pass the previous nextOffset.',
};
const stringMap = (description: string): Json => ({
  type: 'object',
  additionalProperties: { type: 'string' },
  description,
});

export const HELPER_CODE_TOOLS: ProviderTool[] = [
  {
    name: 'code.cbs',
    description:
      "Check one piece of Risu CBS (the {{...}} template syntax) without running it: a text you pass, or one string field of a saved bot, persona, module or prompt preset given by its resource.read path. Use it while writing or fixing CBS to find unclosed {{ or blocks, stray {{/...}}, {{:else}} outside {{#when}}, unknown and deprecated function names, and to see the block structure and the variables and toggles the text reads and writes. Every result has a 1-based line and column in that text. Names come from Uimori's real CBS function list; read guide.read name=CBS-REFERENCE for what each function does. Nothing is evaluated, so a clean result does not prove that conditions or dynamic names behave as intended; use code.preview or code.regex for real output. For every CBS field of a resource at once use code.diagnose.",
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `CBS text to check, at most ${MAX_CBS_TEXT} UTF-16 code units. Do not combine with kind, id and path.`,
        },
        kind: resourceKind,
        id: resourceId,
        path: {
          type: 'string',
          description:
            'JSON Pointer of a string field of the saved resource, as resource.read and resource.patch use it, for example /package/nativeRisu/card/first_mes or /program/nativeRisuPreset/preset/promptTemplate/0/text.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'code.references',
    description:
      "List where a saved bot, persona, module or prompt preset reads and writes its Risu variables and toggles: CBS getvar/setvar and their relatives, {{? $name}} math, #when conditions, Lua getChatVar/setChatVar/getState/setState/getGlobalVar calls, structured trigger variables, default variables and toggle declarations. Use it before renaming or removing a variable or toggle, or to explain where a value comes from. Each use has the resource.patch path of its field with line and column. findings point out a variable read without a default or write, a variable written but never read, a declared toggle that is never read and a toggle read but never declared; certain:false means names built at runtime could explain it. Only this one resource is indexed: a bot's attached modules, the prompt preset and chat state can still provide a value. Page variables with offset and limit.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: resourceKind,
        id: resourceId,
        name: {
          type: 'string',
          description:
            'Only variables whose name or toggle key contains this text, ignoring case. Findings are filtered the same way.',
        },
        scope: {
          type: 'string',
          enum: ['chat', 'temp', 'global'],
          description:
            'Only this variable scope: chat for chat variables, temp for temporary ones, global for global variables and toggles (toggle_<key>).',
        },
        offset,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: `Maximum variables per page, 20 by default. Each variable lists at most ${USES_CAP} uses.`,
        },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'code.diagnose',
    description: `Check everything about a saved bot, persona, module or prompt preset that can be checked without running it, before or after editing its code. Sections: cbs (syntax, unknown and deprecated functions in every CBS field), assets (asset tags such as {{img::name}} that match no stored image), regex (scripts that are malformed or whose pattern does not compile), triggers (structure Uimori refuses to run), lore (empty or repeated key fragments and keyless entries, relevant when the resource is also used in Risu), lua (Lua syntax errors, compiled without running), and compatibility (things Uimori ignores or does not support: lore directives, Lua functions, trigger conditions and effects, regex types and commands, preset blocks and deprecated fields). A preset has only cbs, regex and compatibility; its toggle declarations are checked by preset.validate. Each finding has a section, code, severity, the resource.patch path of the field, line and column where known, and a message. Page with offset and limit. A clean report does not prove that the code does what it should; check behaviour with code.preview and code.regex.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: resourceKind,
        id: resourceId,
        sections: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: [...CODE_DIAGNOSIS_SECTIONS] },
          description: 'Sections to check. Omit for every section that applies to the resource.',
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
          description:
            'Lowest severity to return, info by default. Counts always cover every severity.',
        },
        offset,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum findings per page, 50 by default.',
        },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'code.regex',
    description:
      "Run the regex scripts of a saved bot, persona, module or prompt preset on a sample text, exactly as Uimori applies them at one stage, and show what each script changed. Stages are Risu's script types: editinput (the user's message before it is saved), editoutput (the model's reply before it is saved), editprocess (each message of the request sent to the model) and editdisplay (what the reader sees). The text first goes through CBS, then each script of that stage runs in Risu order (higher <order N> first, then list order), with CBS in the pattern (cbs flag) and in the replacement evaluated as at runtime. A bot's attached modules and the prompt preset are not included, and display asset tags are not resolved. Only scripts that changed the text are listed, each with an excerpt before and after the change; issues name scripts that failed or used an unsupported command. Variables written by CBS are returned but never saved. Page the steps with offset.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: resourceKind,
        id: resourceId,
        stage: {
          type: 'string',
          enum: [...NATIVE_RISU_REGEX_MODES],
          description: 'Risu regex script type to run.',
        },
        text: {
          type: 'string',
          description: `Sample text, at most ${MAX_TRACE_TEXT} UTF-16 code units.`,
        },
        variables: stringMap(
          'Chat variable values to start from, by name. Defaults of the resource still apply to names not given.'
        ),
        toggles: stringMap(
          'Toggle values by toggle key, without the toggle_ prefix, such as {"mode":"1"}. Toggles not given use their declared defaults.'
        ),
        userName: { type: 'string', description: 'Name for {{user}}, User by default.' },
        offset,
      },
      required: ['kind', 'id', 'stage', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'code.preview',
    description:
      "Render one first message of a saved bot the way the new-chat preview does: Lua editDisplay, CBS, display regex scripts and asset tags, through Uimori's real evaluator, without saving anything or calling a model. Pass text to render a replacement first message against the saved bot without saving it, for example to try a fix before resource.patch. toggles sets toggle values for this render, so calling it again with other values compares toggle combinations. Attached modules and chat variables are not included. Returns the rendered HTML as the renderer produces it (the reader still sanitises it), in pages, and the issues the evaluator reported, such as unsupported CBS functions or failed regex scripts. When the evaluation fails, failure holds the error instead, for example a Lua error or a trigger Uimori refuses to run; code.diagnose usually locates the cause.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the saved bot.' },
        greeting: {
          type: 'integer',
          minimum: 0,
          description:
            'Which first message: 0 (default) is first_mes, n is alternate_greetings item n-1.',
        },
        text: {
          type: 'string',
          description:
            'Replacement first message to render instead of the saved one. Not saved. Do not combine with greeting.',
        },
        toggles: stringMap(
          'Toggle values by toggle key, without the toggle_ prefix, such as {"mode":"1"}. Toggles not given use their declared defaults.'
        ),
        userName: { type: 'string', description: 'Name for {{user}}, 사용자 by default.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Start position in the HTML, in UTF-16 code units. Pass the previous nextOffset.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20000,
          description: `HTML to return, in UTF-16 code units, ${PAGE_CHARS} by default.`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
const names = new Set(HELPER_CODE_TOOLS.map((tool) => tool.name));
export const isHelperCodeTool = (name: string) => names.has(name);

type Loaded = {
  kind: 'content' | 'prompt-preset';
  id: string;
  revision: number;
  title: string;
  root: string;
  document: Record<string, unknown>;
  target: CodeDiagnosisTarget;
};

function loadTarget(store: Store, args: Record<string, unknown>): Loaded {
  const id = text(args.id, 'resource ID', 100);
  if (args.kind === 'content') {
    const content = readResource(store, 'content', id) as Content;
    const native = (content.package as { nativeRisu?: RisuContentSource } | undefined)?.nativeRisu;
    if (!native) throw new HttpError(400, 'NATIVE_RISU_REQUIRED: this content has no Risu source');
    return {
      kind: 'content',
      id,
      revision: content.revision,
      title: content.title,
      root: '/package/nativeRisu',
      document: native as unknown as Record<string, unknown>,
      target: { kind: 'content', native },
    };
  }
  if (args.kind === 'prompt-preset') {
    const saved = readResource(store, 'prompt-preset', id) as PromptPreset;
    const preset = saved.program.nativeRisuPreset?.preset;
    if (!preset) throw new HttpError(400, 'NATIVE_RISU_PRESET_REQUIRED');
    return {
      kind: 'prompt-preset',
      id,
      revision: saved.revision,
      title: saved.title,
      root: '/program/nativeRisuPreset/preset',
      document: preset,
      target: { kind: 'prompt-preset', preset },
    };
  }
  throw new HttpError(400, 'INVALID_ARGUMENTS: kind must be content or prompt-preset');
}

function pointer(root: unknown, path: string): unknown {
  if (path === '') return root;
  if (!path.startsWith('/')) return undefined;
  let value = root;
  for (const raw of path.slice(1).split('/')) {
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value) && /^(0|[1-9]\d*)$/u.test(part)) value = value[Number(part)];
    else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, part)
    )
      value = (value as Record<string, unknown>)[part];
    else return undefined;
  }
  return value;
}

function excerpt(source: string, line: number) {
  const value = source.split('\n')[line - 1] ?? '';
  return value.length > EXCERPT_CHARS ? `${value.slice(0, EXCERPT_CHARS - 1)}…` : value;
}

function bounded<T>(build: () => T, shrink: () => boolean): T {
  let result = build();
  while (countTextTokens(JSON.stringify(result)) > MAX_RESULT_TOKENS) {
    if (!shrink()) throw new HttpError(413, 'HELPER_READ_TOO_LARGE: narrow the request');
    result = build();
  }
  return result;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const input = record(value);
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== 'string' || key.length > 200 || item.length > 10_000)
      throw new HttpError(400, `INVALID_ARGUMENTS: ${name} must map names to strings`);
    result[key] = item;
  }
  return result;
}

function checkCbs(store: Store, args: Record<string, unknown>) {
  fields(args, ['text', 'kind', 'id', 'path']);
  let source: Record<string, unknown>;
  let value: string;
  if (args.text !== undefined) {
    if (args.kind !== undefined || args.id !== undefined || args.path !== undefined)
      throw new HttpError(400, 'INVALID_ARGUMENTS: pass text or kind, id and path, not both');
    value = text(args.text, 'CBS text', MAX_CBS_TEXT, true);
    source = { text: true };
  } else {
    const loaded = loadTarget(store, args);
    const path = text(args.path, 'path', 1024);
    if (!path.startsWith(`${loaded.root}/`))
      throw new HttpError(400, `INVALID_ARGUMENTS: path must start with ${loaded.root}/`);
    const field = pointer(loaded.document, path.slice(loaded.root.length));
    if (typeof field !== 'string')
      throw new HttpError(400, 'CODE_FIELD_NOT_TEXT: path must point at an existing string field');
    if (field.length > MAX_CBS_TEXT) throw new HttpError(413, 'CODE_FIELD_TOO_LARGE');
    value = field;
    source = { kind: loaded.kind, id: loaded.id, revision: loaded.revision, path };
  }
  const analysis = analyzeCbsText(value);
  const findings = cbsTextFindings(value, '', analysis);
  const depth = (block: (typeof analysis.blocks)[number]) => {
    let level = 0;
    for (let parent = block.parent; parent !== null; parent = analysis.blocks[parent]!.parent)
      level++;
    return level;
  };
  const blocks = analysis.blocks.map((block) => {
    const opener = analysis.calls[block.opener]!;
    const closer = block.closer === null ? null : analysis.calls[block.closer]!;
    return {
      keyword: block.keyword,
      ...textPosition(value, opener.from),
      depth: depth(block),
      closed: closer !== null,
      ...(closer ? { closeLine: textPosition(value, closer.from).line } : {}),
      ...(block.elses.length ? { elses: block.elses.length } : {}),
    };
  });
  const variables = new Map<
    string,
    { scope: string; name: string; reads: number; writes: number; line: number }
  >();
  let dynamic = 0;
  for (const reference of analysis.references) {
    if (reference.dynamic) {
      dynamic++;
      continue;
    }
    const key = `${reference.scope}:${reference.name}`;
    const entry = variables.get(key) ?? {
      scope: reference.scope,
      name: reference.name,
      reads: 0,
      writes: 0,
      line: textPosition(value, reference.from).line,
    };
    if (reference.access === 'read') entry.reads++;
    else entry.writes++;
    variables.set(key, entry);
  }
  let cap = LIST_CAP;
  return bounded(
    () => ({
      source,
      length: value.length,
      lines: value.split('\n').length,
      calls: analysis.calls.length,
      totalDiagnostics: findings.length,
      diagnostics: findings.slice(0, cap).map(({ section: _s, path: _p, ...finding }) => ({
        ...finding,
        excerpt: excerpt(value, finding.line ?? 1),
      })),
      totalBlocks: blocks.length,
      blocks: blocks.slice(0, cap),
      totalVariables: variables.size,
      variables: [...variables.values()].slice(0, cap).map((entry) => ({
        ...entry,
        ...(entry.scope === 'global' && entry.name.startsWith('toggle_')
          ? { toggle: entry.name.slice('toggle_'.length) }
          : {}),
      })),
      dynamicReferences: dynamic,
    }),
    () => (cap > 5 ? ((cap = Math.floor(cap / 2)), true) : false)
  );
}

function references(store: Store, args: Record<string, unknown>) {
  fields(args, ['kind', 'id', 'name', 'scope', 'offset', 'limit']);
  const loaded = loadTarget(store, args);
  const filter = args.name === undefined ? '' : text(args.name, 'name', 200).toLocaleLowerCase();
  if (args.scope !== undefined && !['chat', 'temp', 'global'].includes(String(args.scope)))
    throw new HttpError(400, 'INVALID_ARGUMENTS: scope must be chat, temp or global');
  const index = indexCbsReferences(codeDiagnosisReferenceInput(loaded.target));
  const matches = (scope: string, name: string) =>
    (args.scope === undefined || args.scope === scope) &&
    (!filter || name.toLocaleLowerCase().includes(filter));
  const selected = index.variables.filter((entry) => matches(entry.scope, entry.name));
  const start = args.offset === undefined ? 0 : number(args.offset, 'offset', 0, selected.length);
  let limit = args.limit === undefined ? 20 : number(args.limit, 'limit', 1, 50);
  const located = (path: string, from: number) => {
    const field = pointer(loaded.document, path);
    return typeof field === 'string' ? textPosition(field, from) : {};
  };
  return bounded(
    () => {
      const page = selected.slice(start, start + limit);
      return {
        kind: loaded.kind,
        id: loaded.id,
        revision: loaded.revision,
        total: selected.length,
        variables: page.map((entry) => ({
          scope: entry.scope,
          name: entry.name,
          ...(entry.toggle === null ? {} : { toggle: entry.toggle }),
          reads: entry.reads,
          writes: entry.writes,
          defined: entry.defined,
          totalUses: entry.uses.length,
          uses: entry.uses.slice(0, USES_CAP).map((use) => ({
            path: `${loaded.root}${use.path}`,
            ...located(use.path, use.range.from),
            access: use.access,
            origin: use.origin,
            ...(use.label ? { label: use.label } : {}),
          })),
        })),
        findings: index.findings.filter((finding) => matches(finding.scope, finding.name)),
        dynamic: index.dynamic,
        nextOffset: start + page.length < selected.length ? start + page.length : null,
      };
    },
    () => (limit > 1 ? ((limit = Math.ceil(limit / 2)), true) : false)
  );
}

async function diagnose(store: Store, args: Record<string, unknown>, signal?: AbortSignal) {
  fields(args, ['kind', 'id', 'sections', 'severity', 'offset', 'limit']);
  const loaded = loadTarget(store, args);
  const applicable: readonly CodeDiagnosisSection[] =
    loaded.kind === 'content' ? CODE_DIAGNOSIS_SECTIONS : PRESET_DIAGNOSIS_SECTIONS;
  let sections = applicable;
  if (args.sections !== undefined) {
    if (
      !Array.isArray(args.sections) ||
      !args.sections.length ||
      args.sections.some((section) => !CODE_DIAGNOSIS_SECTIONS.includes(section))
    )
      throw new HttpError(
        400,
        `INVALID_ARGUMENTS: sections are ${CODE_DIAGNOSIS_SECTIONS.join(', ')}`
      );
    sections = applicable.filter((section) => (args.sections as unknown[]).includes(section));
  }
  const ranks = ['info', 'warning', 'error'];
  const minimum = args.severity === undefined ? 0 : ranks.indexOf(String(args.severity));
  if (minimum < 0)
    throw new HttpError(400, 'INVALID_ARGUMENTS: severity is error, warning or info');
  const all = await diagnoseRisuCode(loaded.target, sections, signal);
  const counts: Record<string, Record<CodeFinding['severity'], number>> = {};
  for (const section of sections) counts[section] = { error: 0, warning: 0, info: 0 };
  for (const finding of all) counts[finding.section]![finding.severity]++;
  const shown = all.filter((finding) => ranks.indexOf(finding.severity) >= minimum);
  const start = args.offset === undefined ? 0 : number(args.offset, 'offset', 0, shown.length);
  let limit = args.limit === undefined ? 50 : number(args.limit, 'limit', 1, 100);
  return bounded(
    () => {
      const page = shown.slice(start, start + limit);
      return {
        kind: loaded.kind,
        id: loaded.id,
        revision: loaded.revision,
        title: loaded.title,
        sections,
        counts,
        total: shown.length,
        findings: page.map((finding) => ({ ...finding, path: `${loaded.root}${finding.path}` })),
        nextOffset: start + page.length < shown.length ? start + page.length : null,
      };
    },
    () => (limit > 1 ? ((limit = Math.ceil(limit / 2)), true) : false)
  );
}

function change(before: string, after: string) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const from = Math.max(0, head - STEP_CONTEXT);
  const clip = (value: string, end: number) => {
    const to = Math.min(value.length, end + STEP_CONTEXT);
    const slice = value.slice(from, to);
    return `${from > 0 ? '…' : ''}${slice.length > 1200 ? `${slice.slice(0, 1199)}…` : slice}${to < value.length ? '…' : ''}`;
  };
  return {
    at: textPosition(before, head),
    before: clip(before, before.length - tail),
    after: clip(after, after.length - tail),
    lengths: [before.length, after.length],
  };
}

async function traceRegex(store: Store, args: Record<string, unknown>, signal?: AbortSignal) {
  fields(args, ['kind', 'id', 'stage', 'text', 'variables', 'toggles', 'userName', 'offset']);
  const loaded = loadTarget(store, args);
  const modes: readonly string[] = NATIVE_RISU_REGEX_MODES;
  if (!modes.includes(String(args.stage)))
    throw new HttpError(400, `INVALID_ARGUMENTS: stage is ${modes.join(', ')}`);
  const stage = args.stage as (typeof NATIVE_RISU_REGEX_MODES)[number];
  const sample = text(args.text, 'sample text', MAX_TRACE_TEXT, true);
  const variables = stringRecord(args.variables, 'variables');
  const toggles = stringRecord(args.toggles, 'toggles');
  const userName = args.userName === undefined ? 'User' : text(args.userName, 'user name', 200);
  let native: RisuContentSource;
  let base: string;
  let raw: unknown[];
  let globals: Record<string, string>;
  let templateDefaultVariables: string | undefined;
  if (loaded.target.kind === 'content') {
    native = loaded.target.native;
    const sources = nativeRisuSources(native);
    base = `${loaded.root}${sources.regex.path}`;
    raw = Array.isArray(sources.regex.entries) ? sources.regex.entries : [];
    globals = declaredToggleVariables(sources.toggles.text, toggles);
  } else {
    const preset = loaded.target.preset;
    const key = preset.regex == null && preset.presetRegex != null ? 'presetRegex' : 'regex';
    raw = Array.isArray(preset[key]) ? (preset[key] as unknown[]) : [];
    base = `${loaded.root}/${key}`;
    native = { version: 1, card: {}, module: { regex: raw }, assets: [], sourceHash: '' };
    globals = declaredToggleVariables(
      typeof preset.customPromptTemplateToggle === 'string'
        ? preset.customPromptTemplateToggle
        : '',
      toggles
    );
    templateDefaultVariables =
      typeof preset.templateDefaultVariables === 'string' ? preset.templateDefaultVariables : '';
  }
  const entries = nativeRisuRegexEntries(native);
  const card = native.card;
  const result = await processNativeRisuText({
    native,
    text: sample,
    mode: stage,
    trace: true,
    context: {
      variables,
      globalVariables: globals,
      messages: [],
      charName: typeof card.name === 'string' && card.name ? card.name : loaded.title,
      userName,
      displaying: stage === 'editdisplay',
      ...(templateDefaultVariables === undefined ? {} : { templateDefaultVariables }),
    },
  });
  signal?.throwIfAborted();
  const script = regexScript(entries, base);
  const steps = (result.steps ?? []).map((step) => ({
    ...(step.script === null ? { cbs: true } : { script: script(step.script) }),
    ...change(step.before, step.after),
  }));
  const issues = evaluatorIssues(result.issues, script);
  const changed = Object.fromEntries(
    Object.entries(result.variables).filter(([key, value]) => variables[key] !== value)
  );
  const start = args.offset === undefined ? 0 : number(args.offset, 'offset', 0, steps.length);
  let limit = 20;
  let output = 4000;
  return bounded(
    () => {
      const page = steps.slice(start, start + limit);
      return {
        kind: loaded.kind,
        id: loaded.id,
        revision: loaded.revision,
        stage,
        scripts: raw.length,
        totalSteps: steps.length,
        steps: page,
        ...(result.stepsTruncated ? { stepsTruncated: true } : {}),
        nextOffset: start + page.length < steps.length ? start + page.length : null,
        issues,
        result: {
          length: result.text.length,
          text: result.text.length > output ? `${result.text.slice(0, output)}…` : result.text,
        },
        changedVariables: changed,
      };
    },
    () => {
      if (limit > 1) limit = Math.ceil(limit / 2);
      else if (output > 200) output = Math.floor(output / 2);
      else return false;
      return true;
    }
  );
}

async function preview(store: Store, args: Record<string, unknown>, signal?: AbortSignal) {
  fields(args, ['id', 'greeting', 'text', 'toggles', 'userName', 'offset', 'limit']);
  const id = text(args.id, 'bot ID', 100);
  if (args.text !== undefined && args.greeting !== undefined)
    throw new HttpError(400, 'INVALID_ARGUMENTS: pass greeting or text, not both');
  const content = readResource(store, 'content', id) as Content;
  const native = (content.package as { nativeRisu?: RisuContentSource } | undefined)?.nativeRisu;
  if (!native) throw new HttpError(400, 'NATIVE_RISU_REQUIRED: this content has no Risu source');
  const greeting = args.greeting === undefined ? 0 : number(args.greeting, 'greeting', 0, 10_000);
  const options = { toggleValues: stringRecord(args.toggles, 'toggles') };
  const userName = args.userName === undefined ? undefined : text(args.userName, 'user name', 200);
  let rendered: { html: string; issues: string[] } | { failure: string };
  if (args.text !== undefined) {
    rendered = await nativeRisuDraftPreview(
      store,
      id,
      {
        revision: content.revision,
        nativeRisu: native,
        text: text(args.text, 'first message', SOURCE_TEXT_MAX_CHARS, true),
        ...(userName === undefined ? {} : { userName }),
      },
      signal,
      options
    );
  } else {
    try {
      rendered = await nativeRisuStartPreview(
        store,
        id,
        {
          revision: content.revision,
          startId: `start-${greeting}`,
          ...(userName === undefined ? {} : { userName }),
        },
        signal,
        options
      );
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404)
        throw new HttpError(404, 'GREETING_NOT_FOUND: no first message has this number');
      throw error;
    }
  }
  const base = {
    id,
    revision: content.revision,
    ...(args.text === undefined ? { greeting } : { replacement: true }),
  };
  if ('failure' in rendered) return { ...base, failure: rendered.failure };
  const html = rendered.html;
  const start = args.offset === undefined ? 0 : number(args.offset, 'offset', 0, html.length);
  const limit = args.limit === undefined ? PAGE_CHARS : number(args.limit, 'limit', 1, 20_000);
  let end = Math.min(html.length, start + limit);
  if (end < html.length && /[\uD800-\uDBFF]/u.test(html[end - 1]!)) end--;
  return {
    ...base,
    html: html.slice(start, end),
    offset: start,
    totalChars: html.length,
    nextOffset: end < html.length ? end : null,
    issues: evaluatorIssues(
      rendered.issues,
      regexScript(
        nativeRisuRegexEntries(native),
        `/package/nativeRisu${nativeRisuSources(native).regex.path}`
      )
    ),
  };
}

function regexScript(entries: ReturnType<typeof nativeRisuRegexEntries>, base: string) {
  return (index: number) => {
    const entry = entries[index];
    const comment = entry && typeof entry.script.comment === 'string' ? entry.script.comment : '';
    return entry
      ? { index: entry.index, path: `${base}/${entry.index}`, ...(comment ? { comment } : {}) }
      : { index };
  };
}

function evaluatorIssues(issues: string[], script: ReturnType<typeof regexScript>) {
  return issues.map((issue) => {
    const found = /^(regex|regex-command|asset):(.+)$/u.exec(issue);
    if (found?.[1] === 'asset') return { code: 'asset.missing', name: found[2] };
    return found && /^\d+$/u.test(found[2]!)
      ? {
          code: found[1] === 'regex' ? 'regex.failed' : 'regex.command-unsupported',
          script: script(Number(found[2])),
        }
      : /^[A-Z][A-Z0-9_]*$/u.test(issue)
        ? { code: issue }
        : { code: 'cbs.unsupported', name: issue };
  });
}

export async function invokeHelperCodeTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (name === 'code.cbs') return checkCbs(store, args);
  if (name === 'code.references') return references(store, args);
  if (name === 'code.diagnose') return diagnose(store, args, signal);
  if (name === 'code.regex') return traceRegex(store, args, signal);
  if (name === 'code.preview') return preview(store, args, signal);
  throw new HttpError(400, `UNKNOWN_APP_TOOL:${name}`);
}
