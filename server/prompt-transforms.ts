import { createHash } from 'node:crypto';
import { executionContext } from '../core/execution-context.js';
import {
  renderPromptTemplate,
  resolvePromptValues,
  validatePromptProgram,
  type PromptHistoryMessage,
  type PromptProgram,
  type PromptValue,
} from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import type { PromptInputTransformReceipt } from '../core/prompt-input-transforms.js';
import {
  TextTransformError,
  type TextTransformResult,
  type TextTransformRule,
} from '../core/text-transform.js';
import {
  resolveTemplateVariableContext,
  templateReadsVariables,
} from '../core/template-variables.js';
import { isSha256Hex } from './request-validation.js';
import { applyTextTransformBatch } from './text-transforms.js';
import {
  projectExtensionMessageEdits,
  projectExtensionRequestEdit,
  requestEditMessages,
} from './extension-request-edit.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const authored = (snapshot: RunSnapshot) =>
  snapshot.packageStart?.mode === 'authored' || !!snapshot.transcriptImport;
const selectedProgram = (snapshot: RunSnapshot, program?: PromptProgram) =>
  program ?? snapshot.profile?.promptPresets?.main?.program;
export function hasPromptInputTransforms(snapshot: RunSnapshot, program?: PromptProgram): boolean {
  return (
    !authored(snapshot) &&
    !!selectedProgram(snapshot, program)?.transforms?.some(
      (r) => r.enabled !== false && r.stage === 'input'
    )
  );
}
function configuration(
  snapshot: RunSnapshot,
  program?: PromptProgram,
  supplied?: Record<string, PromptValue>
) {
  const selected = selectedProgram(snapshot, program);
  if (selected) validatePromptProgram(selected);
  const preset = snapshot.profile?.promptPresets?.main;
  const values = selected
    ? resolvePromptValues(
        selected,
        supplied ??
          (preset
            ? snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
            : undefined)
      )
    : {};
  const runtime = executionContext(snapshot);
  const bot = { name: String((runtime.bot as { name?: string }).name ?? 'Character') };
  const user = { name: String((runtime.user as { name?: string }).name ?? 'User') };
  const profile = snapshot.profile;
  const variableContext = resolveTemplateVariableContext(
    profile || selected
      ? {
          packageAttachments: profile?.packageAttachments,
          packages: profile?.packages,
          personaReference: profile?.personaReference,
          variableState: profile?.variableState,
          ...(selected ? { promptPresets: { main: { program: selected } } } : {}),
        }
      : undefined
  );
  return {
    rules: selected?.transforms?.filter((rule) => rule.enabled !== false) ?? [],
    values,
    bot,
    user,
    ...variableContext,
  };
}
/** Transmittable message count, including the current request. Text edits never change it. */
const messageCount = (snapshot: RunSnapshot) =>
  (snapshot.logicalHistory ?? snapshot.history).length + 1;
