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
import { prepareNativeRisuText } from './risu-native-prepare.js';
import { processNativeRisuText } from './risu-native-render.js';
import { prepareNativeRisuPreset, nativeRisuPresetPending } from './risu-native-preset.js';
import type { NativeRisuMessage } from '../core/risu-native-execution.js';
import { projectRisuImageHandoff, risuImageHandoffText } from '../core/risu-image-handoff.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { nativeExampleMessages } from '../core/risu-native-messages.js';

function exampleFields(snapshot: RunSnapshot, pkg: Parameters<typeof risuImageHandoffText>[0]) {
  const identity = packageIdentityFromProfile(snapshot.profile!);
  const text = snapshot.profile?.image
    ? risuImageHandoffText(pkg, 'card:mes_example')
    : String(pkg.nativeRisu?.card.mes_example ?? '');
  return Object.fromEntries(
    nativeExampleMessages(text, identity.bot.name, identity.user.name).map((message, index) => [
      `example:${index}`,
      message.text,
    ])
  );
}

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
  const fieldPlan: { key: string; fields: Record<string, string> }[] = [];
  for (const { attachment, pkg } of nativeRisuPackages(snapshot)) {
    const projected = projectRisuImageHandoff(pkg, snapshot.profile?.image === true);
    const authored = {
      body: projected.body ?? '',
      ...(attachment.role === 'bot' ? exampleFields(snapshot, projected) : {}),
      ...Object.fromEntries(projected.lore.map((entry) => [`lore:${entry.id}`, entry.text])),
    };
    fieldPlan.push({ key: nativeRisuFieldKey(attachment), fields: authored });
  }
  const original = new Map((snapshot.logicalHistory ?? []).map((message) => [message.id, message]));
  const history: NonNullable<RunSnapshot['logicalHistory']> = [];
  const greeting = snapshot.logicalHistory?.find((entry) => entry.sourceKind === 'authored-start');
  const processed = await prepareNativeRisuText(
    {
      native: context.native,
      context: { ...context, variables, messages },
      fields: fieldPlan,
      greeting: greeting?.text,
    },
    options.signal
  );
  const fields = processed.fields;
  variables = processed.variables;
  issues.push(...processed.issues);
  if (greeting) {
    history.push({ ...greeting, text: processed.greeting! });
  }
  let request = '';
  for (const [index, message] of messages.entries()) {
    if (message.id === 'current-input') {
      request = processed.texts[index];
      continue;
    }
    const prior = message.id ? original.get(message.id) : undefined;
    history.push({
      ...prior,
      id: message.id ?? `native-input:${index}`,
      role: message.role === 'char' ? 'assistant' : 'user',
      text: processed.texts[index],
    });
  }
  validateChatVariableValues(variables);
  const prepared = {
    ...snapshot,
    nativeRisuExecution: {
      version: 2 as const,
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
