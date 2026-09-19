import { createHash } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';
import { nativeRisuFieldKey } from '../core/risu-native-execution.js';
import { validateChatVariableValues } from '../core/chat-variables.js';
import {
  nativeRisuContext,
  nativeRisuPackages,
  nativeRisuSessionKey,
} from './risu-native-context.js';
import { executeRisuNative, type NativeRisuExecutionOptions } from './risu-native-runtime.js';
import { evaluateNativeRisuFields } from './risu-native-cbs.js';
import { processNativeRisuText } from './risu-native-render.js';
import { prepareNativeRisuPreset, nativeRisuPresetPending } from './risu-native-preset.js';
import type { NativeRisuMessage } from '../core/risu-native-execution.js';
import { projectRisuImageHandoff } from '../core/risu-image-handoff.js';
import { validateProviderPrompt } from '../core/risu-prompt.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';

export function nativeHistoryRevision(
  before: NativeRisuMessage[],
  after: NativeRisuMessage[],
  revision?: string
) {
  const semantic = (messages: NativeRisuMessage[]) =>
    messages
      .filter((entry) => !['current-input', 'current-output'].includes(entry.id ?? ''))
      .map(({ role, data }) => ({ role, data }));
  const left = JSON.stringify(semantic(before)),
    right = JSON.stringify(semantic(after));
  return left === right
    ? revision
    : createHash('sha256')
        .update(JSON.stringify({ previous: revision ?? null, before: left, after: right }))
        .digest('hex');
}

export const nativeRisuPending = (snapshot: RunSnapshot) =>
  (nativeRisuPackages(snapshot).length > 0 ||
    !!snapshot.profile?.promptPresets?.main?.program.nativeRisuPreset) &&
  !snapshot.nativeRisuExecution;

export function nativeRisuInputHash(snapshot: RunSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        packages: nativeRisuPackages(snapshot).map(({ attachment, pkg }) => [attachment, pkg]),
        variables: snapshot.profile?.variableState,
        identity: snapshot.profile ? packageIdentityFromProfile(snapshot.profile) : null,
        image: snapshot.profile?.image,
        preset: snapshot.profile?.promptPresets?.main,
        promptControls: snapshot.profile?.promptControls,
        historyRevision: snapshot.nativeRisuHistoryRevision,
        request: snapshot.request,
        history: snapshot.logicalHistory ?? snapshot.history,
        clock: snapshot.executionClock,
      })
    )
    .digest('hex');
}

