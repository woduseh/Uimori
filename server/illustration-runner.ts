import { checkCodexIllustrationContent } from './illustration-content-check.js';
import type { JevHooks } from './jev-judgment.js';
import { splitSource } from '../core/auxiliary.js';
import { imageTargetSource } from './package-images.js';
import {
  storyboardRequest,
  parseStoryboard,
  illustrationTargetText,
  illustrationPlacementRequest,
  parseIllustrationPlacement,
  type IllustrationStoryboard,
} from '../core/illustration-storyboard.js';
import { completeIllustrationStoryboard, completeIllustrationPlacement } from './illustrations.js';
import type { ProviderRequest } from '../core/transport.js';
import { createHash } from 'node:crypto';
import { processImage, resizeIllustrationReference } from './image-processing.js';
import { readRunSnapshot } from './run-projections.js';
import {
  executeProvider,
  type ProviderResult,
  transportConnection,
  type WireRecord,
} from '../core/transport.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
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
  type IllustrationPlan,
  type IllustrationScene,
} from '../core/illustration.js';
import type { CodexImageRequest, CodexImageResult } from './codex-runtime.js';
import {
  fetchComfyUIResult,
  generateWithComfyUI,
  type ComfyUIRequestOptions,
} from './comfyui-client.js';
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
  resolveJevCredential?: JevHooks['credential'];

  resolveCredential?: Parameters<typeof executeProvider>[2]['resolveCredential'];
  resolveComfyCredential?: ComfyUIRequestOptions['resolveCredential'];
  cancelRemoteOnAbort?: () => boolean;
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
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
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

