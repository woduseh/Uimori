import {
  analyzeCbs,
  normalizeCbsFunctionName,
  type CbsAnalysis,
  type CbsDiagnostic,
  type CbsFunctionCatalogEntry,
} from '../core/cbs-analysis.js';
import {
  nativeRisuContentReferenceInput,
  nativeRisuPresetReferenceInput,
  type CbsReferenceInput,
} from '../core/cbs-references.js';
import {
  NATIVE_RISU_PRESET_BLOCKS,
  NATIVE_RISU_PRESET_SKIPPED_BLOCKS,
} from '../core/risu-native-preset.js';
import {
  nativeRisuRegexEntries,
  nativeRisuSources,
  type RisuContentSource,
} from '../core/risu-native.js';
import { nativeLoreDecoratorReport } from './risu-import-lore.js';
import { RISU_PRESET_IGNORED_SETTINGS } from './risu-preset-program.js';
import { checkNativeRisuLuaSyntax } from './risu-lua-syntax.js';
import { nativeRisuCbsFunctionCatalog } from './risu-native-cbs.js';
import {
  RISU_NATIVE_LUA_MODEL_FUNCTIONS,
  RISU_NATIVE_LUA_UNSUPPORTED_FUNCTIONS,
} from './risu-native-lua.js';
import {
  createAssetResolver,
  NATIVE_RISU_ASSET_TAG,
  NATIVE_RISU_REGEX_MODES,
  nativeRisuRegexPlan,
} from './risu-native-render.js';
import {
  mixesNativeRisuLua,
  RISU_NATIVE_SETVAR_OPERATORS,
  RISU_NATIVE_TRIGGER_CONDITIONS,
  RISU_NATIVE_TRIGGER_EFFECTS,
  RISU_NATIVE_TRIGGER_MAX_INDENT,
  RISU_NATIVE_TRIGGER_OPERATORS,
} from './risu-native-runtime.js';

export const CODE_DIAGNOSIS_SECTIONS = [
  'cbs',
  'assets',
  'regex',
  'triggers',
  'lore',
  'lua',
  'compatibility',
] as const;
export type CodeDiagnosisSection = (typeof CODE_DIAGNOSIS_SECTIONS)[number];
export const PRESET_DIAGNOSIS_SECTIONS: readonly CodeDiagnosisSection[] = [
  'cbs',
  'regex',
  'compatibility',
];
export type CodeFinding = {
  section: CodeDiagnosisSection;
  code: string;
  severity: 'error' | 'warning' | 'info';
  path: string;
  line?: number;
  column?: number;
  name?: string;
  message: string;
};
export type CodeDiagnosisTarget =
  | { kind: 'content'; native: RisuContentSource }
  | { kind: 'prompt-preset'; preset: Record<string, unknown> };

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown) => (typeof value === 'string' ? value : '');

export function textPosition(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let at = text.indexOf('\n'); at >= 0 && at < offset; at = text.indexOf('\n', at + 1)) {
    line++;
    start = at + 1;
  }
  return { line, column: offset - start + 1 };
}

export const CBS_DIAGNOSTIC_MESSAGES: Record<CbsDiagnostic['code'], string> = {
  'cbs.unclosed-call': 'This {{ is never closed with }}. Risu leaves the rest of the text as is.',
  'cbs.unclosed-block': 'This block is never closed with {{/}}.',
  'cbs.stray-closer': 'This {{/...}} closes no open block.',
  'cbs.else-outside-when': '{{:else}} is only meaningful inside {{#when}}.',
  'cbs.unknown-function': 'No CBS function has this name; it evaluates to its own text.',
};

let deprecatedByName: Map<string, CbsFunctionCatalogEntry> | undefined;
function deprecatedFunctions() {
  if (deprecatedByName) return deprecatedByName;
  deprecatedByName = new Map();
  for (const entry of nativeRisuCbsFunctionCatalog().functions)
    if (entry.deprecated)
      for (const name of [entry.name, ...entry.aliases])
        deprecatedByName.set(normalizeCbsFunctionName(name), entry);
  return deprecatedByName;
}

