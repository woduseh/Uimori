import { createHash } from 'node:crypto';
import type { ContentPackage, PackageAttachment } from '../core/content-package.js';
import { validateLoreContextPolicy } from '../core/lore-context.js';
import { generationFromModel } from '../core/model-capabilities.js';
import {
  LORE_SELECTION_LIMITS,
  loreSelectionKey,
  loreSelectionLore,
  type LoreSelectionEntry,
} from '../core/lore-selection.js';
import { compiledPackages } from '../core/package-context.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { Connection, ModelSnapshot } from '../core/product.js';
import {
  executeProvider,
  transportConnection,
  type ProviderRequest,
  type ProviderResult,
} from '../core/transport.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import type { MainHooks } from './model-runner.js';
import { connectionTestRequest } from './provider-connection-test.js';

/**
 * One auxiliary call per attached package in model mode. The step runs in the worker, after the
 * reservation froze the conversation and before the main input is measured, and never fails the Run:
 * an abandoned entry carries an `error` and decides nothing, so every lore keeps its own `loading`.
 */
export type LoreSelectionTarget = {
  snapshot: RunSnapshot;
  attachment: PackageAttachment;
  package: ContentPackage;
};
/** Bumping this invalidates every stored input hash, which is what a changed contract should do. */
const CONTRACT_VERSION = 'lore-selection-v1';
/** An id list stays short, so the answer needs far less room than a reply and never more than this. */
const SELECTION_MAX_OUTPUT_TOKENS = 1024;
const SELECTION_CONTRACT =
  'You select reference entries for a fiction writing assistant. Input: a catalog of entries (id, title, summary, chars), the recent conversation, the current request and a character budget. Return ONLY JSON: {"selected": [ids in order of importance]}. Choose entries whose content the next reply needs; prefer fewer, more relevant entries; keep the total chars near or under the budget; return an empty list when none apply. Ids must come from the catalog.';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const emptyUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
function addUsage(total: Usage, result: ProviderResult) {
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const)
    total[key] =
      total[key] === null || result.usage[key] === null ? null : total[key] + result.usage[key];
}

/**
 * Every attached package this snapshot owes a selection for, in attachment order: the ones in model
 * mode that still offer at least one discoverable entry. Preparation asks about these; archive
 * validation recomputes their input hashes and rejects any receipt key outside the set.
 */
export function loreSelectionTargets(snapshot: RunSnapshot): LoreSelectionTarget[] {
  const profile = snapshot.profile;
  const targets: LoreSelectionTarget[] = [];
  for (const attachment of profile?.packageAttachments ?? []) {
    if (historicalPersonaExcluded(profile, attachment.role, 'main')) continue;
    const pkg = profile?.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
    if (!pkg || !loreSelectionLore(pkg).length) continue;
    if (targets.length >= LORE_SELECTION_LIMITS.entries) return targets;
    targets.push({ snapshot, attachment, package: pkg });
  }
  return targets;
}

/**
 * A main `run` reservation that still owes the selection call. Authored openings and transcript
 * imports never ask, so their lore follows `loading` exactly as before; a snapshot that already
 * carries the receipt - a candidate's copy, a retry re-entering the worker - is never asked again.
 */
export function loreSelectionPending(snapshot: RunSnapshot): boolean {
  if (snapshot.loreSelection !== undefined) return false;
  if (snapshot.packageStart?.mode === 'authored' || snapshot.transcriptImport !== undefined)
    return false;
  return loreSelectionTargets(snapshot).length > 0;
}

type Candidate = { id: string; title: string; summary: string; chars: number };
/**
 * The catalog as the model reads it. The text is the one this snapshot's own compilation renders, so
 * `chars` counts exactly what pinning the entry would send.
 */
function candidateCatalog(target: LoreSelectionTarget): {
  catalog: Candidate[];
  partial?: 'catalog';
} {
  const compiled = compiledPackages(target.snapshot, 'main').find(
    (item) =>
      item.attachment.id === target.attachment.id &&
      item.attachment.revision === target.attachment.revision &&
      item.attachment.role === target.attachment.role
  );
  const rendered = new Map<string, string>();
  for (const resource of compiled?.resources ?? []) {
    if (resource.sourceKind !== 'lore') continue;
    const marker = resource.id.lastIndexOf(':lore:');
    if (marker < 0) continue;
    const id = resource.id.slice(marker + ':lore:'.length);
    if (!rendered.has(id)) rendered.set(id, resource.text);
  }
  const catalog = loreSelectionLore(target.package)
    .slice(0, LORE_SELECTION_LIMITS.ids)
    .map((lore) => {
      const text = rendered.get(lore.id) ?? lore.text;
      return {
        id: lore.id,
        title: lore.title,
        summary: (lore.description || text).slice(0, LORE_SELECTION_LIMITS.summaryChars),
        chars: text.length,
      };
    });
  let cut = false;
  while (catalog.length && JSON.stringify(catalog).length > LORE_SELECTION_LIMITS.catalogChars) {
    catalog.pop();
    cut = true;
  }
  return { catalog, ...(cut ? { partial: 'catalog' as const } : {}) };
}