function scene(
  source: Source,
  snapshot: RunSnapshot,
  input: IllustrationJobInput,
  allowSkip: boolean
): IllustrationScene {
  const body = (role: string) => {
    const ref = snapshot.profile?.packageAttachments?.find((item) => item.role === role);
    return (
      snapshot.profile?.packages?.find(
        (item) => item.id === ref?.id && item.revision === ref?.revision
      )?.body ?? null
    );
  };
  return {
    text: input.target ? illustrationTargetText(source, input.target) : source.text,
    allowSkip: input.target ? false : allowSkip,
    targeted: !!input.target,
    styleGuidance: input.styleGuidance,
    negativeGuidance: input.comfyui?.negativeGuidance ?? '',
    bot: body('bot'),
    persona: body('persona'),
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
    contentCheck: job.diagnostic?.contentCheck,
    prompt: job.diagnostic?.prompt,
    promptRequestHash: job.diagnostic?.promptRequestHash,
  };
  const snapshot = readRunSnapshot(store, source.runId);
  const progress = async () => {
    updateIllustrationDiagnostic(store, jobId, generation, owner, diagnostic);
    await hooks.onProgress?.();
  };
  await hooks.onProgress?.();
  const recordAttempt = async (wire: WireRecord) => {
    const id = await hooks.onAttemptStart(wire);
    diagnostic.attempts.push(id);
    updateIllustrationDiagnostic(store, jobId, generation, owner, diagnostic);
    return id;
  };
  const attempt = async <T extends { usage: ProviderResult['usage'] }>(
    run: (onWire: (wire: WireRecord) => Promise<void>) => Promise<T>,
    toResult: (value: T) => ProviderResult
  ): Promise<T> => {
    let attemptId: string | undefined;
    let value: T;
    try {
      value = await run(async (wire) => {
        attemptId = await recordAttempt(wire);
      });
    } catch (error) {
      if (attemptId !== undefined)
        await hooks.onAttemptFinish(attemptId, {
          status: hooks.signal.aborted ? 'cancelled' : 'error',
          text: '',
          toolCalls: [],
          refusal: null,
          error: { code: error instanceof IllustrationError ? error.code : 'ILLUSTRATION_FAILED' },
          usage: {
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            raw: null,
            priceRevision: null,
          },
          opaqueState: null,
        });
      throw error;
    }
    if (attemptId !== undefined) await hooks.onAttemptFinish(attemptId, toResult(value));
    return value;
  };
  const textRequest = async (
    model: ModelSnapshot,
    request: ProviderRequest,
    authorized?: Connection
  ) => {
    const connection = authorized ?? (await authorizedConnection(hooks, model));
    const result = await attempt(
      (onWire) =>
        executeProvider(transportConnection(connection), request, {
          signal: hooks.signal,
          resolveCredential: hooks.resolveCredential,
          executeCodex: hooks.executeCodex,
          timeoutMs: model.timeoutMs,
          onWire,
        }),
      (value) => structuredClone(value)
    );
    if (result.status !== 'completed') {
      const code = providerCode(result);
      throw new IllustrationError(code, isRetryableIllustrationCode(code));
    }
    return result.text;
  };
  try {
    if (hooks.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    await hooks.gate?.();
    if (hooks.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    // Only automatic runs may decide that a scene has nothing worth drawing.
    const context = scene(source, snapshot, input, job.origin === 'automatic');
    if (input.task === 'plan') {
      if (!input.plan) throw new IllustrationError('ILLUSTRATION_STORYBOARD_INVALID');
      diagnostic.stage = 'planning';
      await progress();
      let storyboard: IllustrationStoryboard;
      if (input.generator === 'fixture' && hooks.allowFixture) {
        const available = splitSource(source).filter(
          (block) =>
            !input.plan!.existingTargets.some((target) => target.endAnchor === block.anchor)
        );
        const targets = available.slice(0, input.plan.maxTargets).map((block) => ({
          startAnchor: block.anchor,
          endAnchor: block.anchor,
          focus: `모의 삽화 · ${block.text.slice(0, 100)}`,
          visualBrief: block.text,
        }));
        storyboard = {
          heroIndex: targets.length ? Math.min(1, targets.length - 1) : null,
          targets,
          ...(!targets.length ? { skipReason: '새로운 시각적 순간이 없어요.' } : {}),
        };
      } else {
        const model = input.comfyui?.promptModel ?? input.codex?.model;
        if (!model) throw new IllustrationError('ILLUSTRATION_MODEL_REQUIRED');
        const request = storyboardRequest(
          model,
          context,
          source,
          { ...input.plan, generator: input.generator },
          generationFromModel(model)
        );
        const text = await textRequest(model, request);
        storyboard = parseStoryboard(
          text,
          splitSource(source),
          input.plan.maxTargets,
          input.generator === 'comfyui',
          context.allowSkip || input.plan.existingTargets.length > 0,
          input.plan.existingTargets
        );
      }
      hooks.signal.throwIfAborted();
      const stored = completeIllustrationStoryboard(store, job, owner, storyboard, diagnostic);
      await hooks.onProgress?.();
      return {
        status: stored ? (storyboard.targets.length ? 'completed' : 'skipped') : 'cancelled',
        code: stored ? null : 'ILLUSTRATION_SUPERSEDED',
        images: 0,
      };
    }
    if (input.task === 'placement') {
      if (!input.placement) throw new IllustrationError('ILLUSTRATION_PLACEMENT_INVALID');
      diagnostic.stage = 'placement';
      await progress();
      const translation = imageTargetSource(store, {
        sourceRevision: source.id,
        sourceHash: source.hash,
        input: { imageTarget: input.placement.target },
      });
      const blocks = splitSource(translation);
      let afterByTarget: Record<string, string | null>;
      if (input.generator === 'fixture' && hooks.allowFixture) {
        // Deterministic synthetic mapping only; real translation alignment is a model result.
        const originals = splitSource(source);
        afterByTarget = Object.fromEntries(
          input.placement.targets.map((target) => [
            target.id,
            blocks[originals.findIndex((block) => block.anchor === target.endAnchor)]?.anchor ??
              null,
          ])
        );
      } else {
        const model = input.comfyui?.promptModel ?? input.codex?.model;
        if (!model) throw new IllustrationError('ILLUSTRATION_MODEL_REQUIRED');
        const request = illustrationPlacementRequest(
          model,
          context,
          source,
          translation,
          input.placement,
          generationFromModel(model)
        );
        afterByTarget = parseIllustrationPlacement(
          await textRequest(model, request),
          input.placement.targets.map((target) => target.id),
          blocks
        );
      }
      hooks.signal.throwIfAborted();
      const stored = completeIllustrationPlacement(store, job, owner, afterByTarget, diagnostic);
      await hooks.onProgress?.();
      return {
        status: stored ? 'completed' : 'cancelled',
        code: stored ? null : 'ILLUSTRATION_SUPERSEDED',
        images: 0,
      };
    }
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
                bytes: loaded.bytes,
              },
            ]
          : [];
      });
      const imageText = codexIllustrationText(context, references);
      diagnostic.stage = 'content-check';
      await progress();
      diagnostic.contentCheck = await checkCodexIllustrationContent(
        imageText,
        {
          signal: hooks.signal,
          credential: hooks.resolveJevCredential,
          onAttemptStart: recordAttempt,
          onAttemptFinish: hooks.onAttemptFinish,
        },
        diagnostic.contentCheck
      );
      await progress();
      hooks.signal.throwIfAborted();
      if (diagnostic.contentCheck.status === 'blocked')
        throw new IllustrationError('ILLUSTRATION_CODEX_CONTENT_BLOCKED');
      const imageReferences: { mime: string; base64: string }[] = [];
      for (const reference of references) {
        hooks.signal.throwIfAborted();
        const prepared = await resizeIllustrationReference(reference.bytes, reference.mime);
        imageReferences.push({ mime: prepared.mime, base64: prepared.bytes.toString('base64') });
      }
      hooks.signal.throwIfAborted();
      diagnostic.stage = 'generate';
      await progress();
      const result = await attempt(
        (onWire) =>
          hooks.generateCodexImage!(
            connection,
            {
              modelId: model.modelId,
              contextBudget: contextBudgetForModel(model),
              reasoningEffort: model.reasoningEffort,
              developerInstructions: CODEX_ILLUSTRATION_INSTRUCTIONS,
              text: imageText,
              outputSchema: CODEX_ILLUSTRATION_OUTPUT_SCHEMA,
              references: imageReferences,
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
      else if (caption.unavailable && !result.images.length) {
        diagnostic.codex = {
          ...diagnostic.codex,
          unavailableReason: caption.unavailableReason,
        };
        throw new IllustrationError('CODEX_IMAGE_UNAVAILABLE');
      } else if (result.status !== 'completed' || !result.images.length) {
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
      if (input.comfyui.disabled) throw new IllustrationError('CONNECTION_NOT_AUTHORIZED');
      const workflow = parseComfyWorkflow(input.comfyui.workflow);
      const model = input.comfyui.promptModel;
      const connection = await authorizedConnection(hooks, model);
      const request = illustrationPromptRequest(model, context, generationFromModel(model));
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      let plan: IllustrationPlan;
      if (input.target?.prompt) {
        plan = { kind: 'generate', prompt: input.target.prompt };
      } else if (diagnostic.prompt && diagnostic.promptRequestHash === requestHash) {
        plan = { kind: 'generate', prompt: diagnostic.prompt };
      } else {
        // An old prompt cannot authorize reuse when today's reconstructed input changed.
        delete diagnostic.prompt;
        delete diagnostic.promptRequestHash;
        diagnostic.stage = 'prompt';
        await progress();
        plan = parseIllustrationPlan(
          await textRequest(model, request, connection),
          context.allowSkip
        );
      }
      if (plan.kind === 'skip') diagnostic.skipped = plan.reason;
      else {
        const prompt = plan.prompt;
        diagnostic.prompt = prompt;
        diagnostic.promptRequestHash = requestHash;
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
            resolveCredential: hooks.resolveComfyCredential,
            timeoutMs: input.comfyui.timeoutMs,
            pollIntervalMs: input.comfyui.pollIntervalMs,
            cancelRemoteOnAbort: hooks.cancelRemoteOnAbort,
            onSubmitting: async () => {
              diagnostic.comfyui = { submission: 'uncertain' };
              await progress();
            },
            onSubmitted: async (promptId) => {
              diagnostic.comfyui = { ...diagnostic.comfyui, promptId, submission: 'accepted' };
              await progress();
            },
          }
        );
        diagnostic.comfyui = { ...diagnostic.comfyui, submission: 'finished' };
        generated = rendered.images.map((image) => ({
          mime: image.mime,
          bytes: image.bytes,
          caption: prompt.caption,
          prompt: prompt.prompt,
        }));
      }
    } else throw new IllustrationError('ILLUSTRATION_GENERATOR_UNCONFIGURED');
    generated = await Promise.all(
      generated.map(async (image) => ({
        ...image,
        ...(await processImage(Buffer.from(image.bytes))),
      }))
    );
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
      (error instanceof IllustrationError ? error.retryable : isRetryableIllustrationCode(code));
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
  hooks: Pick<IllustrationRunnerHooks, 'signal' | 'onProgress'> &
    Pick<ComfyUIRequestOptions, 'resolveCredential'>
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
      disabled: job.input.comfyui!.disabled,
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
        comfyui: {
          ...diagnostic.comfyui,
          statusMessages: result.statusMessages,
          submission: 'finished',
        },
      });
    else {
      const caption = diagnostic.prompt?.caption ?? '';
      const { code: _code, ...clean } = diagnostic;
      completeIllustration(
        store,
        jobId,
        generation,
        owner,
        await Promise.all(
          result.images.map(async (image) => ({
            caption,
            ...(diagnostic.prompt ? { prompt: diagnostic.prompt.prompt } : {}),
            ...(await processImage(Buffer.from(image.bytes))),
          }))
        ),
        { ...clean, stage: 'store', comfyui: { ...clean.comfyui, submission: 'finished' } }
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
