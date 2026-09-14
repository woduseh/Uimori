import {
  createRisuCbs,
  type RisuCbsDeps,
} from '../../../third_party/risuai/cad8595a/cbs-parser.js';
import { seededRandom, sha256 } from './entropy.js';
import type { Database, LLMModel } from '../../../third_party/risuai/cad8595a/cbs-support.js';
import type { Chat, Message, character } from '../../../third_party/risuai/cad8595a/types.js';
import type { ContentPackage, PackageAttachment } from '../../../core/content-package.js';
import {
  RISU_COMPAT_LIMITS,
  projectRisuCompatReceipt,
  risuCompatFields,
  risuCompatKey,
  type RisuCompatEntry,
  type RisuCompatReceipt,
} from '../../../core/risu-compat.js';
import {
  packageIdentityFromContents,
  packageIdentityFromProfile,
} from '../../../core/package-identity.js';
import { historicalPersonaExcluded } from '../../../core/persona-scope.js';
import { resolveTemplateVariableContext } from '../../../core/template-variables.js';
import type { RunSnapshot } from '../../../core/types.js';

export { projectRisuCompatReceipt };

/** Risu looks a name up after lowercasing it and dropping spaces, underscores and hyphens. */
const normalizeName = (name: string) => name.toLocaleLowerCase().replace(/[\s_-]/gu, '');
const names = (...list: string[]): string[] => list.flatMap((name) => [name, normalizeName(name)]);

/**
 * CBS functions Uimori has nothing to answer with: Risu's display and asset elements, its module and
 * plugin surfaces, the preset fields Uimori does not copy, and every environment or model read. Each
 * one evaluates to an empty string and is listed on the entry, instead of reaching the model as
 * literal `{{...}}` text. The chat-variable writes (setvar/addvar/setdefaultvar) are deliberately not
 * here: they keep evaluating so a read after a write inside the same text sees the value.
 */
export const RISU_COMPAT_UNSUPPORTED_NAMES: ReadonlySet<string> = new Set(
  names(
    // Display and asset elements.
    'asset',
    'emotion',
    'audio',
    'bg',
    'bgm',
    'video',
    'video-img',
    'image',
    'img',
    'path',
    'raw',
    'inlay',
    'inlayed',
    'inlayeddata',
    'source',
    'chardisplayasset',
    'emotionlist',
    'assetlist',
    'file',
    'button',
    'hiddenkey',
    'tex',
    'latex',
    'katex',
    'ruby',
    'furigana',
    'codeblock',
    'bkspc',
    'erase',
    'position',
    // Modules and plugins.
    'moduleenabled',
    'module_enabled',
    'moduleassetlist',
    'module_assetlist',
    'lorebook',
    'worldinfo',
    'trigger_id',
    'getglobalvar',
    // Preset fields Uimori keeps in its own prompt, not on the card.
    'mainprompt',
    'systemprompt',
    'main_prompt',
    'jb',
    'jailbreak',
    'jbtoggled',
    'globalnote',
    'systemnote',
    'ujb',
    'authornote',
    'author_note',
    // Environment and model.
    'screenwidth',
    'screen_width',
    'screenheight',
    'screen_height',
    'browserlanguage',
    'model',
    'axmodel',
    'maxcontext',
    'metadata',
    'risu',
    'prefillsupported',
    'prefill_supported',
    'prefill'
  )
);

/** Everything one evaluation may read. All of it comes from the reserved snapshot. */
export type RisuCompatContext = {
  snapshot: RunSnapshot;
  attachment: PackageAttachment;
  package: ContentPackage;
  runId: string;
};

/** The end of the `{{...}}` token that starts at `start`, or -1 when it is never closed. */
function tokenEnd(source: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < source.length - 1; i++) {
    const pair = source.slice(i, i + 2);
    if (pair === '{{') {
      depth++;
      i++;
    } else if (pair === '}}') {
      depth--;
      if (!depth) return i + 2;
      i++;
    }
  }
  return -1;
}