/** The recent turns the model judges relevance against, cut to the limits it is told about. */
function recentConversation(snapshot: RunSnapshot): { role: string; text: string }[] {
  const logical = (snapshot.logicalHistory ?? []).filter((message) => !message.current);
  const messages = logical.length
    ? logical.map((message) => ({ role: message.role as string, text: message.text }))
    : snapshot.history.map((item) => ({ role: 'assistant', text: item.text }));
  return messages
    .slice(-LORE_SELECTION_LIMITS.historyMessages)
    .map(({ role, text }) => ({ role, text: text.slice(0, LORE_SELECTION_LIMITS.messageChars) }));
}

/**
 * Everything one selection reads, resolved from the reserved snapshot alone, plus the hash that binds
 * the entry to exactly these inputs. The run id is deliberately outside it, so a fork or a chat-backup
 * restore that copies the frozen receipt onto a new run id stays verifiable.
 */
function selectionInputs(target: LoreSelectionTarget) {
  const { catalog, partial } = candidateCatalog(target);
  const policy = validateLoreContextPolicy(target.snapshot.profile?.loreContext);
  const conversation = recentConversation(target.snapshot);
  const request = (target.snapshot.request ?? '').slice(0, LORE_SELECTION_LIMITS.requestChars);
  const model = target.snapshot.profile?.contextModel?.modelId ?? null;
  const payload = {
    budget: policy.maxRetainedChars,
    maxEntries: policy.maxRetainedEntries,
    catalog,
    conversation,
    request,
  };
  const inputHash = sha256(
    JSON.stringify({
      version: CONTRACT_VERSION,
      key: loreSelectionKey(target.attachment),
      package: { id: target.package.id, revision: target.package.revision },
      model,
      ...payload,
    })
  );
  return { key: loreSelectionKey(target.attachment), payload, partial, policy, inputHash };
}

/** The frozen inputs of one attached package's catalog, recomputed without asking the model again. */
export function loreSelectionInputHash(target: LoreSelectionTarget): string {
  return selectionInputs(target).inputHash;
}

/** Strip an optional ```json fence, then read the one field the contract asks for. */
function parsedSelection(text: string): string[] {
  const trimmed = text.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const value: unknown = JSON.parse(fence ? fence[1] : trimmed);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('LORE_SELECTION_OUTPUT_INVALID');
  const selected = (value as { selected?: unknown }).selected;
  if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string'))
    throw new Error('LORE_SELECTION_OUTPUT_INVALID');
  return selected as string[];
}

function selectionRequest(
  model: ModelSnapshot,
  connection: Connection,
  task: unknown
): ProviderRequest {
  const request = connectionTestRequest(model, connection);
  const generation = request.generation!;
  request.role = 'context';
  // The connection-test shell caps the answer at 256 output tokens, which a list of a few dozen ids
  // can outgrow and then parse as invalid. Raise it to the selection ceiling, never past the preset.
  request.generation = {
    ...generation,
    maxOutputTokens: Math.min(
      SELECTION_MAX_OUTPUT_TOKENS,
      generationFromModel(model).maxOutputTokens
    ),
  };
  request.stable = { contract: SELECTION_CONTRACT, tools: [] };
  request.input = { task: JSON.stringify(task), controls: {} };
  return request;
}

/**
 * Trim the model's order to the chat's 조회 로어 문자 한도. Ids outside the catalog are recorded as
 * `unknown` rather than dropped silently, and a duplicate decides nothing beyond its first mention.
 */
function trimSelection(
  answer: readonly string[],
  catalog: readonly Candidate[],
  budget: number,
  maxEntries: number
): Pick<LoreSelectionEntry, 'selected' | 'omitted'> {
  const sizes = new Map(catalog.map((item) => [item.id, item.chars]));
  const selected: string[] = [];
  const omitted: LoreSelectionEntry['omitted'] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const id of answer.slice(0, LORE_SELECTION_LIMITS.ids)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const size = sizes.get(id);
    if (size === undefined) {
      omitted.push({ id, reason: 'unknown' });
      continue;
    }
    if (selected.length >= maxEntries || chars + size > budget) {
      omitted.push({ id, reason: 'budget' });
      continue;
    }
    selected.push(id);
    chars += size;
  }
  return { selected, omitted };
}