export function validateNativeRisuExecution(snapshot: RunSnapshot): void {
  const receipt = snapshot.nativeRisuExecution;
  if (!receipt) return;
  const fail = () => {
    throw new Error('RISU_NATIVE_RECEIPT_MISMATCH');
  };
  if (
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.version !== 1 ||
    receipt.inputHash !== nativeRisuInputHash(snapshot) ||
    receipt.beforeVariableRevision !== (snapshot.profile?.variableState?.revision ?? 0) ||
    typeof receipt.request !== 'string' ||
    !Array.isArray(receipt.messages) ||
    !Array.isArray(receipt.history) ||
    !Array.isArray(receipt.issues) ||
    receipt.issues.some((issue) => typeof issue !== 'string') ||
    !receipt.fields ||
    typeof receipt.fields !== 'object' ||
    Array.isArray(receipt.fields)
  )
    fail();
  validateChatVariableValues(receipt.variables);
  const originals = new Map(
    (snapshot.logicalHistory ?? []).map((message) => [message.id, message])
  );
  const checkMessageId = (id: string) => {
    if (/^(?:source|request|native):/u.test(id) && !originals.has(id)) fail();
  };
  const checkMessages = (messages: NativeRisuMessage[]) => {
    if (!Array.isArray(messages)) return fail();
    const ids = new Set<string>();
    for (const message of messages) {
      if (
        !message ||
        !['char', 'user'].includes(message.role) ||
        typeof message.data !== 'string' ||
        message.data.length > 2_000_000
      )
        fail();
      if (message.id !== undefined) {
        if (
          typeof message.id !== 'string' ||
          !message.id ||
          message.id.length > 500 ||
          ids.has(message.id)
        )
          fail();
        ids.add(message.id);
        checkMessageId(message.id);
      }
    }
  };
  checkMessages(receipt.messages);
  const historyIds = new Set<string>();
  for (const message of receipt.history) {
    if (
      !message ||
      typeof message.id !== 'string' ||
      historyIds.has(message.id) ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.text !== 'string'
    )
      fail();
    historyIds.add(message.id);
    checkMessageId(message.id);
    const original = originals.get(message.id);
    for (const key of ['sourceRevision', 'sourceHash', 'runId', 'sourceKind', 'current'] as const)
      if (message[key] !== original?.[key]) fail();
  }
  if (receipt.preRequest) {
    validateChatVariableValues(receipt.preRequest.variables);
    checkMessages(receipt.preRequest.messages);
    if (
      !Array.isArray(receipt.preRequest.messages) ||
      receipt.preRequest.messages.some(
        (message) => !['char', 'user'].includes(message.role) || typeof message.data !== 'string'
      )
    )
      fail();
    if (
      receipt.preRequest.historyRevision !== undefined &&
      !/^[a-f0-9]{64}$/u.test(receipt.preRequest.historyRevision)
    )
      fail();
  }
  for (const revision of [
    receipt.historyRevision,
    receipt.inputHistoryRevision,
    snapshot.nativeRisuHistoryRevision,
  ])
    if (revision !== undefined && !/^[a-f0-9]{64}$/u.test(revision)) fail();
  const expected = nativeRisuPackages(snapshot);
  if (Object.keys(receipt.fields).length !== expected.length) fail();
  for (const { attachment, pkg } of expected) {
    const fields = receipt.fields[nativeRisuFieldKey(attachment)];
    const names = [
      'body',
      ...pkg.lore.map((item) => `lore:${item.id}`),
      ...pkg.instructions.map((item) => `instruction:${item.id}`),
    ].sort();
    if (
      !fields ||
      JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify(names) ||
      Object.values(fields).some((item) => typeof item !== 'string')
    )
      fail();
  }
  for (const message of [...receipt.messages, ...(receipt.output?.messages ?? [])])
    if (
      !['char', 'user'].includes(message.role) ||
      typeof message.data !== 'string' ||
      message.data.length > 2_000_000
    )
      fail();
  if (receipt.output) {
    validateChatVariableValues(receipt.output.variables);
    if (typeof receipt.output.text !== 'string' || !Array.isArray(receipt.output.messages)) fail();
    checkMessages(receipt.output.messages);
  }
  if (receipt.requestEdits !== undefined) {
    if (!Array.isArray(receipt.requestEdits) || receipt.requestEdits.length > 1000) fail();
    for (const edit of receipt.requestEdits) {
      if (!edit || !/^[a-f0-9]{64}$/u.test(edit.inputHash)) fail();
      validateProviderPrompt(edit.prompt);
    }
  }
  if (JSON.stringify(receipt).length > 24 * 1024 * 1024) fail();
}

