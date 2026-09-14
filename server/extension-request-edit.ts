import { createHash } from 'node:crypto';
import {
  BEHAVIOR_EDIT_MESSAGES_MAX,
  BEHAVIOR_EDIT_VALUE_MAX_CHARS,
} from '../core/package-behavior.js';
import type {
  ExtensionMessageEditReceipt,
  ExtensionRequestEditReceipt,
} from '../core/extension-request-edit.js';
import type { PromptHistoryMessage } from '../core/prompt-program.js';
import { sourceLogicalHistoryForRequest } from '../core/source-context.js';
import type { RunSnapshot } from '../core/types.js';
import { HttpError } from './request-validation.js';

/** Bounded by the guest input limit, so a long conversation is skipped instead of half sent. */
export const EXTENSION_REQUEST_EDIT_MAX_INPUT_CHARS = 100_000;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Risu hands an edit callback the text and its chat index; the host owns this shape. */
export function extensionEditHookInput(
  value: string,
  index = -1
): { value: string; meta: { index: number } } {
  return { value, meta: { index } };
}
/** Position of this turn's response in the conversation a guest may read. */
export function responseMessageIndex(snapshot: {
  logicalHistory?: unknown[];
  history: unknown[];
}): number {
  return (snapshot.logicalHistory ?? snapshot.history).length + 1;
}
function reject(): never {
  throw new HttpError(400, 'EXTENSION_REQUEST_EDIT_INVALID');
}

export function validateExtensionRequestEditShape(receipt: ExtensionRequestEditReceipt): void {
  if (
    !receipt ||
    receipt.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(receipt.inputHash) ||
    !/^[a-f0-9]{64}$/u.test(receipt.outputHash) ||
    !Array.isArray(receipt.applied) ||
    !receipt.applied.length ||
    receipt.applied.length > 100 ||
    receipt.applied.some((id) => typeof id !== 'string' || !id.length || id.length > 300) ||
    new Set(receipt.applied).size !== receipt.applied.length ||
    Object.keys(receipt).some(
      (key) => !['version', 'inputHash', 'outputHash', 'text', 'applied'].includes(key)
    )
  )
    reject();
  if (
    typeof receipt.text !== 'string' ||
    receipt.text.length > BEHAVIOR_EDIT_VALUE_MAX_CHARS ||
    hash(receipt.text) !== receipt.outputHash ||
    receipt.inputHash === receipt.outputHash
  )
    reject();
}

/** The transmitted copy of the current request. The stored request and its hash stay original. */
export function projectExtensionRequestEdit(snapshot: RunSnapshot): {
  text: string;
  changed: boolean;
  applied: string[];
} {
  const receipt = snapshot.extensionRequestEdit;
  if (!receipt) return { text: snapshot.request, changed: false, applied: [] };
  validateExtensionRequestEditShape(receipt);
  if (receipt.inputHash !== hash(snapshot.request)) reject();
  return { text: receipt.text!, changed: true, applied: [...receipt.applied] };
}

/** Builds the derived receipt from the recorded hook chain; an unchanged chain records nothing. */
export function buildExtensionRequestEdit(
  request: string,
  chain: { id: string; text: string }[]
): ExtensionRequestEditReceipt | undefined {
  const applied: string[] = [];
  let text = request;
  for (const step of chain) {
    if (step.text !== text) applied.push(step.id);
    text = step.text;
  }
  if (text === request) return undefined;
  const receipt: ExtensionRequestEditReceipt = {
    version: 1,
    inputHash: hash(request),
    outputHash: hash(text),
    text,
    applied,
  };
  validateExtensionRequestEditShape(receipt);
  return receipt;
}

/** The transmittable conversation and the current request, before any send-time message edit. */
export function requestEditMessages(
  snapshot: RunSnapshot,
  request: string
): PromptHistoryMessage[] {
  return sourceLogicalHistoryForRequest(snapshot, [
    ...(snapshot.logicalHistory ??
      snapshot.history.map((entry) => ({
        id: `source:${entry.revision}`,
        role: 'assistant' as const,
        text: entry.text,
        sourceRevision: entry.revision,
        ...(entry.contentHash ? { sourceHash: entry.contentHash } : {}),
      }))),
    { id: 'current-input', role: 'user' as const, text: request, current: true },
  ]);
}

