import {
  activateLore,
  type LoreActivationMessage,
} from '../../../third_party/risuai/cad8595a/lore-activation.js';
import type { loreBook } from '../../../third_party/risuai/cad8595a/types.js';
import type { ContentPackage, PackageAttachment } from '../../../core/content-package.js';
import {
  LORE_ACTIVATION_LIMITS,
  loreActivationKey,
  loreActivationLore,
  projectLoreActivationReceipt,
  type LoreActivationEntry,
  type LoreActivationReceipt,
} from '../../../core/lore-activation.js';
import { validateLoreContextPolicy } from '../../../core/lore-context.js';
import { historicalPersonaExcluded } from '../../../core/persona-scope.js';
import { resolveTemplateVariableContext } from '../../../core/template-variables.js';
import type { RunSnapshot } from '../../../core/types.js';
import { seededRandom, sha256 } from './entropy.js';

export { projectLoreActivationReceipt };

/** Everything one scan may read. All of it comes from the reserved snapshot. */
export type LoreActivationContext = {
  snapshot: RunSnapshot;
  attachment: PackageAttachment;
  package: ContentPackage;
  runId: string;
};

/**
 * Everything one scan reads, resolved from the reserved snapshot alone, plus the hash that binds the
 * entry to exactly these inputs. Archive validation recomputes the hash through this same function, so
 * the canonical JSON below is the single definition of what a package's lorebook was scanned over.
 */
function activationInputs(context: LoreActivationContext) {
  const { snapshot, attachment, package: pkg, runId } = context;
  const key = loreActivationKey(attachment);
  const seed = sha256(`${runId}:lore:${key}`);
  // The engine reads the stored text, not the compat-evaluated one: a keyword has to be searched for
  // in the material the package holds, and the same text is what the budget counts.
  const entries: loreBook[] = loreActivationLore(pkg).map((lore) => {
    const rule = lore.activation!;
    return {
      key: rule.keys,
      secondkey: rule.secondaryKeys ?? '',
      insertorder: lore.loreContext?.order ?? 0,
      comment: lore.title,
      content: rule.rules ? `${rule.rules}\n${lore.text}` : lore.text,
      mode: rule.child ? ('child' as const) : ('normal' as const),
      alwaysActive: lore.loading === 'pinned',
      selective: rule.selective === true,
      useRegex: rule.regex === true,
      id: lore.id,
    };
  });
  // The same history projection the CBS evaluator uses: the chat's written turns, then the reserved
  // request as the turn being answered.
  const messages: LoreActivationMessage[] = [
    ...snapshot.history.map((entry) => ({ role: 'char' as const, data: entry.text })),
    ...(snapshot.request ? [{ role: 'user' as const, data: snapshot.request }] : []),
  ];
  // The activation budget is the chat's 조회 로어 문자 한도, counted in characters. Risu's own 800-token
  // default and the card's `token_budget` are deliberately not used.
  const policy = validateLoreContextPolicy(snapshot.profile?.loreContext);
  const settings = {
    scanDepth: pkg.loreActivation?.scanDepth ?? 5,
    tokenBudget: policy.maxRetainedChars,
    recursiveScanning: pkg.loreActivation?.recursiveScanning ?? true,
    fullWordMatching: pkg.loreActivation?.fullWordMatching ?? false,
  };
  // The run id seeds the entropy but is deliberately outside the hash: a fork or a chat-backup restore
  // copies the frozen receipt onto a new run id, and the hash has to keep binding the content the
  // snapshot froze so those copies stay verifiable.
  const inputHash = sha256(
    JSON.stringify({
      entries: entries.map((entry) => ({ ...entry, content: sha256(entry.content) })),
      history: messages.map((message) => ({ role: message.role, text: sha256(message.data) })),
      settings,
    })
  );
  return { key, seed, entries, messages, settings, inputHash };
}

/** The frozen inputs of one attached package's lorebook, recomputed without scanning anything. */
export function loreActivationInputHash(context: LoreActivationContext): string {
  return activationInputs(context).inputHash;
}

/** Scans one attached package's lorebook against the reserved snapshot and returns its frozen entry. */
export function evaluateLoreActivation(context: LoreActivationContext): LoreActivationEntry {
  const { key, seed, entries, messages, settings, inputHash } = activationInputs(context);
  const budget = settings.tokenBudget;
  const variables =
    resolveTemplateVariableContext(context.snapshot.profile, 'main').variables ?? {};
  try {
    const result = activateLore(
      { entries, messages, settings },
      {
        // The budget is a character limit, so one "token" is one UTF-16 code unit.
        estimateTokens: (text) => text.length,
        random: seededRandom(seed),
        // `__internal_ka_*` / `__internal_da_*` are read, never written back: see `partial` below.
        getChatVar: (name) => (Object.hasOwn(variables, name) ? variables[name] : ''),
      }
    );
    return {
      key,
      inputHash,
      budget,
      activated: result.activated.map((lore) => entries[lore.index].id!),
      omitted: result.omitted.map((lore) => ({ id: entries[lore.index].id!, reason: lore.reason })),
      // The engine's activation-memory writes are reported, not persisted, so a replay of this run
      // sees the same variables the scan saw.
      ...(result.variableWrites.length ? { partial: 'variable-write' as const } : {}),
    };
  } catch (error) {
    // An abandoned scan makes no decision at all: compilation falls back to each entry's `loading`.
    return {
      key,
      inputHash,
      budget,
      activated: [],
      omitted: [],
      partial: 'error',
      error: (error instanceof Error ? error.message : 'LORE_ACTIVATION_FAILED').slice(0, 400),
    };
  }
}

/**
 * Every attached package this snapshot owes a scan for, in attachment order: the ones in keyword mode
 * that carry at least one preserved rule. Preparation scans these; archive validation recomputes their
 * input hashes and rejects any receipt key outside the set.
 */
export function loreActivationTargets(
  snapshot: RunSnapshot,
  runId: string
): LoreActivationContext[] {
  const profile = snapshot.profile;
  const targets: LoreActivationContext[] = [];
  for (const attachment of profile?.packageAttachments ?? []) {
    if (historicalPersonaExcluded(profile, attachment.role, 'main')) continue;
    const pkg = profile?.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
    if (!pkg || !loreActivationLore(pkg).length) continue;
    if (targets.length >= LORE_ACTIVATION_LIMITS.entries) return targets;
    targets.push({ snapshot, attachment, package: pkg, runId });
  }
  return targets;
}

/**
 * Every attached keyword-mode lorebook, scanned once. A pure function of the reserved snapshot and the
 * run id; the caller decides where the receipt is stored.
 */
export function prepareLoreActivationReceipt(
  snapshot: RunSnapshot,
  runId: string
): LoreActivationReceipt | undefined {
  const entries = loreActivationTargets(snapshot, runId).map(evaluateLoreActivation);
  return entries.length ? { version: 1, entries } : undefined;
}