/** Async authored code runs once outside storage transactions. Compilers consume this receipt. */
export async function prepareNativeRisuRun(
  snapshot: RunSnapshot,
  options: NativeRisuExecutionOptions & { preview?: boolean } = {}
): Promise<RunSnapshot> {
  if (!nativeRisuPending(snapshot))
    return nativeRisuPresetPending(snapshot) ? prepareNativeRisuPreset(snapshot) : snapshot;
  const context = nativeRisuContext(snapshot)!;
  const execution = {
    ...options,
    sessionKey: options.sessionKey ?? nativeRisuSessionKey(snapshot),
  };
  let variables = context.variables;
  let messages = context.messages;
  const issues: string[] = [];
  if (options.preview) issues.push('RISU_NATIVE_PREVIEW_CALLBACKS_DEFERRED');
  const invoke = async (event: 'input' | 'editInput' | 'start', text?: string) => {
    // Preview evaluates fields/regex against copies, without paid or stateful callbacks.
    if (options.preview) return { text };
    const result = await executeRisuNative(
      { ...context, variables, messages, event, ...(text !== undefined ? { text } : {}) },
      execution
    );
    variables = result.variables;
    messages = result.messages;
    issues.push(...result.warnings);
    if (result.effects.stopChat) throw new Error('RISU_NATIVE_STOP_SENDING');
    return result;
  };
  // Risu's input trigger runs before the new user message enters chat.message.
  await invoke('input');
  const input = await invoke('editInput', snapshot.request);
  const edited = await processNativeRisuText({
    native: context.native,
    text: input.text ?? snapshot.request,
    context: { ...context, variables, messages, messageIndex: messages.length },
    mode: 'editinput',
  });
  variables = edited.variables;
  issues.push(...edited.issues);
  messages.push({ id: 'current-input', role: 'user', data: edited.text });
  await invoke('start');
  const fields: Record<string, Record<string, string>> = {};
  for (const { attachment, pkg } of nativeRisuPackages(snapshot)) {
    const projected = projectRisuImageHandoff(pkg, snapshot.profile?.image === true);
    const authored = {
      body: projected.body ?? '',
      ...Object.fromEntries(projected.lore.map((entry) => [`lore:${entry.id}`, entry.text])),
      ...Object.fromEntries(
        projected.instructions.map((entry) => [`instruction:${entry.id}`, entry.text])
      ),
    };
    const evaluated = await evaluateNativeRisuFields({
      native: context.native,
      fields: authored,
      context: { ...context, variables, messages },
    });
    fields[nativeRisuFieldKey(attachment)] = evaluated.fields;
    variables = evaluated.variables;
    issues.push(...evaluated.issues);
  }
  const original = new Map((snapshot.logicalHistory ?? []).map((message) => [message.id, message]));
  const history: NonNullable<RunSnapshot['logicalHistory']> = [];
  const greeting = snapshot.logicalHistory?.find((entry) => entry.sourceKind === 'authored-start');
  if (greeting) {
    const result = await processNativeRisuText({
      native: context.native,
      text: greeting.text,
      context: { ...context, variables, messages, messageIndex: -1 },
      mode: 'editprocess',
    });
    history.push({ ...greeting, text: result.text });
    variables = result.variables;
    issues.push(...result.issues);
  }
  let request = '';
  for (const [index, message] of messages.entries()) {
    const processed = await processNativeRisuText({
      native: context.native,
      text: message.data,
      context: { ...context, variables, messages, messageIndex: index },
      mode: 'editprocess',
    });
    variables = processed.variables;
    issues.push(...processed.issues);
    if (message.id === 'current-input') {
      request = processed.text;
      continue;
    }
    const prior = message.id ? original.get(message.id) : undefined;
    history.push({
      ...prior,
      id: message.id ?? `native-input:${index}`,
      role: message.role === 'char' ? 'assistant' : 'user',
      text: processed.text,
    });
  }
  validateChatVariableValues(variables);
  const prepared = {
    ...snapshot,
    nativeRisuExecution: {
      version: 1 as const,
      inputHash: nativeRisuInputHash(snapshot),
      beforeVariableRevision: snapshot.profile?.variableState?.revision ?? 0,
      variables,
      fields,
      request,
      history,
      messages,
      issues: [...new Set(issues)],
      historyRevision: nativeHistoryRevision(
        context.messages,
        messages,
        snapshot.nativeRisuHistoryRevision
      ),
      inputHistoryRevision: nativeHistoryRevision(
        context.messages,
        messages,
        snapshot.nativeRisuHistoryRevision
      ),
    },
  };
  delete prepared.promptCompilation;
  const result = await prepareNativeRisuPreset(prepared);
  if (result.nativeRisuPresetProgram)
    result.nativeRisuExecution!.variables = result.nativeRisuPresetProgram.variables;
  result.nativeRisuExecution!.preRequest = structuredClone({
    variables: result.nativeRisuExecution!.variables,
    messages: result.nativeRisuExecution!.messages,
    ...(result.nativeRisuExecution!.historyRevision
      ? { historyRevision: result.nativeRisuExecution!.historyRevision }
      : {}),
  });
  return result;
}

export async function prepareNativeRisuOutput(
  snapshot: RunSnapshot,
  text: string,
  options: NativeRisuExecutionOptions = {}
): Promise<RunSnapshot> {
  const receipt = snapshot.nativeRisuExecution;
  if (!receipt) return snapshot;
  if (receipt.output) return snapshot;
  const context = nativeRisuContext(snapshot)!;
  const execution = {
    ...options,
    sessionKey: options.sessionKey ?? nativeRisuSessionKey(snapshot),
  };
  const messages = [
    ...receipt.messages,
    { id: 'current-output', role: 'char' as const, data: text },
  ];
  const edited = await executeRisuNative(
    {
      ...context,
      variables: receipt.variables,
      messages,
      event: 'editOutput',
      text,
      meta: { index: messages.length - 1 },
    },
    execution
  );
  const processed = await processNativeRisuText({
    native: context.native,
    text: edited.text ?? text,
    context: {
      ...context,
      messages: edited.messages,
      variables: edited.variables,
      messageIndex: messages.length - 1,
    },
    mode: 'editoutput',
  });
  const outputMessages = edited.messages;
  const current = outputMessages.find((message) => message.id === 'current-output');
  if (current) current.data = processed.text;
  const output = await executeRisuNative(
    { ...context, variables: processed.variables, messages: outputMessages, event: 'output' },
    execution
  );
  validateChatVariableValues(output.variables);
  const value = output.messages.find((message) => message.id === 'current-output')?.data ?? '';
  return {
    ...snapshot,
    nativeRisuExecution: {
      ...receipt,
      historyRevision: nativeHistoryRevision(
        receipt.messages,
        output.messages,
        receipt.historyRevision
      ),
      output: { text: value, variables: output.variables, messages: output.messages },
      issues: [
        ...new Set([
          ...receipt.issues,
          ...edited.warnings,
          ...processed.issues,
          ...output.warnings,
        ]),
      ],
    },
  };
}