/**
 * Upstream registers `{{//...}}` as documentation only, so the evaluator would leave it literal and
 * report it. Uimori treats it as a comment everywhere else, including the AST converter, so it is
 * removed before evaluation.
 */
export function stripRisuComments(source: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{{', cursor);
    if (start < 0) break;
    if (source.startsWith('{{//', start)) {
      const end = tokenEnd(source, start);
      if (end < 0) break;
      result += source.slice(cursor, start);
      cursor = end;
    } else {
      result += source.slice(cursor, start + 2);
      cursor = start + 2;
    }
  }
  return result + source.slice(cursor);
}

/** {{metadata::model*}} is on the unsupported list; this only keeps the dependency total. */
const MODEL_INFO: LLMModel = {
  id: 'uimori',
  name: 'uimori',
  shortName: 'uimori',
  internalID: 'uimori',
  provider: 0,
  format: 0,
  tokenizer: 0,
};
/** How long one field may take before the parser's budget hook aborts it. */
const EVALUATION_BUDGET_MS = 500;

/** The neutral evaluator the importer dry-runs: no chat, no clock, no entropy, no writes. */
function neutralDeps(): RisuCbsDeps {
  const database: Database = {
    characters: [],
    mainPrompt: '',
    jailbreak: '',
    globalNote: '',
    jailbreakToggle: false,
    maxContext: 0,
    aiModel: 'uimori',
    subModel: 'uimori',
    language: 'en',
    globalChatVariables: {},
    templateDefaultVariables: '',
  };
  return {
    getDatabase: () => database,
    getUserName: () => '',
    getPersonaPrompt: () => '',
    getChatVar: () => 'null',
    setChatVar: () => {},
    getGlobalChatVar: () => 'null',
    getModules: () => [],
    getModuleLorebooks: () => [],
    getSelectedCharID: () => 0,
    getModelInfo: () => MODEL_INFO,
    callInternalFunction: () => '',
    getTriggerId: () => '',
    now: () => 0,
    random: () => 0,
    findCharacterbyId: () => null,
    getModuleAssets: () => [],
    unsupportedNames: new Set(RISU_COMPAT_UNSUPPORTED_NAMES),
    maxOutputChars: RISU_COMPAT_LIMITS.textChars,
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: 'uimori',
  };
}

/**
 * The names one field would ask for that Uimori cannot serve, collected at import time so the reader
 * sees them before the material is stored. Evaluates nothing that could be observed: writes are off.
 */
export function scanRisuCompatUnsupported(text: string): string[] {
  const result = createRisuCbs(neutralDeps()).parse(stripRisuComments(text), {
    chatID: 0,
    rmVar: false,
    visualize: false,
    runVar: false,
    cbsConditions: {},
  });
  return [...new Set(result.unsupported)].sort();
}

/**
 * Everything one evaluation reads, resolved from the reserved snapshot alone, plus the hash that
 * binds the entry to exactly these inputs. Archive validation recomputes the hash through this same
 * function, so the canonical JSON below is the single definition of what an entry was evaluated over.
 */
function evaluationInputs(context: RisuCompatContext, field: { fieldId: string; text: string }) {
  const { snapshot, attachment, package: pkg, runId } = context;
  const profile = snapshot.profile;
  const key = risuCompatKey(attachment, field.fieldId);
  const seed = sha256(`${runId}:${key}`);
  const identity = profile
    ? packageIdentityFromProfile(profile, 'main')
    : { bot: { name: 'Character' }, user: { name: 'User' } };
  // {{char}} shows the attached package's own name when it is the bot; a module or persona
  // attachment still speaks about the chat's bot.
  const characterName =
    attachment.role === 'bot'
      ? packageIdentityFromContents({ title: pkg.title, package: pkg }).bot.name
      : identity.bot.name;
  const userName = identity.user.name;
  const variables = { ...(resolveTemplateVariableContext(profile, 'main').variables ?? {}) };
  const history: Message[] = [
    // Uimori history entries are the chat's sources - the written turns - and the reserved request
    // is the turn being answered, exactly as requestEditMessages projects them.
    ...snapshot.history.map((entry) => ({ role: 'char' as const, data: entry.text, time: 0 })),
    ...(snapshot.request ? [{ role: 'user' as const, data: snapshot.request, time: 0 }] : []),
  ];
  // The run id seeds the entropy but is deliberately outside the hash: a fork or a chat-backup
  // restore copies the frozen receipt onto a new run id, and the hash has to keep binding the
  // content the snapshot froze so those copies stay verifiable. The drawn text itself is bound by
  // the prompt it compiled, not by this hash.
  const inputHash = sha256(
    JSON.stringify({
      source: field.text,
      names: { char: characterName, user: userName },
      variables: Object.fromEntries(Object.entries(variables).sort(([a], [b]) => (a < b ? -1 : 1))),
      history: history.map((message) => ({ role: message.role, text: sha256(message.data) })),
      request: sha256(snapshot.request ?? ''),
      clock: snapshot.executionClock?.iso ?? '',
    })
  );
  return { key, seed, characterName, userName, variables, history, inputHash };
}

/** The frozen inputs of one declared field, recomputed without evaluating a single CBS token. */
export function risuCompatInputHash(
  context: RisuCompatContext,
  field: { fieldId: string; text: string }
): string {
  return evaluationInputs(context, field).inputHash;
}

/** Evaluates one declared field against the reserved snapshot and returns its frozen entry. */
export function evaluateRisuCompat(
  context: RisuCompatContext,
  field: { fieldId: string; text: string }
): RisuCompatEntry {
  const { snapshot, package: pkg } = context;
  const profile = snapshot.profile;
  const { key, seed, characterName, userName, variables, history, inputHash } = evaluationInputs(
    context,
    field
  );
  const abandoned = (error: string): RisuCompatEntry => ({
    key,
    inputHash,
    text: field.text,
    unsupported: [],
    partial: 'error',
    error,
  });
  // No clock means no frozen `now()`, and evaluating against a live one would not be reproducible.
  if (!snapshot.executionClock) return abandoned('RISU_COMPAT_NO_CLOCK');
  if (field.text.length > RISU_COMPAT_LIMITS.sourceChars)
    return abandoned('RISU_COMPAT_SOURCE_LIMIT');

  const writes: { key: string; value: string }[] = [];
  const chat = {
    message: history,
    note: '',
    name: 'main',
    localLore: [],
    fmIndex: -1,
    id: 'uimori',
    scriptstate: {},
  } as unknown as Chat;
  const firstStart = pkg.starts?.find((start) => start.mode === 'authored');
  // Only the members cbs.ts reads; `character` itself carries ~40 more that no callback touches.
  const chara = {
    type: 'character',
    name: characterName,
    nickname: '',
    desc: pkg.body ?? '',
    // Personality and scenario are excluded from import by decision, so they have nothing to show.
    personality: '',
    scenario: '',
    exampleMessage: '',
    firstMessage: firstStart?.text ?? '',
    alternateGreetings: [],
    chats: [chat],
    chatPage: 0,
    chaId: pkg.id,
    globalLore: [],
    emotionImages: [],
    additionalAssets: [],
    prebuiltAssetCommand: false,
    prebuiltAssetExclude: [],
    defaultVariables: '',
  } as unknown as character;
  const database: Database = {
    characters: [chara],
    mainPrompt: '',
    jailbreak: '',
    globalNote: '',
    jailbreakToggle: false,
    maxContext: 0,
    aiModel: 'uimori',
    subModel: 'uimori',
    language: 'en',
    globalChatVariables: {},
    templateDefaultVariables: '',
  };
  const personaBody =
    profile && !historicalPersonaExcluded(profile, 'persona', 'main')
      ? (profile.packages?.find((item) =>
          profile.packageAttachments?.some(
            (ref) => ref.role === 'persona' && ref.id === item.id && ref.revision === item.revision
          )
        )?.body ?? '')
      : '';
  const deadline = Date.now() + EVALUATION_BUDGET_MS;
  const cbs = createRisuCbs({
    getDatabase: () => database,
    getUserName: () => userName,
    getPersonaPrompt: () => personaBody,
    getChatVar: (variable) => (Object.hasOwn(variables, variable) ? variables[variable] : 'null'),
    // Writes land on this evaluation's own copy so a later read in the same text sees them. They are
    // recorded, not persisted: adopting them into the chat's shared variables is a separate step.
    setChatVar: (variable, value) => {
      variables[variable] = value;
      writes.push({ key: variable, value });
    },
    getGlobalChatVar: () => 'null',
    getModules: () => [],
    getModuleLorebooks: () => [],
    getSelectedCharID: () => 0,
    getModelInfo: () => MODEL_INFO,
    callInternalFunction: () => '',
    getTriggerId: () => '',
    now: () => Date.parse(snapshot.executionClock!.iso),
    random: seededRandom(seed),
    findCharacterbyId: () => null,
    getModuleAssets: () => [],
    unsupportedNames: new Set(RISU_COMPAT_UNSUPPORTED_NAMES),
    maxOutputChars: RISU_COMPAT_LIMITS.textChars,
    // Wall time, not the frozen clock: this bounds the host, it is not an evaluation input.
    checkBudget: () => {
      if (Date.now() > deadline) throw new Error('RISU_COMPAT_BUDGET');
    },
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: 'uimori',
  });
  const result = cbs.parse(stripRisuComments(field.text), {
    chatID: 0,
    chara,
    db: database,
    rmVar: false,
    visualize: false,
    runVar: true,
    cbsConditions: {},
  });
  const unsupported = [...new Set(result.unsupported)].sort();
  if (result.error !== undefined)
    return { key, inputHash, text: field.text, unsupported, partial: 'error', error: result.error };
  if (result.text.length > RISU_COMPAT_LIMITS.textChars)
    return {
      key,
      inputHash,
      text: result.text.slice(0, RISU_COMPAT_LIMITS.textChars),
      unsupported,
      partial: 'error',
      error: 'RISU_COMPAT_TEXT_LIMIT',
    };
  const partial = writes.length
    ? 'variable-write'
    : unsupported.length
      ? 'unsupported-names'
      : undefined;
  return { key, inputHash, text: result.text, unsupported, ...(partial ? { partial } : {}) };
}

/**
 * Every declared field of every attached package this snapshot owes an entry for, in attachment then
 * declaration order. Preparation evaluates these; archive validation recomputes their input hashes
 * and rejects any receipt key outside the set.
 */
export function risuCompatTargets(
  snapshot: RunSnapshot,
  runId: string
): { context: RisuCompatContext; field: { fieldId: string; text: string } }[] {
  const profile = snapshot.profile;
  const targets: { context: RisuCompatContext; field: { fieldId: string; text: string } }[] = [];
  for (const attachment of profile?.packageAttachments ?? []) {
    if (historicalPersonaExcluded(profile, attachment.role, 'main')) continue;
    const pkg = profile?.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
    if (!pkg?.compat?.risuCbs.fields.length) continue;
    for (const field of risuCompatFields(pkg)) {
      if (targets.length >= RISU_COMPAT_LIMITS.entries) return targets;
      targets.push({ context: { snapshot, attachment, package: pkg, runId }, field });
    }
  }
  return targets;
}

/**
 * Every declared field of every attached package, evaluated once. A pure function of the reserved
 * snapshot and the run id; the caller decides where the receipt is stored.
 */
export function prepareRisuCompatReceipt(
  snapshot: RunSnapshot,
  runId: string
): RisuCompatReceipt | undefined {
  const entries: RisuCompatEntry[] = risuCompatTargets(snapshot, runId).map(({ context, field }) =>
    evaluateRisuCompat(context, field)
  );
  return entries.length ? { version: 1, entries } : undefined;
}
