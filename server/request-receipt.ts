import type { ContextReceipt } from '../core/scene-usage.js';
import type { Json, WireRecord } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';

/** Encoders own serialization. Inspect their final string leaves without re-running authored code. */
function containsText(value: Json, text: string): boolean {
  if (typeof value === 'string')
    return value.includes(text) || value.includes(JSON.stringify(text).slice(1, -1));
  if (Array.isArray(value)) return value.some((item) => containsText(item, text));
  return value !== null && typeof value === 'object'
    ? Object.values(value).some((item) => containsText(item, text))
    : false;
}

/** Capture only the prepared invocation's small facts. No library reads, raw text or new effects. */
export function requestReceipt(
  snapshot: RunSnapshot,
  wire: Pick<WireRecord, 'body' | 'modelId'>
): ContextReceipt {
  const profile = snapshot.profile;
  const model = profile?.models.main;
  const prompt = profile?.promptPresets?.main;
  const attachment = profile?.packageAttachments?.find((item) => item.role === 'persona');
  const persona =
    attachment &&
    profile?.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
  const plan = snapshot.contextPlan;
  const summary = plan?.status === 'ready' ? plan.summary : null;
  return {
    version: 1,
    model: {
      modelId: wire.modelId,
      title: model?.title ?? wire.modelId,
      ...(model ? { presetId: model.id } : {}),
    },
    prompt: prompt ? { id: prompt.id, revision: prompt.revision, title: prompt.title } : null,
    persona: attachment
      ? {
          id: attachment.id,
          revision: attachment.revision,
          title: persona?.title ?? null,
          name: persona ? (persona.identity?.name ?? persona.title) : null,
        }
      : null,
    summary: plan
      ? {
          status: summary
            ? containsText(wire.body, summary)
              ? 'included'
              : 'unverified'
            : 'absent',
          coveredSources: summary ? plan.compacted.length : 0,
        }
      : null,
  };
}
