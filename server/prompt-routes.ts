import { currentBotTranslationGuide } from './translation-guide.js';
import { readRunSnapshot } from './run-projections.js';
import { HttpError } from './request-validation.js';
import { AppError } from './app-errors.js';
import type { FastifyInstance } from 'fastify';
import { type PromptPreview, promptEndpoints, readerEndpoints } from '#contracts';
import { promptOperations, readerOperations } from '#contracts/operations';
import { registerEndpoint } from './endpoint.js';
import { defaultProfile } from '../core/product.js';
import { compileRisuPrompt, type PromptValue, validateRisuPrompt } from '../core/risu-prompt.js';
import { planNativeMessages } from '../core/provider-messages.js';
import { ProviderContractError } from '../core/provider-errors.js';
import { failureLabel } from './failure-label.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainProviderRequest, encodeMainPreview } from './main-request.js';
import { freezeReservationSnapshot } from './reservation-snapshot.js';
import { createHash } from 'node:crypto';
import { compileTranslationPrompt, translationInput } from '../core/auxiliary.js';
import { sourceTimeContext } from './product-auxiliary.js';
import { validateLoreContextPolicy } from '../core/lore-context.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { builtinPromptTemplate, builtinPromptTemplates } from './builtin-prompts.js';
import { promptWorkspace } from './prompt-workspace.js';
import { translationContextMode } from '../core/translation-settings.js';
import { translationSnapshot } from '../core/translation-context.js';
import { prepareNativeRisuRun } from './risu-native-run.js';
import { prepareNativeRisuTranslationPrompt } from './risu-native-preset.js';
import { requestPreviewRoutes } from './request-preview.js';
import {
  nativeRisuSnapshotNeedsRefresh,
  prepareNativeRisuReadOnly,
} from './risu-native-readonly.js';

type PromptPreviewFailure = { code: string; detail?: string };
function previewFailure(caught: unknown): PromptPreviewFailure {
  if (!(caught instanceof ProviderContractError)) {
    process.stderr.write(`PROMPT_PREVIEW_FAILED ${failureLabel(caught)}\n`);
    return { code: 'PROMPT_PREVIEW_FAILED' };
  }
  const split = caught.code.indexOf(':');
  return split < 0
    ? { code: caught.code }
    : { code: caught.code.slice(0, split), detail: caught.code.slice(split + 1) };
}

