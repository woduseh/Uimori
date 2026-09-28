/** A single startup conversion of browser records written by the former chat scope. */
type BrowserStore = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export type LocalConversionWarning = {
  storage: 'session' | 'local';
  key: string;
  reason: 'conflict' | 'invalid' | 'unavailable';
};

function keys(
  store: BrowserStore,
  storage: LocalConversionWarning['storage'],
  warnings: LocalConversionWarning[]
) {
  try {
    return Array.from({ length: store.length }, (_, index) => store.key(index)).filter(
      (key): key is string => key !== null
    );
  } catch {
    warnings.push({ storage, key: '*', reason: 'unavailable' });
    return [];
  }
}

function object(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid saved record');
  return value as Record<string, unknown>;
}

function withoutBranch(value: Record<string, unknown>) {
  if (value.branchId !== undefined && typeof value.branchId !== 'string')
    throw new Error('Invalid former scope');
  const { branchId: _formerScope, ...current } = value;
  return current;
}

function command(raw: string): string {
  const record = object(raw);
  if (typeof record.id !== 'string' || !record.id || typeof record.payload !== 'string')
    throw new Error('Invalid pending request');
  const payload = object(record.payload);
  if (
    typeof payload.request !== 'string' ||
    !payload.request.trim() ||
    !(payload.expectedRevision === null || typeof payload.expectedRevision === 'string') ||
    !Number.isInteger(payload.expectedSettingsRevision)
  )
    throw new Error('Invalid pending request');
  return JSON.stringify({ ...record, payload: JSON.stringify(withoutBranch(payload)) });
}

function variable(raw: string): string {
  const draft = object(raw);
  if (
    typeof draft.text !== 'string' ||
    !Number.isSafeInteger(draft.revision) ||
    !(draft.sourceHash === null || typeof draft.sourceHash === 'string')
  )
    throw new Error('Invalid variable draft');
  if (draft.pending !== undefined) {
    if (
      !draft.pending ||
      typeof draft.pending !== 'object' ||
      Array.isArray(draft.pending) ||
      typeof (draft.pending as Record<string, unknown>).idempotencyKey !== 'string'
    )
      throw new Error('Invalid pending variable save');
    draft.pending = withoutBranch(draft.pending as Record<string, unknown>);
  }
  return JSON.stringify(draft);
}

function outline(raw: string): string {
  const saved = object(raw);
  if (
    !['apply', 'write'].includes(String(saved.kind)) ||
    !saved.body ||
    typeof saved.body !== 'object' ||
    Array.isArray(saved.body) ||
    typeof (saved.body as Record<string, unknown>).idempotencyKey !== 'string'
  )
    throw new Error('Invalid pending outline command');
  saved.body = withoutBranch(saved.body as Record<string, unknown>);
  return JSON.stringify(saved);
}

function move(
  store: BrowserStore,
  storage: LocalConversionWarning['storage'],
  from: string,
  to: string,
  convert: (raw: string) => string,
  warnings: LocalConversionWarning[]
) {
  let raw: string | null;
  try {
    raw = store.getItem(from);
    if (raw === null) return;
    const converted = convert(raw);
    const destination = store.getItem(to);
    if (destination !== null && destination !== converted && from !== to) {
      warnings.push({ storage, key: from, reason: 'conflict' });
      return;
    }
    if (destination !== converted) store.setItem(to, converted);
    if (store.getItem(to) !== converted) throw new Error('Write was not retained');
    if (from !== to && store.getItem(from) === raw) store.removeItem(from);
  } catch (error) {
    warnings.push({
      storage,
      key: from,
      reason:
        error instanceof SyntaxError ||
        (error instanceof Error && error.message.startsWith('Invalid'))
          ? 'invalid'
          : 'unavailable',
    });
  }
}

function moveDraftGroup(
  store: BrowserStore,
  chatId: string,
  oldDraftKey: string,
  warnings: LocalConversionWarning[]
) {
  const newDraftKey = `draft:${chatId}`;
  const suffix = oldDraftKey.slice(newDraftKey.length);
  const pairs = [
    [oldDraftKey, newDraftKey],
    ...['lore-reset:', 'cursor:', 'input-translation:'].map((prefix) => [
      prefix + oldDraftKey,
      prefix + newDraftKey,
    ]),
  ];
  const copied: { from: string; to: string; raw: string; created: boolean }[] = [];
  try {
    const draft = store.getItem(oldDraftKey);
    if (draft === null || !suffix.startsWith(':')) return;
    let conflict = false;
    for (const [from, to] of pairs) {
      const raw = store.getItem(from);
      if (raw === null) continue;
      const current = store.getItem(to);
      if (current !== null && current !== raw) conflict = true;
      copied.push({ from, to, raw, created: current === null });
    }
    if (conflict) {
      for (const item of copied)
        warnings.push({ storage: 'session', key: item.from, reason: 'conflict' });
      return;
    }
    for (const item of copied) {
      if (item.created) store.setItem(item.to, item.raw);
      if (store.getItem(item.to) !== item.raw) throw new Error('Write was not retained');
    }
    for (const item of copied)
      if (store.getItem(item.from) === item.raw) store.removeItem(item.from);
  } catch {
    for (const item of copied) {
      // A destination may already be the only copy if removing old keys failed midway.
      // Keep every written destination and every remaining source for a later conversion.
      warnings.push({ storage: 'session', key: item.from, reason: 'unavailable' });
    }
    if (!copied.length)
      warnings.push({ storage: 'session', key: oldDraftKey, reason: 'unavailable' });
  }
}

