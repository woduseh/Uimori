import { historicalPersonaExcluded } from './persona-scope.js';
import { sourceLogicalHistoryForRequest } from './source-context.js';
import type { PackageAttachment, PackageTarget } from './content-package.js';
import { resolvePromptValues, type RuntimeValue } from './prompt-program.js';
import type { RunSnapshot } from './types.js';

export type PackageExecutionState = {
  instanceId: string;
  packageId: string;
  packageRevision: number;
  role: string;
  behaviorRevision: number;
  schemaVersion: number;
  stateRevision: number;
  state: RuntimeValue;
  draws: Record<string, RuntimeValue>;
};
export const packageInstanceId = (attachment: PackageAttachment) =>
  `${attachment.id}:${attachment.role}`;
/** Reads only an immutable run projection. No clock, library lookup, provider call, or writes. */
export function executionContext(
  snapshot: RunSnapshot,
  target: PackageTarget = 'main',
  attachment?: PackageAttachment
): Record<string, RuntimeValue> {
  const profile = snapshot.profile;
  const messages = sourceLogicalHistoryForRequest(snapshot, snapshot.logicalHistory ?? []);
  let remaining = 60_000;
  const recent = messages
    .slice(-100)
    .reverse()
    .flatMap((message) => {
      if (remaining <= 0) return [];
      const text = message.text.slice(-remaining);
      remaining -= text.length;
      return [
        {
          id: message.id,
          role: message.role,
          text,
          sourceRevision: message.sourceRevision ?? null,
          sourceHash: message.sourceHash ?? null,
          truncated: text.length !== message.text.length,
        },
      ];
    })
    .reverse();
  const refs = (profile?.packageAttachments ?? []).filter(
    (ref) => !historicalPersonaExcluded(profile, ref.role, target)
  );
  const packages = refs.map((ref) => {
    const pkg = profile?.packages?.find((p) => p.id === ref.id && p.revision === ref.revision);
    const frozen = snapshot.packageStates?.find((s) => s.instanceId === packageInstanceId(ref));
    return {
      id: ref.id,
      revision: ref.revision,
      role: ref.role,
      instanceId: packageInstanceId(ref),
      title: pkg?.title ?? '',
      state: frozen?.state ?? pkg?.behavior?.initialState ?? {},
      stateRevision: frozen?.stateRevision ?? 0,
      draws: frozen?.draws ?? {},
      options: pkg
        ? resolvePromptValues(
            { version: 1, controls: pkg.controls, blocks: [] },
            profile?.packageValues?.[`${ref.id}@${ref.revision}:${ref.role}`]
          )
        : {},
    };
  });
  const selected = attachment
    ? packages.find((p) => p.instanceId === packageInstanceId(attachment))
    : undefined;
  const model =
    target === 'state'
      ? snapshot.story?.models[target]
      : profile?.models[
          target === 'translation'
            ? 'translation'
            : target === 'image'
              ? 'image'
              : target === 'status'
                ? 'status'
                : 'main'
        ];
  const mainModel = model && 'connection' in model ? model : undefined;
  const capabilities =
    mainModel?.connection.catalog.find((c) => c.id === mainModel.modelId)?.capabilities ?? {};
  const bot = refs.find((r) => r.role === 'bot'),
    persona = refs.find((r) => r.role === 'persona');
  const identity = (ref: PackageAttachment | undefined, kind: string) => {
    if (historicalPersonaExcluded(profile, kind, target))
      return { name: 'User', description: '', descriptionTruncated: false };
    const pkg =
      ref && profile?.packages?.find((p) => p.id === ref.id && p.revision === ref.revision);
    const legacy = profile?.contents.find((c) => c.kind === kind);
    const description = pkg ? (pkg.identity?.description ?? pkg.body ?? '') : (legacy?.text ?? '');
    return {
      name: pkg
        ? (pkg.identity?.name ?? pkg.title)
        : (legacy?.title ?? (kind === 'bot' ? 'Character' : 'User')),
      description: description.slice(0, 16_000),
      descriptionTruncated: description.length > 16_000,
    };
  };
  const catalog = snapshot.resources.filter(
    (r) =>
      !r.id.startsWith('package:') ||
      refs.some((ref) => r.id.startsWith(`package:${ref.id}:${ref.role}:`))
  );
  return {
    chat: {
      id: snapshot.chatId,
      branchId: snapshot.branchId ?? `main:${snapshot.chatId}`,
      turnIndex: snapshot.history.length,
      parentRevision: snapshot.parentRevision,
    },
    bot: identity(bot, 'bot'),
    user: identity(persona, 'persona'),
    input: { text: snapshot.request },
    history: {
      recent,
      total: messages.length,
      truncated: recent.length !== messages.length || recent.some((m) => m.truncated),
      lastUser: [...recent].reverse().find((m) => m.role === 'user')?.text ?? null,
      lastAssistant: [...recent].reverse().find((m) => m.role === 'assistant')?.text ?? null,
    },
    state: selected?.state ?? snapshot.story?.state?.values ?? {},
    draws: selected?.draws ?? {},
    options: selected?.options ?? {},
    package: selected ?? null,
    packages,
    model: {
      id: mainModel?.modelId ?? null,
      protocol: mainModel?.connection.protocol ?? null,
      capabilities: { ...capabilities, prefill: false },
    },
    time: {
      iso: snapshot.executionClock?.iso ?? null,
      unix: snapshot.executionClock?.unix ?? null,
      timezone: 'UTC',
    },
    catalog: {
      items: catalog.slice(0, 200).map((r) => ({
        id: r.id,
        revision: r.revision,
        title: r.title,
        description: r.description.slice(0, 500),
        descriptionTruncated: r.description.length > 500,
        loading: r.loading ?? 'discoverable',
      })),
      total: catalog.length,
      truncated: catalog.length > 200,
    },
  };
}