async function selectOne(
  target: LoreSelectionTarget,
  hooks: MainHooks,
  usage: Usage,
  reserveCalls: number
): Promise<LoreSelectionEntry> {
  const { key, payload, partial, policy, inputHash } = selectionInputs(target);
  const base: LoreSelectionEntry = {
    key,
    inputHash,
    budget: policy.maxRetainedChars,
    selected: [],
    omitted: [],
    ...(partial ? { partial } : {}),
  };
  const abandoned = (error: string): LoreSelectionEntry => ({ ...base, error });
  const model = structuredClone(target.snapshot.profile?.contextModel);
  if (!model) return abandoned('MODEL_REQUIRED:context');
  if (model.enabled === false) return abandoned('CONTEXT_SUMMARY_MODEL_DISABLED');
  const maxCalls = target.snapshot.settings.maxCalls;
  // The main call and every call the Run already spent stay reserved: the selection is optional
  // work, the reply is not. `usage` counts only this step, so the caller passes the rest in.
  if (!Number.isSafeInteger(maxCalls) || usage.modelCalls >= maxCalls - reserveCalls)
    return abandoned('LORE_SELECTION_CALL_LIMIT');
  // Cancellation is reported, never thrown: the caller settles the accounting of the call this step
  // already made and then stops the Run through its own cancellation check.
  if (hooks.signal.aborted) return abandoned('LORE_SELECTION_CANCELLED');

  let connection: Connection;
  try {
    connection = await hooks.authorize(structuredClone(model.connection));
  } catch {
    return abandoned('CONNECTION_NOT_AUTHORIZED');
  }
  if (
    !connection.enabled ||
    connection.id !== model.connectionId ||
    connection.protocol !== model.connection.protocol ||
    connection.endpoint !== model.connection.endpoint ||
    connection.credentialEnv !== model.connection.credentialEnv
  )
    return abandoned('CONNECTION_NOT_AUTHORIZED');

  let attempt: string | undefined;
  let result: ProviderResult;
  try {
    result = await executeProvider(
      transportConnection(connection),
      selectionRequest(model, connection, payload),
      {
        approvedOrigins: hooks.approvedOrigins,
        signal: hooks.signal,
        resolveCredential: hooks.resolveCredential,
        executeCodex: hooks.executeCodex,
        timeoutMs: hooks.timeoutMs ?? model.timeoutMs,
        vertexRequestTier: hooks.vertexRequestTier,
        onWire: async (wire) => {
          attempt = await hooks.onAttemptStart(wire);
          usage.modelCalls++;
        },
      }
    );
  } catch {
    result = {
      status: hooks.signal.aborted ? 'cancelled' : 'error',
      text: '',
      toolCalls: [],
      refusal: null,
      error: {
        code: hooks.signal.aborted
          ? 'LORE_SELECTION_CANCELLED'
          : 'LORE_SELECTION_PROVIDER_EXECUTION_FAILED',
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        raw: null,
        priceRevision: null,
      },
      opaqueState: null,
    };
  }
  if (attempt !== undefined) {
    addUsage(usage, result);
    try {
      await hooks.onAttemptFinish(attempt, { ...structuredClone(result), opaqueState: null });
    } catch {
      return abandoned('LORE_SELECTION_ATTEMPT_FINISH_FAILED');
    }
  }
  const decided = { ...base, model: model.modelId };
  if (hooks.signal.aborted || result.status === 'cancelled')
    return { ...decided, error: 'LORE_SELECTION_CANCELLED' };
  if (result.status !== 'completed' || result.error || result.refusal || !result.text.trim())
    return { ...decided, error: result.error?.code ?? 'LORE_SELECTION_PROVIDER_ERROR' };
  let answer: string[];
  try {
    answer = parsedSelection(result.text);
  } catch {
    return { ...decided, error: 'LORE_SELECTION_OUTPUT_INVALID' };
  }
  return {
    ...decided,
    ...trimSelection(answer, payload.catalog, policy.maxRetainedChars, policy.maxRetainedEntries),
  };
}

/**
 * Ask the chat's 문맥 정리 모델 which discoverable lore this turn needs, once per attached package in
 * model mode, and return the snapshot carrying the frozen answer. `reserveCalls` is the number of
 * calls the Run still owes outside this step - the main turn plus everything it already spent - so
 * the selection never takes the last slot. The caller persists the receipt and merges the usage so
 * the compaction step's own `reserveCalls` counts these calls.
 */
export async function prepareLoreSelection(
  snapshot: RunSnapshot,
  hooks: MainHooks,
  options: { reserveCalls: number }
): Promise<{ snapshot: RunSnapshot; usage: Usage }> {
  const usage = emptyUsage();
  if (!loreSelectionPending(snapshot)) return { snapshot, usage };
  const entries: LoreSelectionEntry[] = [];
  for (const target of loreSelectionTargets(snapshot))
    entries.push(await selectOne(target, hooks, usage, options.reserveCalls));
  return { snapshot: { ...snapshot, loreSelection: { version: 1, entries } }, usage };
}
