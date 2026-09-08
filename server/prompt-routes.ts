import { HttpError, fields, record, text } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import { defaultProfile } from '../core/product.js';
import { compilePromptProgram, validatePromptProgram } from '../core/prompt-program.js';
import { planNativeMessages } from '../core/provider-messages.js';
import { captureLogicalHistory, compileSnapshotPrompt, promptContext } from './prompt-snapshot.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainProviderRequest, encodeMainPreview } from './main-request.js';
import { freezePackageStates } from './package-behavior-host.js';
import { createHash } from 'node:crypto';
import {
  compileTranslationPrompt,
  createTranslationPlan,
  translationInput,
} from '../core/auxiliary.js';
import { sourceTimeContext } from './product-auxiliary.js';
import { freezeLoreContext } from './lore-context.js';
import { validateLoreContextPolicy } from '../core/lore-context.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';

/** A read-only preview, including unsaved draft blocks. No provider call or Run is created. */
export function promptRoutes(app: FastifyInstance, store: Store) {
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/prompt-preview',
    { bodyLimit: 2_000_000 },
    async (request) => {
      const b = record(request.body);
      fields(b, [
        'program',
        'request',
        'values',
        'branchId',
        'role',
        'loreContext',
        'loreContextReset',
      ]);
      const role = b.role ?? 'main';
      if (!['main', 'translation'].includes(role)) throw new HttpError(400, 'Invalid prompt role');
      if (b.loreContextReset !== undefined && typeof b.loreContextReset !== 'boolean')
        throw new HttpError(400, 'Invalid lore context reset');
      if (role !== 'main' && (b.loreContext !== undefined || b.loreContextReset !== undefined))
        throw new HttpError(400, 'Lore context preview requires the main role');
      const chat = store.chat(request.params.id);
      const branch = store.product.branch(
        chat.id,
        b.branchId === undefined ? undefined : text(b.branchId, 'branch ID', 100)
      );
      const profile = store.product.snapshot(chat.id) ?? {
        ...defaultProfile(chat.id),
        contents: [],
        models: {},
      };
      const program =
        b.program === undefined && role === 'main'
          ? (profile.promptPresets?.main?.program ??
            createDefaultPromptProgram(DEFAULT_MAIN_PROMPT))
          : validatePromptProgram(b.program);
      if (b.loreContext !== undefined)
        try {
          profile.loreContext = validateLoreContextPolicy(b.loreContext);
        } catch {
          throw new HttpError(400, 'Invalid lore context policy');
        }
      if (role === 'main') {
        const selected = profile.promptPresets?.main;
        profile.promptPresets = {
          ...profile.promptPresets,
          main: {
            id: selected?.id ?? 'preview-draft',
            revision: selected?.revision ?? 1,
            title: selected?.title ?? 'Preview draft',
            role: 'main',
            program,
          },
        };
      }
      let snapshot: RunSnapshot = {
        chatId: chat.id,
        parentRevision: branch.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: text(b.request, 'preview request', 500_000),
        history: store.history(branch.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
        branchId: branch.id,
        ...(b.loreContextReset ? { loreContextReset: true } : {}),
      };
      if (role === 'main') snapshot.sourceSegments = freezeSourceSegments(profile);
      snapshot = store.story.prepareRunInTransaction(snapshot);
      snapshot.logicalHistory = captureLogicalHistory(store, snapshot);
      const previewTime = new Date().toISOString();
      snapshot = freezePackageStates(
        store,
        {
          ...snapshot,
          executionClock: { iso: previewTime, unix: Math.floor(Date.parse(previewTime) / 1000) },
        },
        false
      );
      if (role === 'main') snapshot = freezeLoreContext(store, snapshot);
      const values = b.values !== undefined ? record(b.values) : undefined;
      let previewSource:
        | {
            kind: 'stored' | 'synthetic';
            sourceRevision: string;
            sourceHash: string;
            chunkId: string;
          }
        | undefined;
      let compilation: ReturnType<typeof compilePromptProgram>;
      if (role === 'translation') {
        // Existing originals use their frozen source-time context, exactly as a job does.
        // An empty conversation has only explicit preview data; nothing is persisted.
        const source = branch.headRevision
          ? store.source(branch.headRevision)
          : {
              id: 'preview-source',
              chatId: chat.id,
              text: snapshot.request,
              hash: createHash('sha256').update(snapshot.request).digest('hex'),
            };
        const frozen = branch.headRevision
          ? structuredClone(store.run((source as import('../core/types.js').Source).runId).snapshot)
          : snapshot;
        const selected = profile.promptPresets?.translation;
        const preset = {
          id: selected?.id ?? 'preview-draft',
          revision: selected?.revision ?? 1,
          title: selected?.title ?? 'Preview draft',
          role: 'translation' as const,
          program,
        };
        const fixed = {
          ...frozen,
          profile: {
            ...(frozen.profile ?? { ...defaultProfile(chat.id), contents: [], models: {} }),
            promptPresets: { ...frozen.profile?.promptPresets, translation: preset },
            promptControls: {
              ...frozen.profile?.promptControls,
              [`${preset.id}@${preset.revision}`]: {
                values:
                  values ??
                  profile.promptControls?.[`${preset.id}@${preset.revision}`]?.values ??
                  {},
                combinations: [],
              },
            },
          },
        };
        const translationPlan = createTranslationPlan(
          source,
          sourceTimeContext(fixed, 'translation'),
          chat.settings.translationChunkChars
        );
        const input = translationInput(translationPlan, translationPlan.chunks[0].id, fixed);
        compilation = compileTranslationPrompt(
          input,
          fixed,
          'Translate the requested blocks according to the selected prompt and return the specified JSON.'
        )!;
        previewSource = {
          kind: branch.headRevision ? 'stored' : 'synthetic',
          sourceRevision: source.id,
          sourceHash: source.hash,
          chunkId: input.chunkId!,
        };
      } else {
        const context = promptContext(snapshot);
        compilation = !snapshot.story?.waiting
          ? compileSnapshotPrompt(snapshot, program, values).promptCompilation!
          : compilePromptProgram(program, { ...context, ...(values ? { values } : {}) });
      }
      const target = profile.models[role as 'main' | 'translation'];
      let provider = null;
      let error: string | undefined;
      if (target)
        try {
          if (role === 'main' && !snapshot.story?.waiting) {
            const built = buildMainProviderRequest({ ...snapshot, promptCompilation: compilation });
            compilation = built.snapshot.promptCompilation!;
            provider = encodeMainPreview(built.request, target);
          } else {
            const plan = planNativeMessages(
              {
                role: role as 'main' | 'translation',
                modelId: target.modelId,
                stable: { contract: '', tools: [] },
                input: { task: snapshot.request, controls: {} },
                prompt: {
                  compilerVersion: compilation.compilerVersion,
                  messages: compilation.messages,
                  cachePlan: compilation.cachePlan,
                  values: compilation.values,
                },
              },
              target.connection.protocol
            );
            provider = {
              protocol: target.connection.protocol,
              modelId: target.modelId,
              kind: 'mapping-only' as const,
              ...plan,
            };
          }
        } catch (caught) {
          error = (caught as Error).message;
        }
      return {
        compilation,
        provider,
        ...(snapshot.loreContext ? { loreContext: snapshot.loreContext } : {}),
        ...(previewSource ? { previewSource } : {}),
        ...(error ? { error } : {}),
        ...(snapshot.story?.waiting ? { waitingForState: true } : {}),
        scope: 'preview-only-no-provider-call',
      };
    }
  );
}