/** The transmitted conversation after host-owned input and request edits, before this stage. */
function inputMessages(snapshot: RunSnapshot): PromptHistoryMessage[] {
  return projectExtensionMessageEdits(
    snapshot,
    requestEditMessages(snapshot, projectExtensionRequestEdit(snapshot).text)
  ).history;
}
function stageConfiguration(
  snapshot: RunSnapshot,
  program?: PromptProgram,
  values?: Record<string, PromptValue>
) {
  const config = configuration(snapshot, program, values);
  return { ...config, rules: config.rules.filter((rule) => rule.stage === 'input') };
}
function rulesForMessage(
  config: ReturnType<typeof configuration>,
  stage: 'input' | 'display',
  message: PromptHistoryMessage,
  index: number,
  lastIndex: number
): TextTransformRule[] {
  return config.rules
    .filter(
      (rule) =>
        rule.stage === stage && (!rule.role || rule.role === 'all' || rule.role === message.role)
    )
    .map((rule) => {
      if (config.variableDefaultsError && templateReadsVariables(rule.replacementTemplate))
        throw new TextTransformError('PROMPT_VARIABLE_DEFAULTS_LIMIT', rule.id);
      return {
        id: rule.id,
        pattern: rule.pattern,
        flags: rule.flags,
        replacement: rule.replacementTemplate
          ? renderPromptTemplate(
              rule.replacementTemplate,
              config.values,
              { char: config.bot.name, slot: '' },
              {
                runtime: {
                  bot: config.bot,
                  user: config.user,
                  ...(config.variables === undefined ? {} : { variables: config.variables }),
                  message: {
                    text: message.text,
                    role: message.role,
                    index,
                    lastIndex,
                    current: message.current === true,
                  },
                },
                limits: { maxOutputChars: 16_384 },
                escapeReplacementValues: true,
              }
            )
          : rule.replacement,
      };
    });
}
function reject(): never {
  throw new TextTransformError('PROMPT_INPUT_TRANSFORMS_INVALID');
}
function validateReceiptShape(receipt: PromptInputTransformReceipt) {
  if (
    !receipt ||
    receipt.version !== 1 ||
    !isSha256Hex(receipt.configurationHash) ||
    !isSha256Hex(receipt.inputHash) ||
    !Array.isArray(receipt.entries) ||
    receipt.entries.length > 100_000 ||
    Object.keys(receipt).some(
      (key) => !['version', 'configurationHash', 'inputHash', 'entries', 'error'].includes(key)
    )
  )
    reject();
  if (receipt.error !== undefined && !/^TEXT_[A-Z_]+$|^PROMPT_[A-Z_]+$/u.test(receipt.error))
    reject();
  let size = 0;
  for (const [index, entry] of receipt.entries.entries()) {
    if (
      !entry ||
      entry.index !== index ||
      !['user', 'assistant'].includes(entry.role) ||
      !isSha256Hex(entry.inputHash) ||
      !isSha256Hex(entry.outputHash) ||
      Object.keys(entry).some(
        (key) => !['index', 'role', 'inputHash', 'outputHash', 'text', 'applied'].includes(key)
      ) ||
      !Array.isArray(entry.applied) ||
      entry.applied.length > 32 ||
      entry.applied.some((id) => typeof id !== 'string' || id.length > 64)
    )
      reject();
    if (entry.text !== undefined) {
      if (
        typeof entry.text !== 'string' ||
        entry.text.length > 2_000_000 ||
        hash(entry.text) !== entry.outputHash
      )
        reject();
      size += entry.text.length;
    } else if (entry.inputHash !== entry.outputHash) reject();
    if (receipt.error && (entry.text !== undefined || entry.applied.length)) reject();
  }
  if (
    size > 2_000_000 ||
    digest(receipt.entries.map(({ index, role, inputHash }) => ({ index, role, inputHash }))) !==
      receipt.inputHash
  )
    reject();
}
/** Archive validation binds the saved calculation without executing regex again. */
export function validatePromptInputTransforms(snapshot: RunSnapshot): void {
  const receipt = snapshot.promptInputTransforms;
  if (!receipt) return;
  validateReceiptShape(receipt);
  if (!hasPromptInputTransforms(snapshot)) reject();
  const config = stageConfiguration(snapshot),
    messages = inputMessages(snapshot);
  if (digest(config) !== receipt.configurationHash || messages.length !== receipt.entries.length)
    reject();
  const ids = new Set(config.rules.map((rule) => rule.id));
  for (const [index, message] of messages.entries()) {
    const entry = receipt.entries[index]!;
    if (
      entry.inputHash !== hash(message.text) ||
      entry.role !== message.role ||
      entry.applied.some((id) => !ids.has(id))
    )
      reject();
  }
}
/** Compute once outside reservation transactions, including a durable original-text fallback. */
export async function preparePromptInputTransforms(
  snapshot: RunSnapshot,
  program?: PromptProgram,
  values?: Record<string, PromptValue>
): Promise<RunSnapshot> {
  if (!hasPromptInputTransforms(snapshot, program)) {
    if (!snapshot.promptInputTransforms) return snapshot;
    const { promptInputTransforms: _receipt, ...base } = snapshot;
    return base;
  }
  const config = stageConfiguration(snapshot, program, values),
    messages = inputMessages(snapshot);
  const configurationHash = digest(config);
  const entries = messages.map((message, index) => ({
    index,
    role: message.role,
    inputHash: hash(message.text),
    outputHash: hash(message.text),
    applied: [] as string[],
  }));
  const inputHash = digest(
    entries.map(({ index, role, inputHash }) => ({ index, role, inputHash }))
  );
  const existing = snapshot.promptInputTransforms;
  if (
    existing &&
    existing.configurationHash === configurationHash &&
    existing.inputHash === inputHash
  ) {
    validateReceiptShape(existing);
    return snapshot;
  }
  const receipt: PromptInputTransformReceipt = {
    version: 1,
    configurationHash,
    inputHash,
    entries,
  };
  try {
    const results = await applyTextTransformBatch(
      messages.map((message, index) => ({
        text: message.text,
        rules: rulesForMessage(config, 'input', message, index, messages.length - 1),
      }))
    );
    receipt.entries = entries.map((entry, index) => {
      const result = results[index]!;
      return {
        ...entry,
        outputHash: hash(result.text),
        ...(result.changed ? { text: result.text } : {}),
        applied: result.applied,
      };
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    receipt.error = /^(?:TEXT|PROMPT)_[A-Z_]+$/u.test(code) ? code : 'TEXT_TRANSFORM_FAILED';
  }
  return { ...snapshot, promptInputTransforms: receipt };
}
/** Projection supports history subsets used by context sizing, while indices remain the frozen originals. */
export function projectPromptInputTransforms(
  snapshot: RunSnapshot,
  history: PromptHistoryMessage[],
  program?: PromptProgram,
  values?: Record<string, PromptValue>
): { history: PromptHistoryMessage[]; warnings: string[] } {
  if (!hasPromptInputTransforms(snapshot, program)) return { history, warnings: [] };
  const receipt = snapshot.promptInputTransforms;
  if (!receipt) return { history, warnings: ['PROMPT_INPUT_TRANSFORMS_PENDING'] };
  validateReceiptShape(receipt);
  const config = stageConfiguration(snapshot, program, values);
  if (receipt.configurationHash !== digest(config)) reject();
  const indices = new Map(inputMessages(snapshot).map((message, index) => [message.id, index]));
  const rules = new Set(config.rules.map((rule) => rule.id));
  const projected = history.map((message) => {
    const index = indices.get(message.id),
      entry = index === undefined ? undefined : receipt.entries[index];
    if (
      !entry ||
      entry.inputHash !== hash(message.text) ||
      entry.role !== message.role ||
      entry.applied.some((id) => !rules.has(id))
    )
      reject();
    return entry.text === undefined ? message : { ...message, text: entry.text };
  });
  return {
    history: projected,
    warnings: receipt.error
      ? [`PROMPT_INPUT_TRANSFORMS_FALLBACK:${receipt.error}`]
      : receipt.entries.some((entry) => entry.text !== undefined)
        ? ['PROMPT_INPUT_TRANSFORMS_APPLIED']
        : [],
  };
}
/** The transmitted copy of the current request: host-owned input edits, then the input stage. */
export function currentPromptInputTransform(
  snapshot: RunSnapshot
): TextTransformResult | undefined {
  const edit = projectExtensionRequestEdit(snapshot);
  const receipt = snapshot.promptInputTransforms;
  if (!receipt) return edit.changed ? edit : undefined;
  validateReceiptShape(receipt);
  const entry = receipt.entries.at(-1);
  if (!entry || entry.inputHash !== hash(edit.text) || entry.role !== 'user') reject();
  return {
    text: entry.text ?? edit.text,
    changed: edit.changed || entry.text !== undefined,
    applied: [...edit.applied, ...entry.applied],
  };
}
export async function applyPromptDisplayTransforms(
  snapshot: RunSnapshot,
  text: string,
  role: 'user' | 'assistant'
): Promise<TextTransformResult> {
  const authoredStart = snapshot.packageStart?.mode === 'authored';
  if (authoredStart && role === 'user') return { text, changed: false, applied: [] };
  const config = configuration(snapshot),
    // An authored opening has no preceding user request in the actual conversation.
    lastIndex = messageCount(snapshot) - (authoredStart ? 1 : 0),
    index = lastIndex - (role === 'user' ? 1 : 0);
  const message: PromptHistoryMessage = {
    id: 'display',
    text,
    role,
    current: role === 'assistant',
  };
  return (
    await applyTextTransformBatch([
      { text, rules: rulesForMessage(config, 'display', message, index, lastIndex) },
    ])
  )[0]!;
}