/** The exact bounded value a request hook receives, or undefined when it cannot be handed over. */
export function extensionEditRequestInput(
  messages: PromptHistoryMessage[]
):
  | { value: { role: 'user' | 'assistant'; content: string }[]; meta: Record<string, never> }
  | undefined {
  if (messages.length > BEHAVIOR_EDIT_MESSAGES_MAX) return undefined;
  if (messages.some((message) => message.text.length > BEHAVIOR_EDIT_VALUE_MAX_CHARS))
    return undefined;
  const input = {
    value: messages.map((message) => ({ role: message.role, content: message.text })),
    meta: {},
  };
  if (JSON.stringify(input).length > EXTENSION_REQUEST_EDIT_MAX_INPUT_CHARS) return undefined;
  return input;
}

export function validateExtensionMessageEditShape(receipt: ExtensionMessageEditReceipt): void {
  if (
    !receipt ||
    receipt.version !== 1 ||
    !Array.isArray(receipt.entries) ||
    receipt.entries.length > BEHAVIOR_EDIT_MESSAGES_MAX ||
    !Array.isArray(receipt.applied) ||
    receipt.applied.length > 100 ||
    receipt.applied.some((id) => typeof id !== 'string' || !id.length || id.length > 300) ||
    new Set(receipt.applied).size !== receipt.applied.length ||
    (receipt.skipped !== undefined && receipt.skipped !== true) ||
    (!receipt.applied.length && (receipt.skipped !== true || receipt.entries.length)) ||
    Object.keys(receipt).some((key) => !['version', 'entries', 'applied', 'skipped'].includes(key))
  )
    reject();
  for (const [index, entry] of receipt.entries.entries()) {
    if (!entry) reject();
    if (
      entry.index !== index ||
      !['user', 'assistant'].includes(entry.role) ||
      !/^[a-f0-9]{64}$/u.test(entry.inputHash) ||
      !/^[a-f0-9]{64}$/u.test(entry.outputHash) ||
      Object.keys(entry).some(
        (key) => !['index', 'role', 'inputHash', 'outputHash', 'text'].includes(key)
      )
    )
      reject();
    if (entry.text === undefined) {
      if (entry.inputHash !== entry.outputHash) reject();
    } else if (
      typeof entry.text !== 'string' ||
      entry.text.length > BEHAVIOR_EDIT_VALUE_MAX_CHARS ||
      hash(entry.text) !== entry.outputHash
    )
      reject();
  }
}

/** Projects the stored calculation onto any transmitted subset; original indices stay frozen. */
export function projectExtensionMessageEdits(
  snapshot: RunSnapshot,
  history: PromptHistoryMessage[]
): { history: PromptHistoryMessage[]; warnings: string[] } {
  const receipt = snapshot.extensionMessageEdit;
  if (!receipt) return { history, warnings: [] };
  validateExtensionMessageEditShape(receipt);
  // A partial skip still applies what did run, and still says a hook was left out.
  const warnings = [
    ...(receipt.applied.length ? ['EXTENSION_MESSAGE_EDIT_APPLIED'] : []),
    ...(receipt.skipped ? ['EXTENSION_MESSAGE_EDIT_SKIPPED'] : []),
  ];
  if (!receipt.entries.length) return { history, warnings };
  const indices = new Map(
    requestEditMessages(snapshot, projectExtensionRequestEdit(snapshot).text).map(
      (message, index) => [message.id, index]
    )
  );
  if (indices.size !== receipt.entries.length) reject();
  return {
    history: history.map((message) => {
      const index = indices.get(message.id);
      const entry = index === undefined ? undefined : receipt.entries[index];
      if (!entry) reject();
      if (entry.role !== message.role || entry.inputHash !== hash(message.text)) reject();
      return entry.text === undefined ? message : { ...message, text: entry.text };
    }),
    warnings,
  };
}

/** Builds the derived receipt from the recorded hook chain over the transmitted messages. */
export function buildExtensionMessageEdit(
  base: PromptHistoryMessage[],
  chain: { id: string; texts: string[] }[],
  skipped: boolean
): ExtensionMessageEditReceipt | undefined {
  const applied: string[] = [];
  let texts = base.map((message) => message.text);
  for (const step of chain) {
    if (step.texts.length !== texts.length) reject();
    if (step.texts.some((text, index) => text !== texts[index])) applied.push(step.id);
    texts = step.texts;
  }
  if (!applied.length)
    return skipped ? { version: 1, entries: [], applied: [], skipped: true } : undefined;
  const receipt: ExtensionMessageEditReceipt = {
    version: 1,
    entries: base.map((message, index) => ({
      index,
      role: message.role,
      inputHash: hash(message.text),
      outputHash: hash(texts[index]),
      ...(texts[index] === message.text ? {} : { text: texts[index] }),
    })),
    applied,
    ...(skipped ? { skipped: true as const } : {}),
  };
  validateExtensionMessageEditShape(receipt);
  return receipt;
}