export function analyzeCbsText(text: string): CbsAnalysis {
  return analyzeCbs(text, { catalog: nativeRisuCbsFunctionCatalog() });
}

export function cbsTextFindings(text: string, path: string, analysis = analyzeCbsText(text)) {
  const findings: CodeFinding[] = analysis.diagnostics.map((diagnostic) => ({
    section: 'cbs',
    code: diagnostic.code,
    severity: diagnostic.severity,
    path,
    ...textPosition(text, diagnostic.from),
    ...(diagnostic.name ? { name: diagnostic.name } : {}),
    message: CBS_DIAGNOSTIC_MESSAGES[diagnostic.code],
  }));
  const deprecated = deprecatedFunctions();
  for (const call of analysis.calls) {
    if (
      (call.kind !== 'call' && call.kind !== 'block-open') ||
      call.nameDynamic ||
      call.context === 'inert'
    )
      continue;
    const entry = deprecated.get(call.normalizedName);
    if (!entry?.deprecated) continue;
    const { message, replacement } = entry.deprecated;
    findings.push({
      section: 'cbs',
      code: 'cbs.deprecated-function',
      severity: 'warning',
      path,
      ...textPosition(text, call.nameRange.from),
      name: call.name,
      message:
        replacement && !message.includes(replacement)
          ? `${message} Use ${replacement} instead.`
          : message,
    });
  }
  return findings;
}

