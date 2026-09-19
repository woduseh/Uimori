import type { ContentAttachment, ContentTarget } from './risu-content.js';
import { type RuntimeValue } from './risu-prompt.js';
import type { RunSnapshot } from './types.js';
import { resolveTemplateVariableContext } from './template-variables.js';

/** Reads only an immutable run projection. No clock, library lookup, provider call, or writes. */
export function executionContext(
  snapshot: RunSnapshot,
  target: ContentTarget = 'main'
): Record<string, RuntimeValue> {
  const profile = snapshot.profile;
  const messages = structuredClone(snapshot.logicalHistory ?? []);
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
  const refs = profile?.packageAttachments ?? [];
  const model =
    profile?.models[
      target === 'translation' ? 'translation' : target === 'status' ? 'status' : 'main'
    ];
  const mainModel = model && 'connection' in model ? model : undefined;
  const capabilities =
    mainModel?.connection.catalog.find((c) => c.id === mainModel.modelId)?.capabilities ?? {};
  const bot = refs.find((r) => r.role === 'bot'),
    persona = refs.find((r) => r.role === 'persona');
  const identity = (ref: ContentAttachment | undefined, kind: string) => {
    const pkg =
      ref && profile?.packages?.find((p) => p.id === ref.id && p.revision === ref.revision);
    const description = pkg?.identity?.description ?? pkg?.body ?? '';
    return {
      name: pkg ? (pkg.identity?.name ?? pkg.title) : kind === 'bot' ? 'Character' : 'User',
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
    ...resolveTemplateVariableContext(profile),
    ...(snapshot.nativeRisuExecution
      ? {
          variables:
            snapshot.nativeRisuExecution.preRequest?.variables ??
            snapshot.nativeRisuExecution.variables,
        }
      : {}),
    chat: {
      id: snapshot.chatId,
      branchId: snapshot.branchId ?? `main:${snapshot.chatId}`,
      turnIndex: snapshot.history.length,
      parentRevision: snapshot.parentRevision,
    },
    bot: identity(bot, 'bot'),
    user: identity(persona, 'persona'),
    input: { text: snapshot.nativeRisuExecution?.request ?? snapshot.request },
    history: {
      recent,
      total: messages.length,
      truncated: recent.length !== messages.length || recent.some((m) => m.truncated),
      lastUser: [...recent].reverse().find((m) => m.role === 'user')?.text ?? null,
      lastAssistant: [...recent].reverse().find((m) => m.role === 'assistant')?.text ?? null,
    },
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