/** Called at startup before the editor reads its draft, then once for the loaded chat list.
 * A converted record is removed, so future loads have no branch-specific read path.
 */
export function convertLegacyLocalState(
  chatIds: readonly string[],
  session?: BrowserStore,
  local?: BrowserStore
): LocalConversionWarning[] {
  const warnings: LocalConversionWarning[] = [];
  try {
    session ??= sessionStorage;
    local ??= localStorage;
  } catch {
    return [{ storage: 'session', key: '*', reason: 'unavailable' }];
  }
  const sessionKeys = keys(session, 'session', warnings);
  for (const chatId of new Set(chatIds.filter(Boolean))) {
    const commandKey = `command:${chatId}`;
    if (sessionKeys.includes(commandKey))
      move(session, 'session', commandKey, commandKey, command, warnings);
    const prefixes: { old: string; current: string; convert: (raw: string) => string }[] = [
      { old: `command:${chatId}:`, current: commandKey, convert: command },
      { old: `reading:${chatId}:`, current: `reading:${chatId}`, convert: String },
      { old: `activity-hidden:${chatId}:`, current: `activity-hidden:${chatId}`, convert: String },
      {
        old: `uimori:chat-variable-draft:${chatId}:`,
        current: `uimori:chat-variable-draft:${chatId}`,
        convert: variable,
      },
      { old: `outline-pending:${chatId}:`, current: `outline-pending:${chatId}`, convert: outline },
    ];
    for (const key of sessionKeys)
      if (key.startsWith(`draft:${chatId}:`)) moveDraftGroup(session, chatId, key, warnings);
    for (const key of sessionKeys)
      if (
        ['lore-reset:', 'cursor:', 'input-translation:'].some((prefix) =>
          key.startsWith(`${prefix}draft:${chatId}:`)
        ) &&
        !sessionKeys.some(
          (draftKey) => draftKey.startsWith(`draft:${chatId}:`) && key.endsWith(draftKey)
        )
      )
        warnings.push({ storage: 'session', key, reason: 'invalid' });
    for (const rule of prefixes)
      for (const key of sessionKeys)
        if (key.startsWith(rule.old))
          move(session, 'session', key, rule.current, rule.convert, warnings);
    const outlinePrefix = `outline-workspace:${chatId}:`;
    for (const key of sessionKeys) {
      if (!key.startsWith(outlinePrefix)) continue;
      const rest = key.slice(outlinePrefix.length);
      const item = rest.match(/:(selected|folded|new|draft:[^:]+|request:[^:]+)$/u);
      if (item) move(session, 'session', key, `${outlinePrefix}${item[1]}`, String, warnings);
    }
  }
  for (const key of keys(local, 'local', warnings)) {
    for (const prefix of ['uimori:helper-create:', 'uimori:helper-session-scope:']) {
      if (!key.startsWith(prefix)) continue;
      let scope: Record<string, unknown>;
      try {
        scope = object(key.slice(prefix.length));
      } catch {
        warnings.push({ storage: 'local', key, reason: 'invalid' });
        continue;
      }
      if (scope.kind !== 'chat' || typeof scope.chatId !== 'string' || !('branchId' in scope))
        continue;
      let currentScope: Record<string, unknown>;
      try {
        currentScope = withoutBranch(scope);
      } catch {
        warnings.push({ storage: 'local', key, reason: 'invalid' });
        continue;
      }
      const destination = `${prefix}${JSON.stringify(currentScope)}`;
      move(
        local,
        'local',
        key,
        destination,
        prefix === 'uimori:helper-create:'
          ? (raw) => {
              const request = object(raw);
              if (typeof request.requestKey !== 'string' || !request.requestKey)
                throw new Error('Invalid pending helper creation');
              request.scope = currentScope;
              return JSON.stringify(request);
            }
          : String,
        warnings
      );
    }
  }
  return warnings;
}

/** Export the exact remaining values; no incomplete record is deleted or retried. */
export function downloadUnconvertedLocalState(warnings: readonly LocalConversionWarning[]) {
  const records = warnings.map((warning) => {
    let value: string | null = null;
    try {
      value = (warning.storage === 'session' ? sessionStorage : localStorage).getItem(warning.key);
    } catch {
      /* The unavailable key and reason remain in the export. */
    }
    return { ...warning, value };
  });
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ version: 1, records }, null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'uimori-previous-browser-records.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
