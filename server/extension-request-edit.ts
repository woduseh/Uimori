import { createHash } from 'node:crypto';
import { BEHAVIOR_EDIT_VALUE_MAX_CHARS } from '../core/package-behavior.js';
import type { ExtensionRequestEditReceipt } from '../core/extension-request-edit.js';
import type { RunSnapshot } from '../core/types.js';
import { HttpError } from './request-validation.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Risu hands an edit callback the submitted text and its chat index; the host owns this shape. */
export function extensionEditHookInput(value: string): {
  value: string;
  meta: { index: number };
} {
  return { value, meta: { index: -1 } };
}
const reject = (): never => {
  throw new HttpError(400, 'EXTENSION_REQUEST_EDIT_INVALID');
};

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