export function promptRoutes(app: FastifyInstance, store: Store) {
  requestPreviewRoutes(app, store);
  registerEndpoint(app, promptEndpoints.listTemplates, promptOperations.listTemplates, () =>
    builtinPromptTemplates()
  );
  registerEndpoint(app, promptEndpoints.readTemplate, promptOperations.readTemplate, ({ id }) => {
    const template = builtinPromptTemplate(id);
    if (!template) throw new HttpError(404, 'Unknown prompt template');
    return template;
  });
  registerEndpoint(
    app,
    readerEndpoints.previewPrompt,
    readerOperations.previewPrompt,
    async (b): Promise<PromptPreview> => {
      const role = b.role;
      const chat = store.chat(b.chatId);
      const profile = store.product.snapshot(chat.id, role, chat.headRevision) ?? {
        ...defaultProfile(chat.id),
        models: {},
      };
      const program =
        b.program === undefined
          ? (profile.promptPresets?.[role]?.program ?? createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT))
          : validateRisuPrompt(b.program);
      if (b.role === 'main' && b.loreContext !== undefined)
        try {
          profile.loreContext = validateLoreContextPolicy(b.loreContext);
        } catch {
          throw new AppError(400, 'INVALID_REQUEST');
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
      const base: RunSnapshot = {
        chatId: chat.id,
        parentRevision: chat.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: b.request,
        history: store.history(chat.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
        ...(b.role === 'main' && b.loreContextReset ? { loreContextReset: true } : {}),
      };
      let snapshot = freezeReservationSnapshot(store, base, {
        purpose: role === 'main' ? 'preview-main' : 'preview-translation',
        executionClock: () => {
          const iso = new Date().toISOString();
          return { iso, unix: Math.floor(Date.parse(iso) / 1000) };
        },
      });
      const values = b.values as Record<string, PromptValue> | undefined;
      let previewSource:
        | {
            kind: 'stored' | 'synthetic';
            sourceRevision: string;
            sourceHash: string;
          }
        | undefined;
      const translationGuide =
        role === 'translation' ? currentBotTranslationGuide(store, chat.id) : undefined;
      let compilation: ReturnType<typeof compileRisuPrompt>;
      if (role === 'translation') {
        const source = chat.headRevision
          ? store.source(chat.headRevision)
          : {
              id: 'preview-source',
              chatId: chat.id,
              text: snapshot.request,
              hash: createHash('sha256').update(snapshot.request).digest('hex'),
            };
        const frozen = chat.headRevision
          ? structuredClone(
              readRunSnapshot(store, (source as import('../core/types.js').Source).runId)
            )
          : snapshot;
        const selected = profile.promptPresets?.translation;
        const preset = {
          id: selected?.id ?? 'preview-draft',
          revision: selected?.revision ?? 1,
          title: selected?.title ?? 'Preview draft',
          role: 'translation' as const,
          program,
        };
        const policy = promptWorkspace(store).translationPolicy;
        const mode = translationContextMode(policy.contextMode);
        const fixed = translationSnapshot(
          {
            ...frozen,
            translationGuide,
            profile: {
              ...(frozen.profile ?? { ...defaultProfile(chat.id), models: {} }),
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
          },
          mode
        );
        const evaluated = await prepareNativeRisuTranslationPrompt(
          nativeRisuSnapshotNeedsRefresh(fixed)
            ? await prepareNativeRisuReadOnly(fixed, 'auxiliary')
            : fixed
        );
        const input = translationInput(
          source,
          sourceTimeContext(evaluated, 'translation', policy.previousSceneTokens),
          evaluated,
          mode
        );
        compilation = compileTranslationPrompt(
          input,
          evaluated,
          'Translate the complete source according to the selected prompt. Return the translated text only.'
        )!;
        previewSource = {
          kind: chat.headRevision ? 'stored' : 'synthetic',
          sourceRevision: source.id,
          sourceHash: source.hash,
        };
      } else {
        if (program.nativeRisuPreset) {
          const selected = snapshot.profile!.promptPresets!.main!;
          snapshot.profile = {
            ...snapshot.profile!,
            promptControls: {
              ...snapshot.profile!.promptControls,
              [`${selected.id}@${selected.revision}`]: {
                values:
                  values ??
                  snapshot.profile!.promptControls?.[`${selected.id}@${selected.revision}`]
                    ?.values ??
                  {},
                combinations: [],
              },
            },
          };
        }
        snapshot = await prepareNativeRisuRun(snapshot, { preview: true });
        compilation = compileSnapshotPrompt(snapshot, program, values).promptCompilation!;
        compilation.warnings.push(...(snapshot.nativeRisuExecution?.issues ?? []));
      }
      const target = profile.models[role];
      let provider = null;
      let error: PromptPreviewFailure | undefined;
      if (target)
        try {
          if (role === 'main') {
            const built = buildMainProviderRequest({ ...snapshot, promptCompilation: compilation });
            compilation = built.snapshot.promptCompilation!;
            const evaluation = target.evaluationTools;
            provider = encodeMainPreview(built.request, target, {
              codexNative:
                target.connection.protocol === 'codex-app-server-v1' &&
                !(
                  evaluation?.contextMode === 'preloaded' &&
                  evaluation.approvalReasoningMode === 'economized'
                ),
            });
          } else {
            const plan = planNativeMessages(
              {
                role,
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
          error = previewFailure(caught);
        }
      return {
        compilation,
        provider,
        ...(translationGuide !== undefined ? { translationGuide } : {}),
        ...(snapshot.loreContext ? { loreContext: snapshot.loreContext } : {}),
        ...(previewSource ? { previewSource } : {}),
        ...(error ? { error } : {}),
        scope: 'preview-only-no-provider-call',
      };
    }
  );
}
