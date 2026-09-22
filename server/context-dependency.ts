import { createHash } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';

/** Summary meaning follows authored input, not workspace bookkeeping or unrelated role settings. */
export function contextDependencyKey(snapshot: RunSnapshot): string {
  const main = snapshot.profile?.promptPresets?.main;
  const reference = snapshot.profile?.prompts?.main;
  const values = reference
    ? snapshot.profile?.promptControls?.[reference.id + '@' + reference.revision]?.values
    : undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        packages: snapshot.profile?.packages ?? [],
        prompt: main ? { program: main.program, values: values ?? main.values ?? {} } : null,
        canon: snapshot.story?.canonHash ?? null,
        resources: snapshot.resources,
        ...((snapshot.nativeRisuExecution?.inputHistoryRevision ??
        snapshot.nativeRisuHistoryRevision)
          ? {
              nativeHistory:
                snapshot.nativeRisuExecution?.inputHistoryRevision ??
                snapshot.nativeRisuHistoryRevision,
            }
          : {}),
      })
    )
    .digest('hex');
}
