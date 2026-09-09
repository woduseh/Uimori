import { executeProvider, type ProviderResult, type WireRecord } from '../core/transport.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { packageContext } from '../core/package-context.js';
import { parseSourceSegments } from '../core/source-segments.js';
import type { Connection, ModelSnapshot } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import {
  CODEX_ILLUSTRATION_INSTRUCTIONS,
  CODEX_ILLUSTRATION_OUTPUT_SCHEMA,
  codexIllustrationText,
  fillComfyWorkflow,
  illustrationPromptRequest,
  IllustrationError,
  isRetryableIllustrationCode,
  parseCodexIllustrationCaption,
  parseComfyWorkflow,
  parseIllustrationPlan,
  randomComfySeed,
  type Illustration,
  type IllustrationDiagnostic,
  type IllustrationJobInput,
  type IllustrationScene,
} from '../core/illustration.js';
import type { CodexImageRequest, CodexImageResult } from './codex-runtime.js';
import { fetchComfyUIResult, generateWithComfyUI } from './comfyui-client.js';
import {
  claimIllustration,
  claimIllustrationForReconcile,
  completeIllustration,
  failIllustration,
  illustrationJob,
  loadIllustrationReference,
  projectIllustration,
  requeueIllustration,
  updateIllustrationDiagnostic,
  type GeneratedIllustration,
} from './illustrations.js';
import type { Source, Store } from './store.js';

type MaybePromise<T> = T | Promise<T>;
export type IllustrationRunnerHooks = {
  signal: AbortSignal;
  approvedOrigins: readonly string[];
  resolveCredential?: Parameters<typeof executeProvider>[2]['resolveCredential'];
  executeCodex?: Parameters<typeof executeProvider>[2]['executeCodex'];
  generateCodexImage?: (
    connection: Connection,
    request: CodexImageRequest,
    options: {
      signal: AbortSignal;
      timeoutMs?: number;
      onWire: (wire: WireRecord) => MaybePromise<void>;
    }
  ) => Promise<CodexImageResult>;
  authorize: (connection: Connection) => MaybePromise<Connection>;
  onAttemptStart: (wire: WireRecord) => MaybePromise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => MaybePromise<void>;
  onProgress?: () => MaybePromise<void>;
  cancellationStatus?: 'cancelled' | 'interrupted';
  /** Synthetic generator for local verification only. */
  allowFixture?: boolean;
  /** Test-mode barrier and injected failure point; runs after the claim and before any generator. */
  gate?: () => Promise<void>;
};
export type IllustrationOutcome = {
  status: 'completed' | 'skipped' | 'failed' | 'cancelled' | 'interrupted' | 'requeued';
  code: string | null;
  images: number;
};