function luaCodeMask(code: string): string {
  const chars = code.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  const longBracket = (at: number) => /^\[(=*)\[/u.exec(code.slice(at, at + 64));
  while (i < code.length) {
    if (code.startsWith('--', i)) {
      const long = longBracket(i + 2);
      const end = long
        ? code.indexOf(`]${long[1]}]`, i + 2 + long[0].length)
        : code.indexOf('\n', i);
      const stop = end < 0 ? code.length : long ? end + long[1]!.length + 2 : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    const long = code[i] === '[' ? longBracket(i) : null;
    if (long) {
      const end = code.indexOf(`]${long[1]}]`, i + long[0].length);
      const stop = end < 0 ? code.length : end + long[1]!.length + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      let k = i + 1;
      while (k < code.length && code[k] !== quote && code[k] !== '\n')
        k += code[k] === '\\' ? 2 : 1;
      blank(i, k + 1);
      i = k + 1;
      continue;
    }
    i++;
  }
  return chars.join('');
}

function luaCalls(code: string, names: readonly string[]) {
  if (!names.length) return [];
  const masked = luaCodeMask(code);
  const pattern = new RegExp(
    `(?<![\\w.:])(${names
      .map((name) =>
        name
          .split('.')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
          .join('\\s*\\.\\s*')
      )
      .join('|')})\\s*\\(`,
    'gu'
  );
  return [...masked.matchAll(pattern)].map((match) => ({
    name: match[1]!.replace(/\s+/gu, ''),
    offset: match.index,
  }));
}

function regexFindings(
  native: RisuContentSource,
  base: string,
  raw: unknown[],
  findings: CodeFinding[],
  sections: Set<CodeDiagnosisSection>
) {
  const modes: readonly string[] = NATIVE_RISU_REGEX_MODES;
  const entries = nativeRisuRegexEntries(native);
  const valid = new Set(entries.map((entry) => entry.index));
  raw.forEach((_, index) => {
    if (valid.has(index)) return;
    if (sections.has('regex'))
      findings.push({
        section: 'regex',
        code: 'regex.invalid-entry',
        severity: 'warning',
        path: `${base}/${index}`,
        message: 'A regex script needs string in, out and type fields; Uimori skips this entry.',
      });
  });
  for (const { script, index } of entries) {
    if (!modes.includes(script.type) && sections.has('compatibility'))
      findings.push({
        section: 'compatibility',
        code: 'compat.regex-type',
        severity: 'warning',
        path: `${base}/${index}/type`,
        name: script.type,
        message: `Uimori runs regex scripts of the types ${modes.join(', ')} only; this script never runs.`,
      });
  }
  for (const mode of NATIVE_RISU_REGEX_MODES)
    for (const planned of nativeRisuRegexPlan(native, mode)) {
      const index = entries[planned.index]!.index;
      if (!planned.script.in) continue;
      if (sections.has('regex') && !planned.actions.includes('cbs'))
        try {
          new RegExp(planned.script.in, planned.flags);
        } catch (error) {
          findings.push({
            section: 'regex',
            code: 'regex.compile',
            severity: 'error',
            path: `${base}/${index}/in`,
            message: `The pattern does not compile with flags "${planned.flags}": ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      if (sections.has('compatibility') && !planned.moving && planned.replacement.startsWith('@@'))
        findings.push({
          section: 'compatibility',
          code: 'compat.regex-command',
          severity: 'warning',
          path: `${base}/${index}/out`,
          name: planned.replacement.split(/\s/u, 1)[0],
          message:
            'Uimori does not run Risu host commands in a regex replacement (only @@move_top and @@move_bottom); the script is reported as an issue and leaves the text unchanged.',
        });
    }
}

async function triggerFindings(
  native: RisuContentSource,
  base: string,
  findings: CodeFinding[],
  sections: Set<CodeDiagnosisSection>,
  signal?: AbortSignal
) {
  const sources = nativeRisuSources(native);
  const raw = list(sources.triggers.entries);
  const lowLevelAccess = sources.lowLevelAccess;
  const chunks: { code: string; path: string }[] = [];
  raw.forEach((value, index) => {
    if (!isObject(value)) return;
    const path = `${base}/${index}`;
    const effects = list(value.effect).map(object);
    if (sections.has('triggers') && mixesNativeRisuLua(effects))
      findings.push({
        section: 'triggers',
        code: 'trigger.mixed-lua',
        severity: 'error',
        path: `${path}/effect`,
        message:
          'A trigger that runs Lua must contain only triggerlua effects; Uimori refuses to run this trigger.',
      });
    list(value.conditions).forEach((rawCondition, at) => {
      const condition = object(rawCondition);
      if (!sections.has('compatibility')) return;
      if (!RISU_NATIVE_TRIGGER_CONDITIONS.includes(string(condition.type)))
        findings.push({
          section: 'compatibility',
          code: 'compat.trigger-condition',
          severity: 'error',
          path: `${path}/conditions/${at}/type`,
          name: string(condition.type),
          message: `Uimori supports trigger conditions of the types ${RISU_NATIVE_TRIGGER_CONDITIONS.join(', ')}; the trigger fails when this condition is checked.`,
        });
      else if (!RISU_NATIVE_TRIGGER_OPERATORS.includes(string(condition.operator)))
        findings.push({
          section: 'compatibility',
          code: 'compat.trigger-operator',
          severity: 'error',
          path: `${path}/conditions/${at}/operator`,
          name: string(condition.operator),
          message: `Uimori supports the condition operators ${RISU_NATIVE_TRIGGER_OPERATORS.join(' ')}; the trigger fails when this condition is checked.`,
        });
    });
    effects.forEach((effect, at) => {
      const effectPath = `${path}/effect/${at}`;
      if (effect.type === 'triggerlua') {
        if (typeof effect.code === 'string')
          chunks.push({ code: effect.code, path: `${effectPath}/code` });
        else if (sections.has('triggers'))
          findings.push({
            section: 'triggers',
            code: 'trigger.lua-source',
            severity: 'error',
            path: `${effectPath}/code`,
            message: 'A triggerlua effect needs its Lua source as a string.',
          });
        return;
      }
      const indent = Number(effect.indent ?? 0);
      if (
        sections.has('triggers') &&
        (!Number.isSafeInteger(indent) || indent < 0 || indent > RISU_NATIVE_TRIGGER_MAX_INDENT)
      )
        findings.push({
          section: 'triggers',
          code: 'trigger.indent',
          severity: 'error',
          path: `${effectPath}/indent`,
          message: `The indent must be a whole number from 0 to ${RISU_NATIVE_TRIGGER_MAX_INDENT}.`,
        });
      if (!sections.has('compatibility')) return;
      if (!RISU_NATIVE_TRIGGER_EFFECTS.includes(string(effect.type)))
        findings.push({
          section: 'compatibility',
          code: 'compat.trigger-effect',
          severity: 'error',
          path: `${effectPath}/type`,
          name: string(effect.type),
          message:
            'Uimori does not run this trigger effect; the trigger fails when it reaches the effect.',
        });
      else if (
        (effect.type === 'setvar' || effect.type === 'v2SetVar') &&
        !RISU_NATIVE_SETVAR_OPERATORS.includes(string(effect.operator))
      )
        findings.push({
          section: 'compatibility',
          code: 'compat.trigger-setvar-operator',
          severity: 'error',
          path: `${effectPath}/operator`,
          name: string(effect.operator),
          message: `Uimori supports the variable operators ${RISU_NATIVE_SETVAR_OPERATORS.join(' ')}.`,
        });
    });
  });
  if (sections.has('lua') && chunks.length) {
    const errors = await checkNativeRisuLuaSyntax(
      chunks.map((chunk) => chunk.code),
      signal
    );
    errors.forEach((error, index) => {
      if (!error) return;
      findings.push({
        section: 'lua',
        code: 'lua.syntax',
        severity: 'error',
        path: chunks[index]!.path,
        ...(error.line === null ? {} : { line: error.line }),
        message: error.message,
      });
    });
  }
  if (!sections.has('compatibility')) return;
  for (const chunk of chunks) {
    for (const call of luaCalls(chunk.code, RISU_NATIVE_LUA_UNSUPPORTED_FUNCTIONS))
      findings.push({
        section: 'compatibility',
        code: 'compat.lua-function',
        severity: 'warning',
        path: chunk.path,
        ...textPosition(chunk.code, call.offset),
        name: call.name,
        message: `Uimori's Lua host does not provide ${call.name}; calling it raises RISU_NATIVE_API_UNSUPPORTED.`,
      });
    if (!lowLevelAccess)
      for (const call of luaCalls(chunk.code, RISU_NATIVE_LUA_MODEL_FUNCTIONS))
        findings.push({
          section: 'compatibility',
          code: 'compat.lua-low-level-access',
          severity: 'warning',
          path: chunk.path,
          ...textPosition(chunk.code, call.offset),
          name: call.name,
          message: `${call.name} needs lowLevelAccess on this card or module; without it the call fails with RISU_NATIVE_MODEL_DENIED.`,
        });
  }
}

function keyFragments(entry: JsonObject, module: boolean, field: 'primary' | 'secondary') {
  if (module) {
    const value = string(field === 'primary' ? entry.key : entry.secondkey);
    return {
      key: field === 'primary' ? 'key' : 'secondkey',
      fragments: value ? value.split(',') : [],
    };
  }
  const key = field === 'primary' ? 'keys' : 'secondary_keys';
  return { key, fragments: list(entry[key]).map(string) };
}

function loreFindings(
  native: RisuContentSource,
  findings: CodeFinding[],
  sections: Set<CodeDiagnosisSection>
) {
  const module = native.module?.lorebook != null;
  const { path: base, entries } = nativeRisuSources(native).lore;
  const raw = list(entries);
  raw.forEach((value, index) => {
    if (!isObject(value) || value.mode === 'folder') return;
    const path = `${base}/${index}`;
    const content = string(value.content);
    const report = nativeLoreDecoratorReport(content);
    if (sections.has('lore') && value.useRegex !== true && value.use_regex !== true) {
      for (const field of ['primary', 'secondary'] as const) {
        const { key, fragments } = keyFragments(value, module, field);
        if (fragments.some((fragment) => !fragment.trim()))
          findings.push({
            section: 'lore',
            code: 'lore.blank-key',
            severity: 'warning',
            path: `${path}/${key}`,
            message:
              'The keys contain an empty fragment, for example from a doubled or trailing comma.',
          });
        const seen = new Set<string>();
        for (const fragment of fragments) {
          const normalized = fragment.trim().toLocaleLowerCase();
          if (!normalized) continue;
          if (seen.has(normalized))
            findings.push({
              section: 'lore',
              code: 'lore.duplicate-key',
              severity: 'info',
              path: `${path}/${key}`,
              name: fragment.trim(),
              message: 'The same key appears more than once in this entry.',
            });
          seen.add(normalized);
        }
      }
      const always = value.constant === true || value.alwaysActive === true;
      if (
        !always &&
        !report.parsed.decorators.activate &&
        !keyFragments(value, module, 'primary').fragments.some((fragment) => fragment.trim())
      )
        findings.push({
          section: 'lore',
          code: 'lore.no-keys',
          severity: 'info',
          path,
          message:
            'This entry has no keys and is not always active, so Risu never activates it by keyword. Uimori selects optional lore by relevance, not by keys.',
        });
    }
    if (!sections.has('compatibility')) return;
    for (const notice of report.notices)
      findings.push({
        section: 'compatibility',
        code: `compat.lore-decorator`,
        severity: notice.level === 'unsupported' ? 'warning' : 'info',
        path: `${path}/content`,
        name: `@@${notice.decorator}`,
        message:
          notice.level === 'unsupported'
            ? 'Uimori keeps this placement directive in the source but does not apply it when placing lore.'
            : 'Uimori keeps this activation rule in the source; optional lore is chosen by relevance judgment and lookups instead.',
      });
    for (const name of report.parsed.unknown)
      findings.push({
        section: 'compatibility',
        code: 'compat.lore-decorator-unknown',
        severity: 'warning',
        path: `${path}/content`,
        name: `@@${name}`,
        message:
          'Risu does not recognise this directive; it is removed from the entry text that is used.',
      });
    if (report.parsed.decorators.dont_activate)
      findings.push({
        section: 'compatibility',
        code: 'compat.lore-not-activated',
        severity: 'info',
        path: `${path}/content`,
        name: '@@dont_activate',
        message: 'Uimori never sends an entry marked @@dont_activate to the model.',
      });
    if (report.inlineDirective)
      findings.push({
        section: 'compatibility',
        code: 'compat.lore-inline-directive',
        severity: 'warning',
        path: `${path}/content`,
        message:
          'A @@ line after the first ordinary line is not read as a directive and stays in the text.',
      });
  });
}

function assetFindings(
  native: RisuContentSource,
  fields: CbsReferenceInput['cbs'],
  findings: CodeFinding[]
) {
  const resolve = createAssetResolver({
    native,
    context: {
      assetUrls: Object.fromEntries(
        native.assets.map((asset) => [asset.imageId, `/api/assets/${asset.imageId}`])
      ),
    },
  });
  for (const field of fields)
    for (const match of field.text.matchAll(NATIVE_RISU_ASSET_TAG)) {
      const name = match[2]!.trim();
      if (!name || /\$\d/u.test(name) || resolve(name)) continue;
      findings.push({
        section: 'assets',
        code: 'asset.missing',
        severity: 'warning',
        path: field.path,
        ...textPosition(field.text, match.index),
        name,
        message:
          'No stored image of this resource has this name, and no name is within the Risu matching distance; the tag is shown as written.',
      });
    }
}

function presetBlockFindings(preset: JsonObject, findings: CodeFinding[]) {
  const settings = object(preset.promptSettings);
  for (const key of RISU_PRESET_IGNORED_SETTINGS)
    if (settings[key] === true)
      findings.push({
        section: 'compatibility',
        code: 'compat.preset-setting',
        severity: 'info',
        path: `/promptSettings/${key}`,
        name: key,
        message:
          "Uimori does not apply this Risu built-in prompt setting; the preset's blocks and Uimori's own model settings are used.",
      });
  list(preset.promptTemplate).forEach((value, index) => {
    const type = string(object(value).type);
    if (NATIVE_RISU_PRESET_SKIPPED_BLOCKS.includes(type))
      findings.push({
        section: 'compatibility',
        code: 'compat.preset-block-skipped',
        severity: 'info',
        path: `/promptTemplate/${index}/type`,
        name: type,
        message: 'Uimori skips this block type when it builds the request.',
      });
    else if (!NATIVE_RISU_PRESET_BLOCKS.includes(type))
      findings.push({
        section: 'compatibility',
        code: 'compat.preset-block-unsupported',
        severity: 'error',
        path: `/promptTemplate/${index}/type`,
        name: type,
        message: `Uimori supports the block types ${NATIVE_RISU_PRESET_BLOCKS.join(', ')}; a request with this block fails with RISU_NATIVE_PRESET_BLOCK.`,
      });
  });
}

export function cbsFields(
  target: CodeDiagnosisTarget,
  input = codeDiagnosisReferenceInput(target)
) {
  return input.cbs.filter(
    (field) => field.text.includes('{') || /<(?:user|char|bot)>/iu.test(field.text)
  );
}

export function codeDiagnosisReferenceInput(target: CodeDiagnosisTarget): CbsReferenceInput {
  return target.kind === 'content'
    ? nativeRisuContentReferenceInput(target.native)
    : nativeRisuPresetReferenceInput(target.preset);
}

export async function diagnoseRisuCode(
  target: CodeDiagnosisTarget,
  requested: readonly CodeDiagnosisSection[],
  signal?: AbortSignal
): Promise<CodeFinding[]> {
  const sections = new Set(requested);
  const findings: CodeFinding[] = [];
  const input = codeDiagnosisReferenceInput(target);
  if (sections.has('cbs'))
    for (const field of cbsFields(target, input))
      findings.push(...cbsTextFindings(field.text, field.path));
  if (target.kind === 'content') {
    const native = target.native;
    const sources = nativeRisuSources(native);
    if (sections.has('assets')) assetFindings(native, cbsFields(target, input), findings);
    if (sections.has('regex') || sections.has('compatibility'))
      regexFindings(native, sources.regex.path, list(sources.regex.entries), findings, sections);
    if (sections.has('lore') || sections.has('compatibility'))
      loreFindings(native, findings, sections);
    if (sections.has('triggers') || sections.has('lua') || sections.has('compatibility'))
      await triggerFindings(native, sources.triggers.path, findings, sections, signal);
  } else {
    const preset = target.preset;
    const key = preset.regex == null && preset.presetRegex != null ? 'presetRegex' : 'regex';
    if (sections.has('regex') || sections.has('compatibility'))
      regexFindings(
        {
          version: 1,
          card: {},
          module: { regex: list(preset[key]) },
          assets: [],
          sourceHash: '',
        },
        `/${key}`,
        list(preset[key]),
        findings,
        sections
      );
    if (sections.has('compatibility')) presetBlockFindings(preset, findings);
  }
  const order = new Map(CODE_DIAGNOSIS_SECTIONS.map((section, index) => [section, index]));
  return findings.sort(
    (a, b) =>
      order.get(a.section)! - order.get(b.section)! ||
      a.path.localeCompare(b.path, 'en', { numeric: true }) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0)
  );
}