const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  'base64'
);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (!ms) return resolve();
    if (signal.aborted) return reject(new IllustrationError('ILLUSTRATION_CANCELLED'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new IllustrationError('ILLUSTRATION_CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });

/** Declared aside/annotation segments stay out of the picture: only main prose reaches a generator. */
function publicSceneText(source: Source, snapshot: RunSnapshot): string {
  if (!snapshot.sourceSegments) return source.text;
  try {
    const document = parseSourceSegments(
      { sourceRevision: source.id, sourceHash: source.hash, text: source.text },
      snapshot.sourceSegments
    );
    const main = document.segments
      .filter((segment) => segment.kind === 'main')
      .map((segment) => source.text.slice(segment.bodyRange.start, segment.bodyRange.end).trim())
      .filter(Boolean)
      .join('\n\n');
    return main || source.text;
  } catch {
    return source.text;
  }
}
function scene(
  source: Source,
  snapshot: RunSnapshot,
  input: IllustrationJobInput,
  allowSkip: boolean
): IllustrationScene {
  const contents = snapshot.profile?.contents ?? [];
  const body = (kind: string) => contents.find((item) => item.kind === kind)?.text ?? null;
  let instructions: string[] = [];
  try {
    instructions = packageContext(snapshot, 'image')?.instructions.map((item) => item.text) ?? [];
  } catch {
    /* Package projection problems do not block an illustration of the saved text. */
  }
  return {
    text: publicSceneText(source, snapshot),
    allowSkip,
    styleGuidance: input.styleGuidance,
    negativeGuidance: input.comfyui?.negativeGuidance ?? '',
    bot: body('bot'),
    persona: body('persona'),
    instructions,
  };
}
async function authorizedConnection(
  hooks: IllustrationRunnerHooks,
  model: ModelSnapshot
): Promise<Connection> {
  let authorized: Connection;
  try {
    authorized = await hooks.authorize(structuredClone(model.connection));
  } catch {
    throw new IllustrationError('CONNECTION_NOT_AUTHORIZED');
  }
  if (
    !authorized.enabled ||
    authorized.id !== model.connectionId ||
    authorized.endpoint !== model.connection.endpoint ||
    authorized.protocol !== model.connection.protocol
  )
    throw new IllustrationError('CONNECTION_NOT_AUTHORIZED');
  return authorized;
}
const providerCode = (result: ProviderResult): string =>
  result.status === 'refused'
    ? 'ILLUSTRATION_PROMPT_REFUSED'
    : result.status === 'cancelled'
      ? 'ILLUSTRATION_CANCELLED'
      : `ILLUSTRATION_PROMPT_${result.error?.code ?? 'FAILED'}`;

/** Runs one queued illustration job to a terminal state or an automatic re-queue. */
export async function runIllustrationJob(
  store: Store,
  jobId: string,
  owner: string,
  hooks: IllustrationRunnerHooks
): Promise<IllustrationOutcome | null> {
  let claimed: ReturnType<typeof claimIllustration>;
  try {
    claimed = claimIllustration(store, jobId, owner);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Unknown source content hash') throw error;
    // The frozen text is no longer readable: fail without claiming so the row stays inspectable.
    store.transaction(() => {
      const changed = store.db
        .prepare(
          "UPDATE illustration_jobs SET status='failed',error='ILLUSTRATION_SOURCE_UNAVAILABLE',updated_at=? WHERE id=? AND status='queued'"
        )
        .run(new Date().toISOString(), jobId);
      if (!changed.changes) return;
      const row = store.db
        .prepare('SELECT chat_id FROM illustration_jobs WHERE id=?')
        .get(jobId) as { chat_id: string };
      store.event(row.chat_id, 'illustration.failed', jobId);
    });
    return { status: 'failed', code: 'ILLUSTRATION_SOURCE_UNAVAILABLE', images: 0 };
  }
  if (!claimed) return null;
  const { job, source } = claimed;
  const { generation, input } = job;
  const diagnostic: IllustrationDiagnostic = {
    stage: 'preparation',
    attempts: [...(job.diagnostic?.attempts ?? [])],
    retries: [...(job.diagnostic?.retries ?? [])],
  };
  const snapshot = store.run(source.runId).snapshot;
  const progress = async () => {
    updateIllustrationDiagnostic(store, jobId, generation, owner, diagnostic);
    await hooks.onProgress?.();
  };
  await hooks.onProgress?.();
  const attempt = async <T extends { usage: ProviderResult['usage'] }>(
    run: (onWire: (wire: WireRecord) => Promise<void>) => Promise<T>,
    toResult: (value: T) => ProviderResult
  ): Promise<T> => {
    let attemptId: string | undefined;
    const value = await run(async (wire) => {
      attemptId = await hooks.onAttemptStart(wire);
      diagnostic.attempts.push(attemptId);
      updateIllustrationDiagnostic(store, jobId, generation, owner, diagnostic);
    });
    if (attemptId !== undefined) await hooks.onAttemptFinish(attemptId, toResult(value));
    return value;
  };
  try {
    if (hooks.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    await hooks.gate?.();
    if (hooks.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    // Only automatic runs may decide that a scene has nothing worth drawing.
    const context = scene(source, snapshot, input, job.origin === 'automatic');
    let generated: GeneratedIllustration[] = [];
    if (input.generator === 'fixture') {
      if (!hooks.allowFixture || !input.fixture)
        throw new IllustrationError('ILLUSTRATION_GENERATOR_UNCONFIGURED');
      diagnostic.stage = 'generate';
      await progress();
      await sleep(input.fixture.delayMs, hooks.signal);
      if (job.attempt <= input.fixture.failures)
        throw new IllustrationError('FIXTURE_FAILURE', true);
      generated = [
        {
          mime: 'image/png',
          bytes: FIXTURE_PNG,
          caption: `모의 삽화 · 시도 ${job.attempt}`,
          prompt: `fixture:${source.hash.slice(0, 12)}`,
        },
      ];
    } else if (input.generator === 'codex') {
      if (!input.codex || !hooks.generateCodexImage)
        throw new IllustrationError('ILLUSTRATION_GENERATOR_UNCONFIGURED');
      const model = input.codex.model;
      const connection = await authorizedConnection(hooks, model);
      const references = input.codex.references.flatMap((reference) => {
        const loaded = loadIllustrationReference(store, reference);
        return loaded
          ? [
              {
                role: reference.role,
                label: reference.title,
                mime: loaded.mime,
                base64: loaded.bytes.toString('base64'),
              },
            ]
          : [];
      });
      diagnostic.stage = 'generate';
      await progress();
      const result = await attempt(
        (onWire) =>
          hooks.generateCodexImage!(
            connection,
            {
              modelId: model.modelId,
              reasoningEffort: model.reasoningEffort,
              developerInstructions: CODEX_ILLUSTRATION_INSTRUCTIONS,
              text: codexIllustrationText(context, references),
              outputSchema: CODEX_ILLUSTRATION_OUTPUT_SCHEMA,
              references: references.map(({ mime, base64 }) => ({ mime, base64 })),
            },
            { signal: hooks.signal, timeoutMs: model.timeoutMs ?? 600_000, onWire }
          ),
        (value) => ({
          status: value.status === 'completed' ? 'completed' : value.status,
          text: value.text,
          toolCalls: [],
          refusal: null,
          error: value.error ? { code: value.error.code } : null,
          usage: value.usage,
          opaqueState: null,
        })
      );
      diagnostic.revisedPrompt = result.revisedPrompt;
      if (result.error?.usageLimit) diagnostic.codex = { usageLimit: result.error.usageLimit };
      if (result.status === 'cancelled') throw new IllustrationError('ILLUSTRATION_CANCELLED');
      const caption = parseCodexIllustrationCaption(result.text);
      if (context.allowSkip && caption.skipped !== null && !result.images.length)
        diagnostic.skipped = caption.skipped;
      else if (result.status !== 'completed' || !result.images.length) {
        const code = result.error?.code ?? 'CODEX_IMAGE_NOT_GENERATED';
        throw new IllustrationError(code, isRetryableIllustrationCode(code));
      }
      generated = result.images.map((image) => ({
        mime: image.mime,
        bytes: image.bytes,
        caption: caption.unavailable ? '' : caption.caption,
        ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
      }));
    } else if (input.generator === 'comfyui') {
      if (!input.comfyui) throw new IllustrationError('ILLUSTRATION_GENERATOR_UNCONFIGURED');
      const workflow = parseComfyWorkflow(input.comfyui.workflow);
      const model = input.comfyui.promptModel;
      const connection = await authorizedConnection(hooks, model);
      diagnostic.stage = 'prompt';
      await progress();
      const promptResult = await attempt(
        (onWire) =>
          executeProvider(
            {
              id: connection.id,
              protocol: connection.protocol,
              endpoint: connection.endpoint,
              ...(connection.credentialEnv ? { credentialEnv: connection.credentialEnv } : {}),
            },
            {
              ...illustrationPromptRequest(model, context, generationFromModel(model)),
              contextBudget: contextBudgetForModel(model),
            },
            {
              approvedOrigins: hooks.approvedOrigins,
              signal: hooks.signal,
              resolveCredential: hooks.resolveCredential,
              executeCodex: hooks.executeCodex,
              timeoutMs: model.timeoutMs,
              onWire,
            }
          ),
        (value) => structuredClone(value)
      );
      if (promptResult.status !== 'completed') {
        const code = providerCode(promptResult);
        throw new IllustrationError(
          code,
          code !== 'ILLUSTRATION_PROMPT_REFUSED' &&
            code !== 'ILLUSTRATION_CANCELLED' &&
            !/HTTP_4\d\d$/u.test(code)
        );
      }
      const plan = parseIllustrationPlan(promptResult.text, context.allowSkip);
      if (plan.kind === 'skip') diagnostic.skipped = plan.reason;
      else {
        const prompt = plan.prompt;
        diagnostic.prompt = prompt;
        diagnostic.stage = 'generate';
        await progress();
        const filled = fillComfyWorkflow(workflow, {
          prompt: prompt.prompt,
          negativePrompt: prompt.negativePrompt,
          seed: randomComfySeed(),
        });
        const rendered = await generateWithComfyUI(
          { baseUrl: input.comfyui.baseUrl, authorizationEnv: input.comfyui.authorizationEnv },
          filled,
          {
            signal: hooks.signal,
            resolveCredential: hooks.resolveCredential,
            timeoutMs: input.comfyui.timeoutMs,
            pollIntervalMs: input.comfyui.pollIntervalMs,
            onSubmitted: async (promptId) => {
              diagnostic.comfyui = { ...diagnostic.comfyui, promptId };
              await progress();
            },
          }
        );
        generated = rendered.images.map((image) => ({
          mime: image.mime,
          bytes: image.bytes,
          caption: prompt.caption,
          prompt: prompt.prompt,
        }));
      }
    } else throw new IllustrationError('ILLUSTRATION_GENERATOR_UNCONFIGURED');
    diagnostic.stage = 'store';
    if (hooks.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    const stored = completeIllustration(store, jobId, generation, owner, generated, diagnostic);
    await hooks.onProgress?.();
    if (!stored) return { status: 'cancelled', code: 'ILLUSTRATION_SUPERSEDED', images: 0 };
    return diagnostic.skipped !== undefined
      ? { status: 'skipped', code: null, images: 0 }
      : { status: 'completed', code: null, images: generated.length };
  } catch (error) {
    const aborted = hooks.signal.aborted;
    const code = aborted
      ? 'ILLUSTRATION_CANCELLED'
      : error instanceof IllustrationError
        ? error.code
        : error instanceof Error && /^[A-Z][A-Z0-9_:]*$/u.test(error.message)
          ? error.message
          : 'ILLUSTRATION_FAILED';
    if (error instanceof IllustrationError) {
      if (error.diagnostic.comfyui)
        diagnostic.comfyui = { ...diagnostic.comfyui, ...error.diagnostic.comfyui };
      if (error.diagnostic.codex) diagnostic.codex = error.diagnostic.codex;
    }
    diagnostic.code = code;
    const retryable =
      !aborted &&
      (error instanceof IllustrationError
        ? error.retryable || isRetryableIllustrationCode(code)
        : isRetryableIllustrationCode(code));
    if (aborted) {
      failIllustration(
        store,
        jobId,
        generation,
        owner,
        hooks.cancellationStatus ?? 'cancelled',
        code,
        diagnostic
      );
      await hooks.onProgress?.();
      return { status: hooks.cancellationStatus ?? 'cancelled', code, images: 0 };
    }
    if (retryable && job.attempt <= input.maxAutoRetries) {
      const requeued = requeueIllustration(store, jobId, generation, owner, code, diagnostic);
      await hooks.onProgress?.();
      if (requeued) return { status: 'requeued', code, images: 0 };
    }
    failIllustration(store, jobId, generation, owner, 'failed', code, diagnostic);
    await hooks.onProgress?.();
    return { status: 'failed', code, images: 0 };
  }
}

/**
 * Reads the recorded ComfyUI prompt_id once. Never resubmits: a finished render is stored, an
 * errored one fails, and a still-pending one restores the job's previous terminal state.
 */
export async function reconcileIllustrationJob(
  store: Store,
  jobId: string,
  owner: string,
  hooks: Pick<IllustrationRunnerHooks, 'signal' | 'resolveCredential' | 'onProgress'>
): Promise<Illustration> {
  const { job, promptId, previous } = claimIllustrationForReconcile(store, jobId, owner);
  const generation = job.generation;
  const diagnostic: IllustrationDiagnostic = {
    ...(job.diagnostic ?? {}),
    stage: 'reconcile',
    attempts: job.diagnostic?.attempts ?? [],
    retries: job.diagnostic?.retries ?? [],
  };
  await hooks.onProgress?.();
  const restore = (code: string) =>
    failIllustration(store, jobId, generation, owner, previous.status, code, {
      ...diagnostic,
      code,
    });
  try {
    const connection = {
      baseUrl: job.input.comfyui!.baseUrl,
      authorizationEnv: job.input.comfyui!.authorizationEnv,
    };
    const result = await fetchComfyUIResult(connection, promptId, {
      signal: hooks.signal,
      resolveCredential: hooks.resolveCredential,
    });
    if (result.state === 'pending') restore(previous.error ?? 'COMFYUI_RESULT_PENDING');
    else if (result.state === 'error')
      failIllustration(store, jobId, generation, owner, 'failed', 'COMFYUI_EXECUTION_FAILED', {
        ...diagnostic,
        code: 'COMFYUI_EXECUTION_FAILED',
        comfyui: { ...diagnostic.comfyui, statusMessages: result.statusMessages },
      });
    else {
      const caption = diagnostic.prompt?.caption ?? '';
      const { code: _code, ...clean } = diagnostic;
      completeIllustration(
        store,
        jobId,
        generation,
        owner,
        result.images.map((image) => ({
          mime: image.mime,
          bytes: image.bytes,
          caption,
          ...(diagnostic.prompt ? { prompt: diagnostic.prompt.prompt } : {}),
        })),
        { ...clean, stage: 'store' }
      );
    }
  } catch (error) {
    const code =
      error instanceof IllustrationError
        ? error.code
        : hooks.signal.aborted
          ? 'ILLUSTRATION_CANCELLED'
          : 'COMFYUI_UNREACHABLE';
    if (error instanceof IllustrationError && error.diagnostic.comfyui)
      diagnostic.comfyui = { ...diagnostic.comfyui, ...error.diagnostic.comfyui };
    if (code === 'COMFYUI_NO_IMAGE' || code === 'COMFYUI_IMAGE_INVALID')
      failIllustration(store, jobId, generation, owner, 'failed', code, { ...diagnostic, code });
    else restore(previous.error ?? code);
  }
  await hooks.onProgress?.();
  return projectIllustration(store, illustrationJob(store, jobId));
}
