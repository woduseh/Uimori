# Providers, Codex, execution, context and illustrations

Developer-only technical sections extracted verbatim from `docs/PROVIDERS.md`, `docs/CODEX.md`, `docs/MODEL-PARAMETERS.md`, `docs/MODEL-PRICING.md`, `docs/GLOBAL-MODELS.md`, `docs/EXECUTION.md`, `docs/GENERATION.md`, `docs/CONTEXT-LIMITS.md`, `docs/AGENT-COLLABORATION.md`, `docs/EVALUATION-TOOLS.md`, `docs/ILLUSTRATIONS.md`, and `docs/INPUT-TRANSLATION.md`.

## Providers and transport encoding

This section defines the developer/agent contract covering provider integration internals, transport encoding, concurrency, and diagnostics.

### Request conversion and ownership boundaries

- `core/model-request-fields.ts`: Extracts only the model ID, provider options, and frozen pricing snapshot from an execution snapshot to build the request object. Each caller independently decides generation options, context budgets, tool definitions, and storage and execution policies.
- `server/provider-connections.ts` and `server/credentials.ts`: Own connection input validation and credential storage (DB reads/writes). Saving a connection runs final URL validation and project validation for a newly selected or previously stored Vertex service account atomically in the same transaction; resource editing and legacy backup verification do not intervene in the provider transport path.
- `server/main-request.ts`: Shared context measurement path unifying per-provider requests and per-model tokenizer budgets across context planning, automatic compaction, and next-request size previews.
  - Measures against the actual outgoing request and checks whether a summary is included.
  - Sends Gemini conversations as native text preserving roles and ordering, and retains measurement for both Codex execution formats and helper-only input formats.
- Prompt-shape validation neither copies nor mutates original data; inputs needing mutation and provider continuation state are copied at ownership boundaries.
- Calls that do not consume a public stream skip assembling intermediate display prose while preserving final results, usage, and cancellation handling.

### Per-protocol image and message encoding

- **Main-story reference image transport formats**:
  - OpenAI Responses: `input_image`
  - OpenAI Chat / Vercel: `image_url`
  - Anthropic Messages: `image`
  - Google Gemini / Vertex AI: `inlineData`
  - Codex: dedicated image input object (Codex's image generation tool is not enabled)
- **Image restrictions**:
  - Direct DeepSeek connections and explicitly confirmed text-only models reject image inputs; custom models with unconfirmed image support are allowed to send in an unconfirmed-support state.
  - The user image attachment UI appears on main-story requests; sending candidates for image placement judgment is configured separately under judgment provider options.
- **Vercel Chat conversion**: Concatenates text parts from prior assistant messages in order into a single string before sending.
- **OpenAI Responses conversion**:
  - Builds manual conversation history (including assistant turns) out of `input_text` parts while preserving per-part cache breakpoints.
  - Follow-up tool requests replay the message, reasoning, and tool-call items actually returned by the provider using their original format and IDs.
- **Gemini conversation and tool handling**: Follow-up requests after tool calls preserve the model's original response and thought signature, placing additional control text within the same user turn before tool results (`functionResponse`) to avoid Vertex endpoint rejections (Claude, OpenAI, and Codex request formats remain unchanged).
- **Gemini mid-conversation system conversion**:
  - On requests targeting Gemini model IDs (including gateway IDs like `gemini-…` and `google/gemini-…`), non-leading system messages are converted to `user` at send time only and emit a `GEMINI_MID_SYSTEM_TO_USER` diagnostic without modifying the original prompt.
  - Direct connections apply this because Gemini API and Vertex AI references allow only `user` and `model` roles in `contents`, and gateway connections apply it conservatively due to unconfirmed support.
  - Governed by `acceptsMidConversationSystem` in [per-model capabilities](../../core/model-capabilities.ts).
- **Anthropic message normalization**:
  - When sending a prompt structured as `user → 연속 system → user` (`user` → consecutive `system` → `user`), appends one short synthetic completed assistant reply at the end of the system block for transmission only.
  - The original prompt and execution snapshot's roles, ordering, prose, and cache breakpoints are not moved, and the insertion is recorded only in request-preview diagnostics.
  - Follow-up tool requests replay stored messages verbatim without duplicating the synthetic reply.
- **DeepSeek error handling**:
  - When a response ends with `insufficient_system_resource` or `aborted`, preserves received prose and final usage and records the run as incomplete.
  - Incomplete tool calls are neither executed nor automatically retried, and remote abort reasons are distinguished from unsupported response formats in execution records.

### Anthropic Batch architecture

- Does not run a custom batch scheduler; submits a single request to the Anthropic Batch API per model call and reuses the existing `runMain` tool loop as-is.
- When Claude requests a tool, executes it locally and submits the next turn as a new Batch; once `story.submit` is called, terminates the task with no further calls.
- Persists `runId`, `attemptId`, `batchId`, `customId`, and the request hash in SQLite so the same Run and Batch can be re-queried and recovered across server restarts, reusing stored Batch results and tool receipts to prevent duplicate execution.
- In an ambiguous creation failure where `batchId` was never persisted, finalizes the run as failed instead of auto-resubmitting to prevent double billing.
- Provider response body reads—including JEV and Responses—abort on task cancellation and timeouts; once completion or error is finalized, response stream cleanup is requested without awaiting remote cleanup confirmation so latency cannot block finalization.

### Cache-breakpoint diagnostics and tool contracts (`cacheBoundaries`)

- Execution request records for OpenAI Responses and Anthropic include `cacheBoundaries`, an explicit cache-breakpoint diagnostic record.
- Each entry stores the breakpoint position, a hash covering preceding input plus tool and generation settings, and the diagnostic JSON byte count. Changes after lore keep earlier breakpoint hashes intact, whereas changes to tool schemas, tool ordering, or prior tool history before a breakpoint alter the hash.
- Existing `stablePrefixSha256` remains a hash of shared contracts and tools only and is not used as proof of whole-prompt cache reuse; breakpoints are never inferred or fabricated for requests with only implicit caching.
- These diagnostics are appended only to local request records (for both live and Batch runs) and are excluded from provider payloads.
- Anthropic Messages sends the `anthropic-version: 2023-06-01` header. Uimori tool names are transmitted via provider-compatible aliases while preserving stored tool names, arguments, results, and call IDs.
- Prior evaluation history excluded from the current tool list retains its original valid names, and tool definitions follow the [official tool definition contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

### Lore-inclusion record metadata

- When dispatching main-story or translation requests, the host attaches compact lore-inclusion metadata inside the existing request JSON.
- Merely appearing by name in a resource list or being picked by the judgment model does not confirm actual prose inclusion; candidates whose inclusion could not be verified (such as after prompt transformations) are marked separately, and legacy requests without this record are not assumed to have excluded lore.
- Lore bodies are not duplicated into this record, the metadata is never sent to the model, and it follows the existing retention scope of request records.

### Concurrent edits and streaming prose assembly

- Enabling or disabling providers and models does not delete data and takes effect immediately starting with the next call.
- Unsaved input is protected across editor view switches; if changes were saved elsewhere first, the UI preserves the current draft and prompts to reload the latest settings.
- Settings read APIs return only editable settings and never return raw API keys; key inputs in unsaved drafts reside solely in browser memory and are never written to local recovery storage.
- Live streaming delivers decoder-validated append chunks alongside their UTF-16 end index rather than re-comparing the full string on every chunk.
- Prefix validation is kept across full-text snapshots or boundaries where earlier text changed, and completion verifies that the concatenation of accumulated chunks matches the final text; reasoning traces, tool arguments, final submission envelopes, and structured translations are excluded from public chunks.

## Codex App Server protocol and isolation

This section defines the developer/agent contract for Codex App Server process lifecycle, protocol specifications, isolation environment, and verification.

### App Server communication and turn lifecycle

- Uimori calls the official CLI's App Server protocol methods: `initialize`, `account/*`, `model/list`, `thread/start`, and `turn/start`.
- For main-story Runs, the writer, advisor, and helper each execute **one task in one thread/turn** to completion and handle host tool results within the same turn.
- Translation and context compaction retain existing per-request ephemeral execution; separate hypothetical-scene execution for the helper is not provided.
- During main-story evaluation, only the first `preloaded + economized` step uses the existing low-cost request path before switching to native writing at the configured reasoning effort. Cross-task native thread resume metadata and opaque continuation state are not persisted in the DB.
- Text roles send concise Uimori writing, translation, or summary instructions via `thread/start.baseInstructions` to replace the model's default coding instructions. The helper (`helper`) uses dedicated instructions tailored to resource lookup, editing, and verifying saved results.
- The initial request delivers the task, prior conversation, resource scope, and registered tools; if the helper's initial history exceeds the input budget, Uimori may run context compaction before starting. Once a native turn starts, Uimori does not re-bundle history or start a new turn per tool result; in-turn progression and context compaction are owned by Codex.
- RisuPrompt's logical roles, ordering, and empty messages are sent as JSON, preserving message IDs, provenance kinds, and source revisions/hashes while excluding internal host block/run IDs and redundant completion status on always-completed messages.
  - Separate `input.task` duplication is omitted only when a single current user message matches the request body verbatim.
  - Because Codex adds its own instructions, message role interpretation may differ from native APIs; assistant prefill and required cache directives are rejected before execution.
- `reasoningEffort` and timeout are forwarded; temperature settings are not permitted. For general roles, `maxOutputTokens` is passed as a soft `outputTokenBudget` rather than a provider-enforced cap—output is not padded to fill it, and explicit prompt length directives (such as word counts) take precedence.
- Structured output for general roles and internal per-role result validation are retained; the native helper does not enforce a final JSON envelope or `outputSchema`.
- An RPC attempt is recorded before sending, with concurrency capped at 2 active executions and up to 32 queued items (all cancellable).
  - Uimori does not auto-replay after restarts, send failures, or uncertain outcomes.
  - Official CLI 0.153 rejects overriding retry settings, so internal CLI retries or duplicate calls may occur; explicit harness retries and bounded retries on cleanly completed results are recorded as separate judgment requests.
- One attempt represents one host-initiated Codex turn and does not equal internal model-call count; multiple tool and model decisions by the native helper log as one attempt, whereas pre-start context compaction calls log separately.
  - Actual cost and internal model-call counts remain `null`, while turn-wide timeout, cancellation, and host tool permissions apply; Vertex USD budgets are never interpreted as Codex subscription budgets.
- Raw usage preserves only numeric input, cached, output, and reasoning tokens from provider-reported `tokenUsage.total` and `last`, updating input/output totals from the latest `total` snapshot without double-counting repeated updates, re-adding cached tokens, or zero-filling omitted fields.
  - Illustration raw usage also retains per-kind completed item counts (`itemCounts`) and usage event counts (`tokenUsageUpdates`), excluding image bytes and tool contents.

### Native execution for main writing and advice

Automatically applies whenever a Codex writer or advisor is selected in a real main-story Run—no new provider setup or user toggle is required.

- **Independent execution support**: Even when the main model uses another external provider, an advisor configured with a Codex model uses native execution.
- **Context and tool delivery**:
  - The main writer preserves exact roles, ordering, source text, lore, plot/outline, and prior results from `buildMainProviderRequest` and `editRequest`, passing only tool schemas as native tool registrations.
  - Advisors use dedicated requests, models, instructions, and explicit drafts/evidence without blindly copying the writer's full prompt; the existing `agents.consult` contract holds (advisors cannot call sub-advisors or save prose), and pre-writing consultations run in their existing order.
- **Submission detection and early termination**:
  - Once a writer's `story.submit` or valid `eval_submit_artifact` tool call is observed, the host skips sending a normal tool response, immediately invokes `turn/interrupt`, and cleans up the process.
  - Only that host-confirmed submission succeeds—user cancellation, timeout, connection changes, or write failures are never promoted to success.
  - No follow-up confirmation prose is requested; source persistence goes through the existing judgment model verdict, response post-processing, and atomic completion pipeline.
  - Main runs with evaluation tools off still support normal final text, whereas evaluation-enabled `model-selected` and `preloaded` runs both require a valid `eval_submit_artifact`; streaming is not added for main-writer or advisor turns.
  - Usage on host-submission termination records `completion: host-submission` and `usageComplete: false` so it is not mistaken for final billed usage.
- **Context planning and evidence tracking**:
  - During native execution, Uimori neither rebuilds prompts per tool call nor runs duplicate context compaction; `editRequest` runs only when the real host request begins, not on each internal reasoning step.
  - Initial context planning uses the larger estimate between legacy and native inputs for reuse across an economized first step, then re-checks against the actual native descriptor right before sending.
  - Initial `requestLore`, subsequent `tool_events`, and advisor `agents.read` calls are separate evidence records; resources read later are never retroactively attributed to initial input.
- **Host callbacks and call limits**:
  - Call limits count host-initiated requests and native executions (not internal reasoning steps, and read tools do not add 1 model call each).
  - Advice cache hits are not re-billed; judgment-model calls and separate advisor executions count individually. An active native writer continues in the same turn after consultation and does not reserve a next writer call, whereas pre-writing consultation and the legacy provider loop reserve 1 writer call (keeping post-processing reservation intact).
  - Evaluation has no manual round setting: native main runs handle up to a fixed cap of 10 non-terminal host tool callbacks (including failed submissions) and accept a valid final submission separately.
  - HTTP main and translation runs apply both a maximum of 11 provider requests and the existing overall call and time limits.
- **Synthetic stdio integration tests**: `tests/codex-writing.test.ts` verifies writing, consultation, cache reuse, child-slot allocation, cancellation propagation, submission detection, and economized-mode transition logic.

### Built-in tools and isolation boundaries

- **Disabled tools**: Terminal shells, filesystem read/write, Node REPL, local image viewing, direct browser/computer control, external apps/MCP, external skills, persistent memory, built-in subagents, and extra permission approval prompts are all disabled. This protects host files, credentials, and external mutation rights while preserving Uimori's storage, collaboration, and context-management boundaries.
- **Code Mode isolation spec**: `code_mode` is an isolated V8 JavaScript executor distinct from Node REPL. Its contract allows calling only registered tools and exposes no Node, filesystem, or network APIs and no module imports (`core/codex-protocol.ts`, `server/codex-runtime.ts`).
- **Namespace isolation**: Excludes the default `functions` namespace so shell/file tools cannot resurface through nested execution paths. Uimori host tools register solely under the `uimori` namespace (`type: "function"`) of experimental `dynamicTools`, transmit with an `uimori_...` prefix to satisfy API constraints, and restore original names on the host; calls are accepted only when both the active thread/turn and `uimori` namespace match, and duplicate call IDs are rejected.
- **Tool results and response streaming**:
  - Legacy roles like translation return final responses in a JSON envelope, whereas native main/advisor/helper turns answer `item/tool/call` requests with `contentItems`/`success`.
  - Helper final replies are plain text: public text under `final_answer` streams live, while commentary logs as separate progress events and never mixes into the final answer.
  - Intermediate results and plans from built-in search/compute are not saved as prose; legacy responses lacking a phase fall back to the last message as the final candidate when no follow-up work remains.

### Explicit server-internal multi-turn sessions

- `CodexRuntime.createSession(connection)` is an in-memory session object owned by the caller and closed via `close()` in a `finally` block.
- Sequential calls to `execute`, `executeAgent`, and `generateImage` reuse the first turn's isolated process and ephemeral thread (existing single-turn methods close the process after each request).
- Sessions pin connection, model, base/developer instructions, and tool permissions, and reject concurrent turn execution. Sessions are never shared across users or independent tasks, and resume metadata is never persisted in the DB.
- Per-turn cancellation, timeout, and connection checks remain enforced; after any failed or uncertain turn, the session closes and is not reused.
- **Consecutive illustration cut reuse**:
  - Consecutive Codex illustration cuts sharing the same source hash and storyboard plan reuse this session while maintaining **a separate turn, job, attempt, and result per cut**.
  - Successful cuts save immediately and only failed cuts retry under existing policy; different plans, chats, connections, regenerations, or requests incompatible with session input budgets or pinned settings run independently, and multiple variants of one cut are never assigned to different cuts.
- **Session cumulative token checks**:
  - A session's local history includes host tool arguments and text responses; when Codex reports cumulative input/output tokens, the next turn must fit that cumulative total plus the new request estimate within the model's input budget.
  - If tool, image, or reasoning items occurred without usable token reporting, the session rejects the next turn and illustrations execute independently; cumulative usage may exceed actual active context.

### Local verification and official contracts

```powershell
npx vitest run tests/codex-process.test.ts tests/codex-runtime.test.ts tests/codex-protocol.test.ts tests/codex-image.test.ts tests/codex-integration.test.ts

# Verify installed CLI initialization and experimental tool schemas: fresh empty auth directory, no login or model calls
$env:UIMORI_CODEX_PREFLIGHT='1'
npx vitest run tests/codex-installed.test.ts
Remove-Item Env:UIMORI_CODEX_PREFLIGHT
```

- **Preflight results**: Installed preflight results are written to `output/codex-preflight/summary.json`, verifying the real binary version, empty auth state, and `generate-json-schema --experimental` contracts for `dynamicTools` function format, `item/tool/call` requests, and text tool responses.
- **Unit and integration tests**:
  - Synthetic stdio tests verify auth cancellation, non-suppression of errors, normal event handling, timeouts, exit races, separation of built-in tool progress from final responses, environment/approval boundaries, queue cancellation, pre-send attempt logging, consecutive tool calls in one turn, duplicate-call blocking, and late responses after cancellation.
  - App integration tests cover general roles, native helper, registration suggestions, export/import, disabled providers, and auth/Origin boundaries.
- **Provider verification**: `npm run verify:providers` verifies Codex settings at a 390px viewport, mocked login, cancellation, and disconnect flows.
- **Official references**: [App Server specification](https://learn.chatgpt.com/docs/app-server), [Authentication guide](https://learn.chatgpt.com/docs/auth), [Configuration schema](https://learn.chatgpt.com/config-schema.json).

## Model parameters, cache quirks and connection tests

Authoritative option definitions live in [model families](../../core/model-family.ts), [protocol definitions](../../core/provider-definitions.ts), and [per-model hints and value validation](../../core/model-capabilities.ts). Model IDs, limits, and option lists are not duplicated in documentation; showing a family's option list differs from confirming that a specific model supports every option, and only values verified against provider catalogs or review tables appear as confirmed hints.

- **Claude Opus 5.5**: Cache support is confirmed for exact model ID `claude-opus-5-5`, and authored breakpoints are sent even when cache settings are unspecified. Adaptive thinking is always enabled with default effort `medium`, forced tool calling is unsupported, and saved generation settings are not rewritten automatically.
- **Claude Fable 5.2 · Mythos 5.2**:
  - Cache support is confirmed for exact model IDs `claude-fable-5-2` and `claude-mythos-5-2`; Mythos 5.2 has identical specifications and is available only to Anthropic-verified organizations.
  - Adaptive thinking is always enabled with default effort `high`, and forced tool calling is unsupported.
  - These models reject with HTTP 400 any request whose `system`, `tools`, or prior messages preceding a thinking block changed; within one execution's tool round-trips, initial `system`, `tools`, messages, and response blocks replay verbatim with new turns appended only at the end, and follow-up requests whose instructions, tools, or inputs changed are rejected before transmission.
- **GPT-5.6 and later Responses**: Currently confirmed TTL is 30 minutes (`30m`) only. Selected mode passes via `prompt_cache_options.mode` and breakpoints via `prompt_cache_breakpoint`.
- **GPT-6.2 Responses**: `gpt-6.2-astra` and `gpt-6.2-sol` append top-level `instructions` after `input`. For model IDs matching `gpt-6.2` or `gpt-6.2-…` (including IDs with a `provider/` prefix), shared instructions are sent as the first `developer` message in `input` and top-level `instructions` is omitted; cache breakpoint and `prompt_cache_options` positions stay unchanged, earlier models are unaffected, and both models reject reasoning effort `none`.
- Specifying a TTL requires choosing explicit or automatic cache mode; combinations with cache OFF or unspecified mode while a TTL remains set are rejected from saving until corrected.
- **Gemini**:
  - Existing implicit caching is handled by the provider; Gemini 4 Argon and Carbon do not support explicit `cachedContents` caching.
  - Implicit caching may apply on shared prefixes starting around 6,144 tokens on Vertex and 4,096 tokens on Google AI Studio for Argon, and around 4,096 tokens on both paths for Carbon (hits are not guaranteed).
  - Argon and Carbon support only `LOW`/`MEDIUM`/`HIGH` reasoning effort, omit temperature and `top_p` (ignored by the models), and cap direct REST streaming output at 65,536 tokens.
  - Gemini 4 Neon supports `LOW`/`MEDIUM`/`HIGH`/`XHIGH` with default `HIGH`, sharing Argon and Carbon's temperature/`top_p` omission and 65,536-token cap; automatic `continuation_token` re-invocation for long outputs is not yet supported.
  - Because this app has neither `cachedContents` create/update/delete operations nor project-wide implicit cache controls, it does not offer cache OFF or TTL controls for Gemini; cache support is also not inferred for Chat, Vercel, or OpenAI-compatible providers.
- **Connection tests**: The server logs a separate local diagnostic before sending, never re-sends identical idempotency keys, and caps concurrent tests for the same model at one. Tests interrupted by a restart finish as interrupted without automatic replay; `provider_connection_tests` is excluded from portable per-resource/chat backups and included in full SQLite backups.

### Storage and execution boundary

- Model revisions store generation options, and Run/job snapshots freeze them so main prose, translation, context compaction, helper, and card-script assistance pass the same fields via the shared extractor.
- At call time, the current provider's enabled state and credentials are verified. Evaluation economized mode lowers output caps and effort only on explicit opt-in without altering other bindings.

## Model pricing and cost estimation

### Execution and storage contract

- Model `pricing` settings save via normal revision CAS; queuing a new job freezes unit rates, source, verification date, and context tiers in `ModelSnapshot.pricingSnapshot`, so later pricing edits never reprice past runs.
- Request pricing information is host metadata and is never sent in provider HTTP/RPC payloads. Pricing and start time are recorded on the attempt right before sending; server-forced Vertex Flex also uses the Flex rates frozen at queue time.
- On completion, `response.estimatedCost` stores the calculation result plus per-item tokens, rates, and amounts. Existing `cost_usd` is reserved solely for provider-reported actual cost and never turns `null` into an estimate or `0`; no schema or production DB migration is needed.
- Per-provider input/cache summation semantics are distinguished to avoid double counting: Anthropic normalized input already includes cache tokens and uses raw usage's input/cache split, and reasoning/thinking tokens already included in output are not added again.
- Vercel cache writes prefer top-level `cache_creation_input_tokens` and fall back to legacy `prompt_tokens_details.cache_write_tokens` only when absent. Write tokens without a known rate stay as a partial sum, and raw usage `cost` is not automatically treated as provider-reported cost.
- Missing usage or unit rates leave overall estimated cost unknown while showing confirmed items as a partial sum; an item with explicitly `0` usage costs `0` even if its rate is unknown. For Vertex, omitted cache-read fields in usage containing a valid `promptTokenCount` are interpreted as proto3 default `0`, while missing usage overall or explicit `null` remains unknown.
- Calls rejected by the provider for rate limiting (HTTP 429) record `0` input and `0` output tokens because the status arrives before any response body starts and the model never ran.
  - With zero total input, cache-read and cache-write items also compute as `0`, yielding an estimated cost of `0`; other HTTP errors and dropped connections remain unknown because provider execution is uncertain.
  - This prevents helper retries after rate limits from turning a task's usage total unknown; defined by `rateLimitedCallUsage` in `core/provider-http-error.ts` and verified in `tests/provider-http.test.ts`, `tests/vertex-transport.test.ts`, and `tests/pricing-estimate.test.ts`.
- Cost is not estimated when the actual service tier differs from the frozen pricing tier; Anthropic `standard_only` matches the `standard` response tier. New Anthropic Batch reservations freeze explicitly entered Batch rates without extra discounting, while legacy Batch snapshots queued before the update keep their 50% discount calculation, and existing unknown calls are not retroactively calculated at newer rates.
- The main view shows estimated costs for writing and writing assistance, whereas follow-up tasks like translation and title generation appear separately in task activity; detail views separate provider-reported cost from estimated cost.
- Usage from retired helper hypothetical-scene generation persists under `helper-artifact` and its context summary calls under `summary`, even after hypothetical-scene generation is retired.
- Full SQLite backups preserve stored pricing snapshots and estimates, while portable per-resource/chat backups omit provider/model settings and call records. Pricing never acts as an execution gate or cumulative spend limit, and cancellation, deduplication, uncertain-execution, and source-attribution contracts remain intact.

Verification lives in `tests/model-pricing.test.ts`, `tests/pricing-estimate.test.ts`, `tests/pricing-store.test.ts`, `tests/pricing-transport.test.ts`, and `tests/model-pricing-browser.spec.ts`.

## Global models and prompt workspace

- `GET /api/model-workspace` returns `{revision, routes, translationPolicy, summaryLength, mainJudgmentEnabled, mainJudgmentThreshold, judgment, titleModel, helperModel, helperTaskTimeoutMinutes, helperConfirmPaidGeneration, contextModel, scriptModel}`, and `PUT` guards concurrent edits with `expectedRevision`.
- Optional feature models and `scriptModel` are `{id}` references or `null` and keep existing values when omitted from `PUT`. `helperTaskTimeoutMinutes` and `helperConfirmPaidGeneration` (confirmation before paid generation requests from the helper, default `false`; see [Helper tools](../HELPER-TOOLS.md#confirmation-before-destructive-or-bulk-operations)) likewise preserve existing values when omitted.
- `judgment` is `{provider:'typesafe'}` or `{provider, connectionId, modelId, images}`; legacy DBs read JEV as default, and omitting `judgment` in `PUT` keeps the stored judgment provider.
- `summaryLength` controls the [summary length](../CONTEXT-LIMITS.md#공통-요약-지침과-출력-여유) for main writing and helper tasks. Because these settings share the `prompt_workspace` JSON row with prompt selection, concurrent model and prompt save conflicts share CAS handling.
- Writing and translation prompts store only preset IDs and explicit default options, reading prompt bodies and default options from the latest saved source while historical runs keep their intake snapshots.
- For DB/archive versions and supported upgrades, see [data migrations](../DATA-MIGRATIONS.md). New DBs start with unassigned role models and do not adopt model values from chat bodies as defaults; unsupported legacy DBs/archives are not arbitrarily converted.
- A chat's API `profile.routes` is a read-only projection of currently effective settings including any pinned main model, while per-chat overrides store IDs in `profile.pinned.mainPromptPresetId` and `profile.pinned.mainModel`. In profile updates, omitting `pinned` keeps pins, `{}` clears all pins, and `expectedRevision` guards conflicts; archived Runs' `snapshot.profile.routes/models` hold historical frozen settings.

### Reading defaults in the UI

- Views sharing `usePromptWorkspace()` in the same tab share one read state and change-notification subscription. If a save, cross-tab change, or focus-return notification arrives mid-read, the stale response is discarded and a fresh read follows immediately.
- Once the last view unsubscribes, any in-progress read is aborted and the cache is cleared; editor drafts and queued execution snapshots stay separate from this read cache and are never mutated by it (`web/prompt-workspace-store.ts`, `tests/prompt-workspace-store.test.ts`).
- `CurrentPrompt.defaultValues` holds the preset's latest saved defaults, `optionValues` holds explicit default user overrides, and `values` is their merged effective result. Selecting the default in settings clears the user override to use the latest saved preset value; Run snapshots freeze only effective values, omitting `defaultValues` and `optionValues`.
- Legacy standalone or unnamed current prompts are preserved as separate presets on boot, keeping options that differed from legacy defaults as user-specified values.
- The chat title model is the optional `titleModel` entry under **설정 → 역할별 모델** (Settings → Role models), defaulting to unassigned (disabling auto-title generation) and never falling back to the main model. When configured, it generates a title once after a new chat's first successful response without overwriting manual titles, and is excluded from `TaskRole` (main/translation/image) and chat `profile.routes`.
  - New chats with a manually entered title, existing chats, and forks are excluded from auto-generation. At generation start, the model, provider, and first response are frozen, requesting a work title capturing scene imagery, tension, and atmosphere in the UI language active when the chat was created.
  - Runs at most once under the selected model's output budget (no separate title length cap) within the title model's timeout (default 300 seconds). Models listing reasoning/effort options in `core/model-capabilities.ts` send the lowest option for title requests only; models without a list send their preset value unchanged.
  - Logs an attempt before sending with no auto-retry after failure or restart, and discards late results if a manual title save, source edit, or chat deletion occurs.
  - Titles can be edited manually from the chat menu: `PATCH /api/chats/:id/title` uses `expectedTitleRevision` backed by title event revisions to protect manual intent and guard against ABA conflicts even on identical strings, without bumping source, settings, or folder revisions.

## Execution input lifetime, Batch recovery and response streams

- **Reference image storage and normalization**:
  - Reference images persist as user request attachments in `RunSnapshot.requestImages`, deduplicating image bytes by hash in `image_blobs`. Preserved originals normalize still-image pixels losslessly to WebP, while transmission copies freeze separately within 2048px on the long edge and 2MiB (both input files and preserved originals cap at 64MiB each).
  - Conversion runs outside DB transactions while sharing existing image-processing concurrency limits, and final bytes plus request attribution commit in the same intake transaction; intake re-verification checks existing receipts before reading consumed or expired uploaded files.
- **Unsent draft persistence and tab isolation**:
  - Unsent draft prose writes to `sessionStorage` immediately on input; IndexedDB persists prose and the attachment list in one transaction, modifying stored image files only when attachments are added or removed.
  - `sessionStorage` generation counters and acceptance tokens prevent stale recovery copies from overwriting newer prose or accepted requests. Web Locks own the active tab's draft namespace and cloned tabs copy into a separate namespace; on browsers without Web Locks, normal new tabs remain isolated, though concurrent edits in tabs duplicating `sessionStorage` may not be isolated.
- **Image attachment identity through prompts and re-saves**:
  - Original message identifiers for request images persist through prompt processing; only user messages in the selected `chat` range forward attachments, and images are never guessed onto ChatML strings copied via CBS.
  - Lua `editRequest` must preserve message `id` to support reordering images; losing an ID, duplicating an ID, or changing role on an image-bearing message aborts with a clear error. Empty-text image turns are distinguished from deleted turns (deleted image turns are never recreated), and text contracts for non-image scripts stay intact.
  - Native buttons and manual triggers preserve per-user-message attachment bindings on scene re-save; merging messages into a single scene exceeding 8 attachments aborts before saving while preserving prose, attachments, and variable state, whereas separate scenes with up to 8 attachments each continue normally.
- **Deferred image resolution and token allowances**:
  - Model requests, follow-up tool state, and diagnostics hold only immutable image references, resolving bytes right before transmission after checking pinned attachments and SHA-256 hashes (Anthropic Batch recovery computes the same request hash from frozen transmission copies).
  - Image base64 data is not counted as text tokens; a resolution-based allowance from `conservative-dimensions-v1` (an estimate, not a model-specific formula or billed count) is added separately, and transmission byte limits are checked independently of token budgets.
- **History reuse and hash caching**:
  - Main-story conversation history uses the fresh items returned by source validation without copying full history that will immediately be overwritten or cloning again after selecting recent scenes, keeping request items separated from original snapshots.
  - Computed hashes reuse via an object-lifetime WeakMap when the same source object's text is unchanged and recompute on text changes (still verifying provided hashes against current source), requiring no expiry settings, invalidation service, or source clones.
- **Lore selection and local candidate search**:
  - Main runs load valid prior lore, run required conversation compaction, and select lore when needed; small lists fitting the input budget are judged in full.
  - Large lists locally search selectable lore across all attached resources pinned to the run and pack full bodies into the judgment model's input budget ordered by relevance to the current request and recent conversation, never restricting by folder or attachment order and continuing to inspect subsequent entries when one exceeds remaining budget.
  - `core/candidate-search.ts` uses term rarity and frequency across titles and bodies plus two-character cues for Korean and Japanese, without extra APIs, embedding models, or persistent index settings.
- **Pruning unfinished runs and minimal receipts**:
  - Unfinished main runs (failed, cancelled, interrupted, refused, or partial) prune frozen conversation history, resource, and prompt copies upon termination, retaining only the request, attached images, model display name, context plan, and read scene IDs needed for display and retry (retries rebuild context from current source text). Only runs eligible to re-run judgment-model verdict on preserved prose keep the full frozen input.
  - Sending `Prefer: return=minimal` on intake, retry, candidate, re-judgment, or cancel requests returns only a compact receipt (run ID, status, etc.) so the web UI avoids downloading full frozen inputs; omitting the header returns full runs as before, and full frozen inputs and diagnostics remain available via `GET /api/runs/:id`.
- **Compact snapshots and lore inheritance**:
  - `server/execution-snapshot.ts` compacts completed state so normal Run queries return lightweight metadata directly, while `readRunSnapshot` reconstructs context from current resources and messages only when a new task requires it.
  - Lore inheritance validates source, ancestor, and note provenance on the chat's latest `chat_lore_state` without reviving completed parent Runs; neither auto-expanding `DatabaseSync` subclasses nor text-sharing triggers are used.
- **Streaming chunk retention and startup pruning**:
  - Completed streaming chunks are not kept redundantly alongside final source text or helper messages; chunks remain for in-progress reconnects and partial outputs on failure/interruption, while completed reads switch to terminal status and stored final messages.
  - On server startup, `pruneUnreachableResponseChunks` (`tests/response-stream.test.ts`) removes chunks for main runs the UI can no longer show (runs that committed a scene or finished runs retried in the same chat), while keeping chunks for cancelled runs without partial results even if retried because the activity list renders partial output from them.
- **Lightweight projections and reader loading**:
  - Status checks use lightweight queries in `server/run-projections.ts`; Reader loads the current page, latest failure, and active jobs rather than all past failures (fetching full job history separately) and renders the manuscript only after the saved reading position's page resolves.
  - Logical conversation assembly checks integrity of originals and selected edits without constructing Reader paragraph blocks or translation storage records, display transforms react to changes in source text, variables, resources, and image results rather than a global event cursor, and full source text loads only when required.
  - Rewriting from a mid-story scene creates an [independent chat copy](../CHAT-BACKUP.md); the last completed response can retry in a new chat or replace the existing response (applying only after new prose commits), both using current settings plus the conversation and variable checkpoint right before that response without deterministic replay of past executions.
- **Live interruption vs. Anthropic Batch recovery**:
  - Standard live provider requests still transition active Runs to `interrupted` on disconnect without auto-resubmitting because outcomes are unconfirmed.
  - Main-model Anthropic Batch runs requeue to `queued` for worker resumption only when durable state exists in `anthropic_batches` and every external call maps to a Batch record; mixing in live summary, judgment, or script-model calls prevents auto-reentry even with completion records because a crash between remote completion and local replay receipt persistence cannot be distinguished (leaving safely persisted live preparation calls for manual review is an intentional conservative boundary).
- **Batch replay mechanics and reservation states**:
  - The recovery worker re-enters `runMain` matching Batch round order and request hashes: rounds with an existing `batchId` start with status polling instead of calling create again, and rounds with already-fetched result JSONL re-decode stored results.
  - Stored `tool_events` act as replay receipts so read, helper, evaluation tools, and terminal submissions never re-execute (rejected tool records never replay as state mutations). Lua `editRequest` reuses saved results by matching request index, input hash, and modified prompt while running normally on later rounds; follow-up size estimation uses the actually sent modified prompt without extra Lua invocations, and actual dispatch re-verifies that round's edited output and provider connection.
  - New Batches first persist locally as `reserved`; because `reserved` means no remote creation attempt has started, it can safely create after a restart. Right before attempting remote creation it flips to `creating`, and `creating` without a `batchId` does not auto-resubmit because preventing duplicate billing takes priority over automatic recovery.
  - Once a run succeeds and its source commits, raw Batch result bodies retained for recovery are removed, keeping only Batch/attempt identification metadata.
- **Deterministic evaluation replay and upgrade boundary**:
  - Evaluation tool sessions derive from the Run ID and queued timestamp, and case/receipt IDs derive deterministically from the session and tool-call ID so restarts under the same contract reconstruct preloaded requests and evaluation receipts identically without merging evaluation/submission semantics or model judgment stages.
  - Alongside Batches started with random sessions or removed context tools, all queued or in-progress evaluation Batches reserved/submitted under the pre-simplification contract must finish on the older version before upgrading.
  - Mandatory final submission for `model-selected`/`preloaded`, the fixed 10 non-terminal tool exchange cap, and removal of `source-bound` and find-and-replace do not reinterpret old requests/receipts; raw historical snapshots and receipts remain readable without a legacy evaluation engine, versioned execution paths, or recovery that ignores cross-contract hashes or auto-resubmits (see [Evaluation tools](../EVALUATION-TOOLS.md)).
- **Response stream batching, sequencing, and handoff**:
  - Approved resumed Batch Runs hand off their existing response stream to the new writer; normal runs cannot create duplicate streams for the same ID, previous writers cannot write or close, and main-story streams distinguish user cancellation (`cancelled`) from server shutdown (`interrupted`).
  - `server/response-stream.ts` batches incoming text into 50ms or 1,024-character chunks for immediate in-memory subscriber delivery, flushing to SQLite in one transaction on whichever comes first: 750ms, 4,096 characters, an attempt/segment transition, or termination (decoupling persistence reduces generation commits and subscriber SQLite re-reads).
  - Because the store assigns sequence numbers before delivery and persists with identical sequence numbers and boundaries, `read()` returns stored rows plus the unflushed tail in one order and other tabs or reconnects receive identical chunks.
  - Sequence numbers pre-reserve in `sqlite_sequence` in blocks of 1,024 so crashes before flushing never reuse delivered sequence numbers (losing only the interrupted attempt's final tail while resumed execution uses a new attempt); run validity checks on flush rather than per token, with `AbortSignal` guarding cancellation and shutdown (`tests/response-stream.test.ts`).
- **Translation streams**:
  - Translation jobs own a `translation` stream keyed by job ID (job hooks in `server/app.ts`, `server/product-auxiliary.ts`) strictly for progress display while `job_results` still writes only during the verdict phase, using distinct segment numbers and attempt IDs on post-refusal retries.
  - Translation streams purge chunks and leave only terminal status on completion, failure, cancellation, or restart, and re-running the same job ID opens a fresh stream.
- **Thought summaries and HTTP 400 fallback**:
  - Unsigned thought-summary parts are stripped from model responses re-sent on subsequent calls (summaries are display text while signatures hold reasoning context, so resending summaries only bloats input); signed parts remain verbatim in continuation state like other model parts.
  - If a provider rejects a call requesting thought summaries with HTTP 400, that task retries once without summaries and stops requesting them for remaining calls; if the 400 was unrelated to summaries, the retry ends with the same error.
  - Main-story runs and non-Gemini providers never request thought summaries. Controlled by `ProviderRequest.thoughtSummary`, delivered via `ProviderExecutionOptions.onThought` and response stream writer `thought`, and rendered in `web/StreamingResponse.tsx` (`tests/vertex-protocol.test.ts`, `tests/vertex-transport.test.ts`, `tests/response-stream.test.ts`, `tests/chat-event-stream.test.ts`, `tests/helper-workspace.test.ts`, and `HELPUI08` in `tests/helper-browser.spec.ts`).
- **Helper activity tracking and retention**:
  - `server/helper-activity.ts` shows in-flight tools via `tool.started` before completion, resolving target names at query time to current titles from start-time structured metadata (`helperActivityTarget` kind and ID, or batch count). Argument previews are never shown (preventing deleted-scene previews or pruned tool details from reappearing), and deleted scenes or hidden resources show only tool kind without a target name (`tests/helper-activity.test.ts`).
  - The UI pairs starts and ends by call ID and folds consecutive read, list, search, and check calls into one line showing viewed scenes, viewed resources, and other lookups (expanding shows each call's target and tool name), while mutating calls and failed reads stay on separate lines (`web/helper-activity-groups.ts` without React; `tests/helper-activity-groups.test.ts`).
  - Running status-line copy comes from the last running step via `helperActivitySummary` in `web/helper-activity.ts`. Call counts (`helperCalls`) span the entire task separately from the recent 80-record query window; retry backoff waits come from `provider.retry` records emitted before waiting (omitting error fields because waiting is not a failure and failed calls keep their own error rows) and turn historical on the next record, while expanded records describe outcomes in prose keeping only technical tool names literal (`tests/helper-activity.test.ts`, `tests/helper-workspace.test.ts`).
  - Large tool results and normal receipt bodies from successful helper tasks compact; past hypothetical scenes retain source text, requests, and edit history for read/copy only (no new generation, rewriting, or editing), while failed tasks keep results needed for retry decisions.
  - The helper refresh API queries only event kinds and sequence numbers without tool result bodies; summary checkpoints preserve provenance of actually stored conversation messages without retaining unused hash lists of cleared tool payloads, while in-flight summaries and context transitions pass real tool results and completed changes without re-executing them.
- **Stream vs. final-message ordering**: Server stream completion and final message fetches may arrive out of order; the browser keeps displayed streamed output until the final message is ready rather than permanently retaining server chunks.

### Execution and browser boundaries

- `server/run-executor.ts` owns prose preparation, model invocation, judgment, atomic persistence, and termination, while `server/app.ts` wires HTTP routes and follow-up jobs; illustration and auxiliary job queues remain separate.
- Queued inputs and in-flight execution inputs are separated, and native preparation, lore selection, context preparation, and prompt compilation sequentially update the same execution input.
- When a subscriber's send buffer fills, only that subscriber pauses reading the next page and resumes on `drain`; cursors advance for already-accepted pages so chunks never resend without blocking other subscribers or model execution.
- The helper UI keeps the current conversation and the four most recent conversations in memory without truncating expanded historical messages in the current conversation, re-fetching evicted conversations on demand, cleaning up cursors and request IDs together, and ensuring late responses never overwrite newer queries.

## Generation, queued next request and automatic refusal retry

- **Tab-local next-request queueing**:
  - Because only one active generation runs per chat (`one_active_run_per_chat`), a next request submitted while writing queues as a single tab-local reservation rather than a server queue, never pre-claiming or reordering server runs or one-shot option reservations (`chat_option_pending`).
  - On dispatch, it traverses the normal send path and idempotency key so uncertain intakes hand off to existing **이전 요청 확인** (Check previous request) and never double-send across refreshes or other tabs.
- **Auto-dispatch preconditions and fallback**:
  - Auto-dispatch fires only when the prior run ended `completed`, this tab still views the same chat, accompanying settings revisions match queue time, and no confirmation dialog (such as a Codex content warning) or other send precondition blocks it.
  - Four revisions are compared: chat settings, chat profile (composer model, persona, modules and author's note, lore policy, pinned prompt), creative options, and global model/prompt settings; library resources, lore entries, active outline/plot items, and Story Guide are not compared and load at send time like manual sends.
  - Conditions check when the tab observes run completion (hidden tabs check and dispatch upon becoming visible); any mismatch cancels auto-dispatch, restores the queued content to the composer draft, and explains why.
  - If the Codex content-check request itself fails, auto-dispatch treats it as needing confirmation and restores the draft (unlike manual sends, where a human is watching). Leaving the chat cancels the queue immediately (even leaving and returning mid-check skips sending), and page reloads revert queued text to the draft so nothing sends without confirming completion.
  - Auto-sent requests use the same `generate` function in `web/main.tsx` as manual sends so the Reader follows new prose.
  - A lore-reset flag travels with the queued request for that request only, reverting an input translation finishes at queue time like a normal send, and requests with reference images cannot be queued because session storage persists text only (`queueRequest`, `sendQueuedRequest` in `web/useStory.ts`; `tests/composer-next-request-browser.spec.ts`).
- **Automatic refusal retry**:
  - Creates a normal run whose `retryOf` points to the prior run via the same `retryRun` path as manual **다시 시도** (Retry), preserving one-active-run-per-chat, idempotency keys, revision checks, and independent `maxCalls`/usage per attempt without mutating the refused run's prose, error, usage, or attempts.
  - Retry count walks backward along `retryOf` counting runs keyed with `auto-refusal-retry:<거절된 실행 ID>` (rejected run ID), so a manual user retry resets the count to `0`; at the limit, the last refused run remains awaiting manual retry.
  - Never triggers on user cancellation, server shutdown/maintenance, auth/connection failures, unknown-outcome errors, call-limit or context-limit exhaustion, judgment failures, refusal of a judgment-only retry, or when the story progressed or scenes were deleted after the run.
  - Recording the refusal and queuing the follow-up run commit in one transaction (all-or-nothing) with one unique key per refused run preventing duplicate intake; a server stop before start ends the follow-up as `interrupted`. Failure push notifications are suppressed when a retry queues and sent only when refusal is terminal (`finishRefusalWithAutomaticRetry` in `server/run-retry.ts`, `server/run-executor.ts`; `tests/run-auto-refusal-retry.test.ts`, `tests/main-judgment.test.ts`).
- **Entry points**: `server/model-runner.ts`, `server/run-retry.ts`, `server/main-judgment.ts`, `server/product-auxiliary.ts`, and `server/source-editing.ts`; data flow and persistence are verified via synthetic tests.

## Context limits, compaction and request measurement

- **Call limits and defaults**:
  - **채팅 설정 → 생성 설정 → 고급 실행 설정 → 작업당 모델 호출 한도** (Chat settings → Generation settings → Advanced execution settings → Model call limit per task) and `PATCH /api/chats/:id/settings` accept integers 1–128; follow-up lookup calls and context summaries share this limit, and changes apply to subsequent reservations.
  - Translation uses a separate 2–64 call policy; new helper tasks use fixed internal policies (64 helper judgments, 128 total model calls, 256 host tool calls, and configured helper task timeout defaulting to 60 minutes) without per-conversation editing.
  - On the last allowed call, a `finalCall` marker instructs the model to reply without tools summarizing completed work, saved changes, uncertain changes, and remaining work; requesting a tool on that call skips execution and fails the task for budget exhaustion.
  - Already-queued tasks keep their frozen call limit; because native Codex internal model requests are unobservable, call limits are not cost caps and are distinct from input/output token limits.
  - `GET/PUT /api/chat-generation-defaults` reads/writes `{revision,maxCalls,storyUi,storyUiStyle,autoRefusalRetryEnabled,autoRefusalMaxRetries}` in `app_metadata` (omitting the last two fields in `PUT` keeps existing values; `expectedRevision` returns 409 on conflict).
- **In-run tool compaction and reference placement**:
  - Even after pre-run compaction, repeated `story.read` or similar lookups can fill the window; right before each next model call, `server/model-runner.ts` re-estimates the actual outgoing body including returned results, and when input exceeds 85% with compactable successful reads, `server/context-tool-compaction.ts` summarizes them with the queue-time context-compaction model (automatic for main execution except evaluation-tool runs).
  - Structured requests assemble completed tool records first and finalize reference messages via `withNativeHostContext`; dynamic references for main writing and translation go in separate user-role reference messages rather than `system`/`instructions`, preserving authored preset roles and order without encoder patching into instructions. Because Codex already sends the same material in JSON `input`, only identical host reference messages are omitted while keeping the current request, original prompt, and completion receipts.
  - `core/context-summary-policy.ts` supplies shared preservation rules across automatic conversation summaries, in-run read summaries, and helper summaries—distinguishing actor, target, action, and conditions; observations, plans, beliefs, and hearsay; unconfirmed fulfillment; explicit user corrections; and exact identifiers/known sources, and instructing models never to turn lack of confirmation into confirmed failure or non-fulfillment—without merging executors or storage scopes.
- **Context API, storage, and dependency tracking**:
  - `GET /api/chats/:id/context`, `PUT /context/summary`, `POST /context/compact`, and `/context/jobs/:jobId` read/cancel routes (each short path prefixed with `/api/chats/:id`) store automatic/manual results in `context_checkpoints`, active pointers in `context_heads`, and manual executions/receipts in `context_jobs/context_job_attempts`.
  - Helper `context.read` and UI details share the same current summary, source provenance, valid notes, and usability status (`usable: false` with a reason when mismatched); only the UI adds compact status for the 10 most recent compaction jobs, and no path fetches and discards full completed inputs or historical checkpoint bodies.
  - `server/context-dependency.ts` decides reuse from the actual writing program, effective values, resources, corrections, and native history—changes solely to defaults revisions or helper/translation models never invalidate main summaries (`tests/context-checkpoint-storage.test.ts`, `tests/helper-context-read.test.ts`).
- **Next request preview**:
  - The composer's **다음 요청 미리보기** (Next request preview) (`POST /api/chats/:id/request-preview`) projects the next initial main request from the current draft plus saved source head, settings, writing model, prompt, and persona, accepting `request` plus optional `loreContextReset` and `requestImages` (using only image `name`, `width`, and `height` without uploading/storing bytes).
  - Applies the same draft length validation as real requests (allowing empty text when images are attached) and returns selections, revisions, local tokenizer, effective input budget, estimated request size, image count and conservative image token estimate, retained/pinned lore counts, and summary reusability—never returning source text, prompt bodies, connection URLs, or credentials.
  - `tests/request-preview.test.ts` checks against real API routes, temporary SQLite, and native previews: zero DB mutations, zero provider/callback calls, draft and settings reflection, valid summary reuse, and mid-read revision changes.
- **Estimation variance and Gemini signature exclusion**:
  - Local JSON token counts remain estimates (not upper-bound guarantees) due to tokenizer generations, internal provider formats, chunk-boundary differences, and fresh per-run IDs/hashes. In an observed `o200k_base-v1` case, identical 15,887 UTF-16 code-unit bodies varied across 6,943–7,011 tokens (~1%); because 85% and 75% thresholds are deterministic only beyond this variance, synthetic tests keep fixtures outside 1% of boundaries.
  - Gemini-family echoed `thoughtSignature` values and reasoning bodies are excluded from input estimation because providers do not tokenize opaque signatures character-by-character and tokenizing them inflates estimates across tool calls, causing unnecessary compaction. In production logs, an estimate including signatures reached 258,852 when provider-reported input was 92,495, whereas excluding signatures yielded 0.88–1.22x of actual input (medians by call-order bucket) across 1,146 Vertex helper calls.
  - Compaction checks (`measureProviderRequest`), pre-send limit checks (`core/vertex.ts`), and attempt-recorded estimates all share this rule (`tests/helper-compaction.test.ts`, `tests/vertex-transport.test.ts`).
- **Implementation and core test suite**:
  - Implementation spans `core/context-budget.ts`, `core/context-plan.ts`, `core/context-projection.ts`, `core/notes.ts`, `core/story-context.ts`, `server/context-planning.ts`, `server/context-compaction.ts`, `server/context-tool-compaction.ts`, `server/model-runner.ts`, `server/context-store.ts`, and `server/story-notes.ts`.
  - `tests/context-integration.test.ts` and related context/story suites verify races, cancellation, input attribution, and retention on real routes, fresh SQLite, and synthetic provider bodies; checkpoint preservation and in-run compaction have dedicated storage/tool tests, and staged EOF has regressions in `tests/context-compaction.test.ts` and `tests/helper-compaction.test.ts`.

### Derived context verification

- `tests/context-provenance.test.ts` verifies that repeatedly projecting conditional promises, character hearsay, helper interpretations, author corrections, and unchosen developments does not alter text or provenance on the host (this does not prove models preserve meaning across repeated summaries).
- `tests/context-tools.test.ts` verifies separation of instruction regions and reference material across all five transport paths via real request builders, and `tests/agent-collaboration-context.test.ts` verifies caching, delivery, and source ranges inside a real tool loop.
- When evaluating real models, summarize the same case 1, 3, and 5 times to check whether conditions, actors, uncertainty, corrections, and proposal distinctions survive while counting unnecessary re-reads when information is already sufficient; automatic supervisor models, per-sentence confidence scores, and mandatory per-turn source re-verification stages are not added.

## Custom agent collaboration

### Call and storage contract

`RisuPrompt.collaboration` stores the structure below. `validateRisuPrompt` and `validateAgentCollaboration` check unknown fields, duplicate IDs, shared-control references, and numeric limits.

```ts
type AgentCollaboration = {
  enabled: boolean;
  sharedInstructions: string;
  sharedControls: string[];
  maxCalls: number; // 1–12 shared across all collaborator agents
  agents: {
    id: string;
    title: string;
    description: string;
    instructions: string;
    model: { id: string } | null; // null inherits the main model
    trigger: 'before' | 'on-demand';
    tools: ('knowledge' | 'skills' | 'notes' | 'story')[];
    maxCalls: number; // 1–6 host request / native execution limit per agent
  }[]; // up to 6 agents
};
```

- **Preset storage and validation**: Uses `program` on existing `POST/PUT /api/prompt-presets` with `expectedRevision` CAS. While disabled, empty names, instructions, unset call limits, and deleted shared-control references remain saved so other prompt edits succeed; re-enabling validates required fields, shared controls, and limits, while schema shape and duplicate-ID checks always run and stale prose undo never erases separate collaboration edits.
- **Snapshotting and attempt attribution**: Prompt and models freeze at Run queue time in `ProfileSnapshot.collaborationModels` so mid-run edits apply on the next Run. Each collaborator invocation checks the live provider connection at start, logs an attempt before sending, and reuses `role: main` transport tagged with host-only `agentId` (never sent to providers or read from model output).
- **Shared call budgets**:
  - All collaborator calls count toward `settings.maxCalls` alongside summaries and main calls; overall and per-agent caps sum host requests across pre-writing consultations, follow-up questions, and lookup round-trips while reserving 1 call for the main writer's next call—except consultations from an active Codex native writer, which return into the ongoing turn without reserving a next call.
  - New questions never reset limits, recoverable lookup errors may be corrected within the same budget and timeout, and defaults are 3 total additional calls and 2 per template; final writing needing more tool round-trips may hit the existing overall call limit, and enabling collaboration always adds tool descriptions and shared instructions to main input.
- **Output, timeout, and legacy fields**:
  - Per-model `maxOutputTokens`, input token limits, and timeouts apply (a collaborator's timeout is shared across calls in one consultation), and completed opinions pass to main without a separate character limit.
  - Legacy `maxOutputChars` in old presets or backups is ignored regardless of value and stripped on save, while historical `truncated` flags on past consultation receipts remain; names, role descriptions, and instructions follow common prompt file/API storage size bounds rather than collaboration-specific character limits.
- **Failure, cancellation, and ordering**:
  - Failures, refusals, partial responses, and uncertain disconnects return as unavailable results without auto-retry; spent calls and usage stay recorded, unreported actual cost `null` never becomes `0`, cancellation stops collaborators and main together preventing late saves, and restarts or archive restores never auto-replay uncertain executions.
  - Pre-writing consultations keep registration order; because collaborators share a call budget and log attempts/usage right before sending, parallel execution is not added without a separate budget-reservation contract.
- **Trace records and boundaries**:
  - `agents.consult` tool events log opinion, status, call count, question, provenance, and explicit context hash, `agents.read` logs actual reads, model inputs tag `agentId`, and `consultationContext` logs actual delivered opinions, evidence, and drafts—all used in-run and not permanently archived.
  - Independent chat backups include only final source text and continuation resources, only the main model's final response commits to source text, and content read by collaborators never auto-promotes to retained lore for the next Run.
- **Persistence, restore, and deletion**:
  - Stored in existing JSON fields with no dedicated collaboration DB table (see [data formats](../DATA-MIGRATIONS.md)). Restore checks agent model attribution, strips credential references from main and collaborator snapshots, and disables providers.
  - Deleting a model or provider affects new selections and send permissions while preserving historical run snapshots; deleting a dedicated collaborator model in the active workspace disables collaboration and clears its model binding (see [item deletion](../DELETION.md)).

### Verification scope

- Config and storage tests: `tests/agent-collaboration-config.test.ts` and `tests/agent-collaboration-store.test.ts`.
- Runtime tests: `tests/agent-collaboration-runtime.test.ts` uses a real loopback Responses server and fresh SQLite DB to check ordering, follow-up reads, permissions, call counts, deduplication, cancellation, and mid-run config edits.
- Context and browser tests: `tests/agent-collaboration-context.test.ts` checks selected context, drafts, composition, per-context caching and call budgets, post-context-window references, recoverable errors, runtime execution inputs, and post-completion DB cleanup; `AGENTUI02` in `tests/agent-collaboration-browser.spec.ts` checks desktop editing and real save/preview APIs.
- Implementation contracts are verified via synthetic tests.

## Optional evaluation tools

## Implementation

Settings and runtime coverage are in `tests/evaluation-settings.test.ts`, `tests/evaluation-tools.test.ts`, and `tests/evaluation-runtime.test.ts`. `npm run verify:evaluation` exercises the settings UI with synthetic data. Select checks according to [DEVELOPMENT](DEVELOPMENT.md#verification).

## Codex main native turns

Real main Codex Runs keep evaluation definitions, bootstrap and artifact processing in native tool callbacks. Both modes require terminal artifact submission. `preloaded` with `economized` keeps its first low-effort request in the old transport, then starts the native writer with the configured effort and completed results. The session and prior effects are not recreated. The fixed ten-exchange limit counts nonterminal Uimori host tool callbacks, including unsuccessful submissions; valid terminal submission is accepted separately. It does not count hidden model samples. HTTP main and translation runs retain request-based accounting, with at most eleven provider requests and the existing overall execution limits. See [Codex](#native-execution-for-main-writing-and-advice) for final submission, usage and cancellation boundaries.

## Scene illustrations

### Job queue and concurrency control

- **Job pump structure**: A single illustration pump executes 1 text job and 1 render job concurrently and independently. Renders proceed sequentially starting with a plan's representative cut, without locking main-writing slots or user input state.
- **Deduplication locks**: Only 1 planning job selecting scene-wide cuts may run per response (`ILLUSTRATION_PLAN_ACTIVE`). Renders for distinct cuts can queue independently, while duplicate runs for the same cut are blocked (`ILLUSTRATION_ACTIVE`).
- **State machine**: `queued → running → completed | failed | cancelled | interrupted`. User cancellation increments the `generation` counter so late-arriving results are discarded; on server restart, running jobs transition to `interrupted` without auto-retrying (`queued` jobs resume).
- **Task units**: `illustration_jobs.input.task` is partitioned into `plan`, `render`, and `placement`.

### Database schema and metadata

- **Tables**:
  - `illustration_settings`: app-wide runtime environment and policies
  - `illustration_references`: per-chat reference images and character appearance profiles
  - `illustration_jobs`: asynchronous job queue and execution state
  - `illustration_images`: generated image BLOB references and metadata
- **Preset persistence**: Preset entities are stored as `illustration-preset` resources in the shared `versions` table, and user selection state is stored in `app_metadata` under `illustration-preset-preferences`. See [Data formats](../DATA-MIGRATIONS.md).
- **Presentation ownership**: `illustration-presentation:<sourceId>` in `app_metadata` owns the representative target, per-cut latest requested/displayed job IDs, translation text hash, and placement mapping. Job execution inputs are strictly separated from UI display selections so a late-completing older request cannot overwrite a newer selection.
- **Source revision attribution**: Jobs bind to `source_revision` and queue-time `source_hash`. Even if the user later edits the source text, completed illustrations stay bound to the source at request time and display as **수정 전 원문의 삽화** (Illustration for pre-edit source); at execution time, the source text is re-fetched at the reserved hash (`sourceAtHash`).
- **Reader communication**: `GET /api/chats/:id/reader` returns the current scene's `illustrations` list, and SSE events `illustration.*` and `illustration-layout.updated` push real-time updates scoped to that scene only. Activity status (`reader.activity`) tags them as `kind: 'illustration'` without interfering with main-story generation progress (`activeJobs`).

### Tool and context contracts

- **Prompt-model read tools**:
  - Provides `illustration.sources.search` and `illustration.sources.read`.
  - Searches or reads page-by-page across pinned character cards, personas, native CHARX descriptions and lorebooks in modules, and captions and prompts of existing successful illustrations.
  - No separate write tools are provided, and these tools are not exposed to translation placement jobs.
- **Consistency guide (`visualCanon`)**: Planning optionally builds `visualCanon: [{name, appearance}]` and deterministically injects it into prompts so all cuts for the same response share character identity.
- **Input token budgets**: Planning inspects the entire response and fails immediately if it exceeds the model's total context budget. Per-cut rendering and translation placement receive the pinned focus and visualBrief plus an excerpt of up to 2,000 estimated tokens from the tail of the relevant source text.

### Image processing and storage

- **Image pipeline**: All generated outputs pass through a real image decoder within the 64MiB input cap, convert to high-quality WebP, persist in the shared `image_blobs` store, and serve from `/api/illustration-images/:id`.
- **Reference image processing**: Reference images are downscaled to at most 1536px on the long edge before sending to Codex, without upscaling or cropping. Original bytes and hashes remain immutable in storage.
- **Chat copies and backups**: Independent chat copies and individual backups restore only currently displayed successful results, same-cut variant groups, representative designations, and verifiable source/translation placements. Paragraph indices and text hashes are verified to assign new anchors (mismatches move to the auxiliary area), and unfinished jobs or failure logs are not copied.

### Codex path technical contract

- **Turn separation**: Planning (prompt model) and image generation (Codex) execute in completely separate turns. Planning, translation placement, and ComfyUI prompt-authoring turns disable web search, code mode, and image generation, explicitly setting `features.image_generation=false`.
- **Prompt refinement**: Setting is frozen when queuing a cut and reused on retries. When enabled, Codex refines the instructions and writes a caption inside the existing image turn from the draft, selected moment, raw style instructions, and reference images; if no caption is returned, the draft's caption is used.
- **Process and session reuse**: Consecutive cuts from the same plan reuse a single Codex process and ephemeral thread, calling `turn/start` per cut. Image turns disable web search and JS compute and enable `features.image_generation=true` (see [Codex execution boundaries](../CODEX.md)).
- **Concurrency slot**: Uses a separate slot isolated from text turns (1 concurrent, 8 queued) and logs under `role: 'illustration'`.
- **Result ingestion**: Reads base64 `result` from `item/completed`'s `imageGeneration` item first; if empty, reads and deletes the file at `savedPath` in the dedicated directory.
- **Failure codes**:
  - `CODEX_IMAGE_USAGE_LIMIT`: Paid usage limit exceeded (no automatic retry)
  - `CODEX_IMAGE_UNAVAILABLE`: Explicit generation refusal (no automatic retry)
  - `CODEX_IMAGE_NOT_GENERATED`: General generation failure (retryable)

### Using the judgment model for translation placement

Translation placement tries the [judgment provider](../PROVIDERS.md#판단-프로바이더) first. All translated paragraphs are supplied once in shared input, and one multiple-choice question per cut asking for "the translated paragraph where the narration of this moment ends" is dispatched in a single call; cuts where the judgment model picks `none` are stored without a placement.

- **Fallback to legacy path**: When no judgment key exists or the selected judgment connection is unavailable, when the request exceeds the judgment API token limit, or when translated paragraphs exceed the option cap (255 options including `none`), no judgment request is sent and the prompt model or Codex text turn decides placement as before.
- **Post-dispatch failures**: HTTP errors, timeouts, or response format errors after sending a judgment request record as job failures without falling back to the prompt model. Users can retry via **번역 위치 다시 연결** (Reconnect translation placement).
- **Usage attribution**: Judgment calls attribute to `illustration-placement` usage. Real judgment-model paragraph-selection accuracy is outside the scope verified by synthetic tests.

### Pre-judgment for Codex image requests

Immediately before image generation, text to be sent to Codex (the prompt-model prompt and reference image labels) is pre-checked by the judgment provider (default TypeSafe AI / JEV). Even when prompt refinement is enabled, pre-judgment covers only the text sent to the image turn.

- **Criteria**: Evaluates whether the text describing the cut requires explicit sexual depiction using the `noul` metric; a score of 0.9 or higher blocks that cut's image request from being sent. (General romance, kissing, and non-explicit staging are not blanket-blocked.)
- **Blocking behavior**: Recorded as `ILLUSTRATION_CODEX_CONTENT_BLOCKED`, blocking both automatic retry and manual retry with identical input. Other cuts' jobs, main-story/translation jobs, and existing successful images remain unaffected.
- **Exception handling**: Missing judgment provider key, response errors, 8-second timeout, or input token budget overflow record as `unavailable`, leaving moderation to the provider itself and continuing generation. Judgment calls attribute to `illustration-content` usage.

### ComfyUI path technical contract

- **Execution order**: Call planning model → substitute `{{prompt}}`, `{{negative}}`, and `{{seed}}` in the per-cut workflow → `POST /prompt` → poll `GET /history/{prompt_id}` → download image via `GET /view`.
- **Workflow validation**: Supports only API format (`노드 ID → {class_type, inputs}` — node ID → `{class_type, inputs}`); UI format (`nodes`/`links`) is rejected with `COMFYUI_WORKFLOW_UI_FORMAT`. Node structure is untouched, and placeholders inside `inputs` strings are substituted once.
- **Network and proxy**: Allows only `http://` and `https://` URLs with no credentials or query strings. When proxy authentication is needed, reads the environment variable specified in **인증 헤더 환경변수** (Auth header environment variable) and passes it as the `Authorization` header; browsers never access the remote server directly.
- **Timeout and result recovery**: Request timeouts (`COMFYUI_TIMEOUT`) do not force-abort remote rendering. The job stays failed while preserving `prompt_id`, and clicking **결과 확인** (Check result) (`POST /api/illustrations/:id/reconcile`) re-queries remote history to fetch the completed image.
- **Cancellation**: Calls `POST /api/jobs/{prompt_id}/cancel` only on explicit user cancellation. If unavailable, falls back to removing from the queue only via `POST /queue` with `{delete: [id]}` (global `/interrupt` is never called).
- **Failure diagnostic codes**: `COMFYUI_PROMPT_REJECTED` (node configuration error), `COMFYUI_EXECUTION_FAILED` (mid-execution error), `COMFYUI_SUBMISSION_UNCERTAIN` (uncertain intake; no auto-resubmission), `COMFYUI_RESULT_UNAVAILABLE` (post-intake fetch failure).

### NovelAI path technical contract

- **Request**: Call planning model → one `POST https://image.novelai.net/ai/generate-image` per cut. Body contains `input`, `model`, `action: "generate"`, and `parameters`; scene prompt goes into `v4_prompt.caption.base_caption`, and negative prompt goes into both `negative_prompt` and `v4_negative_prompt.caption.base_caption`.
- **Character references**:
  - Each selected reference image is letterboxed with black padding onto whichever canvas of 1024×1536, 1536×1024, or 1472×1472 best matches its aspect ratio as a PNG in `director_reference_images`.
  - Caption is `character`, information extraction is 1, strength is 0.6, and secondary strength is 0 (strength follows Asset Made's defaults and cannot be changed in the UI).
  - Indices not chosen by the prompt model or outside the pinned list are omitted, and the sent count logs in diagnostics under `novelai.references`.
- **Per-character captions**:
  - `characters` go in the same order into `char_captions` of `v4_prompt` and `v4_negative_prompt`, supporting up to 6 characters (V4/V4.5 limit) and dropping excess entries from the end.
  - `use_coords` enables only when all characters have positions; if only some have positions, all positions clear so NovelAI places them automatically. Positions clamp to 0.1–0.9, snapping to the 5×5 grid (0.1, 0.3, 0.5, 0.7, 0.9) on V4/V4.5 models and 0.01 increments on V5.
  - Shared planning-stage character appearance (`visualCanon`) is used only as prompt-model input and—unlike other generators—never appended to the scene prompt, preventing per-character traits from bleeding onto other characters.
  - Per-character captions and positions are viewable in generation details; authentication uses `Authorization: Bearer <Persistent API 토큰>` (Persistent API token) and never follows redirects.
- **Response**: Validates the first image inside the ZIP (or raw image body itself) by real image signature and routes it through the shared WebP storage path. The seed used logs in diagnostics under `novelai.seed`.
- **Failure codes**:
  - `NOVELAI_TOKEN_MISSING` (missing token; request not sent), `NOVELAI_UNAUTHORIZED` (401/403), `NOVELAI_ANLAS_INSUFFICIENT` (402), `NOVELAI_BUSY` (429, another generation on the same account), `NOVELAI_REQUEST_REJECTED` (other 4xx; check model ID/dimensions), `NOVELAI_UNREACHABLE` (pre-connect failure), `NOVELAI_RESULT_UNCERTAIN` (post-send timeout, disconnect, or 5xx), `NOVELAI_RESPONSE_INVALID`, `NOVELAI_IMAGE_INVALID`.
  - Diagnostics store only the HTTP status and up to 300 characters of NovelAI's message.
- **Uncertain results**: NovelAI returns no job ID, so results cannot be re-queried. Manual **다시 요청** (Request again) is permitted even after uncertain failures and resends only the image request reusing the saved prompt; cancelling drops the connection, though generation on NovelAI's side may still run to completion.
- **Pre-judgment**: Codex-only explicit-content pre-judgment is not applied.

### API specification

| Path | Method | Description |
| --- | --- | --- |
| `/api/illustration-settings` | `GET` / `PUT` | App-wide runtime environment and policies. `PUT` uses `expectedRevision` CAS. Response `novelaiTokenConfigured` reports only whether a token is saved; write-only `novelaiToken` in `PUT` replaces on string, clears on `null`, and preserves when omitted. |
| `/api/illustration-presets` | `GET` | Returns built-in and saved preset lists along with per-scope selection state. |
| `/api/resources/save` | `POST` | Saves a preset (`kind: 'illustration-preset'`). Supports `expectedRevision`. |
| `/api/resources/illustration-preset/:id` | `GET` | Fetches a single preset item. |
| `/api/resources/illustration-preset/:id/undo` | `POST` | Reverts to the immediately preceding saved version. |
| `/api/illustration-presets/selection` | `POST` | Sets per-scope preset selection (`scope: 'global'/'bot'/'chat'`, `targetId`, `presetId`, `expectedRevision`). |
| `/api/illustration-presets/:id/export` | `GET` | Exports a preset as a JSON file. |
| `/api/illustration-presets/:id` | `DELETE` | Deletes a preset (requires `expectedRevision`). |
| `/api/illustration-settings/comfyui/test` | `POST` | Tests ComfyUI connectivity (`GET /system_stats`). |
| `/api/illustration-settings/novelai/test` | `POST` | Queries NovelAI subscription tier using the stored token (or body `token`). |
| `/api/chats/:id/illustration-references` | `GET` / `PUT` | Per-chat reference roles and character appearance profiles. |
| `/api/sources/:id/illustrations` | `POST` | Queues a manual illustration plan (accepts `maxTargets`, `direction`, etc.). Returns `task: plan`. |
| `/api/sources/:id/illustration-presentation` | `PATCH` | Updates the representative illustration target selection. |
| `/api/sources/:id/illustration-usage` | `GET` | Queries cumulative per-stage illustration call counts and token usage for the current source. |
| `/api/sources/:id/illustration-placement` | `POST` | Requests re-mapping existing cuts to translated paragraph positions. |
| `/api/illustrations/:id/regenerate` | `POST` | Queues a new job redrawing the same target with the latest settings (supports `changeRequest`). |
| `/api/chats/:id/illustrations`, `/api/illustrations/:id` | `GET` | Fetches the illustration list or single-job details including frozen inputs. |
| `/api/illustrations/:id/retry` | `POST` | Retries a failed job using its frozen inputs verbatim. |
| `/api/illustrations/:id/cancel` | `POST` | Cancels an in-progress illustration job. |
| `/api/illustrations/:id` | `DELETE` | Deletes that illustration cut and its generation record. |
| `/api/illustrations/:id/reconcile` | `POST` | Fetches and stores remote results for a recorded ComfyUI `prompt_id`. |
| `/api/illustration-images/:id` | `GET` | Streams persisted image binary (WebP). |

In test mode (`UIMORI_TEST_MODE=1`), `/api/test/control` enables the `illustration` barrier/failure point and the synthetic `fixture` generator.

### Verification and testing

- **Unit and contract tests**:
  - `tests/illustration-research.test.ts`: Pinned native resource reads and shared cast verification
  - `tests/illustration-profiles.test.ts`: Default character appearance inheritance and CHARX round-trip preservation
  - `tests/illustration-presets.test.ts`: Scoped selection, undo to previous save, v1 file generator recognition, and frozen job input verification
  - `tests/illustration-storyboard.test.ts`: Cut-plan atomicity, duplicate execution prevention, retaining existing images during regeneration, and translation placement verification
  - `tests/illustration-runner.test.ts`: Judgment-model selection for translation placement, `none`, legacy-path fallback when key is unset, and post-dispatch failures
  - `tests/comfyui-client.test.ts`, `tests/codex-image.test.ts`: Generator client and synthetic response contract verification
  - `tests/novelai-illustration.test.ts`: NovelAI request payloads, per-character captions and coordinate snapping, character reference selection and canvas fitting, remaining Anlas and V5 gauge parsing, status code classification, token storage boundaries, zero automatic retries, and prompt reuse on manual retry (`fetch` interception; no real NovelAI calls)
  - `tests/illustration-*.test.ts`: Storage, execution queue, and API endpoint contract verification
- **Integration verification command**: `npm run verify:illustration`
  - Verifies representative/paragraph placement, collapse-state preservation, sending the next chat message during generation, retries, deletion, conflict handling, and display restoration after reload.
  - Verifies preset creation, duplication, JSON instruction file round-trips, saving a copy on concurrent edit conflict, and unsaved edit protection.
  - Verifies ComfyUI workflow error focus and mobile/desktop input layouts.
  - Passing `--visual` includes screenshots in the report; verification criteria follow [DEVELOPMENT](DEVELOPMENT.md#verification).

## Input translation

### Implementation boundaries

- `core/input-translation.ts`: Supported languages, input/context limits, standalone translation instructions, and notation choices.
- `server/input-translation.ts`: Read path and single provider call for `POST /api/chats/:id/input-translation`. Creates no prose/source/job and writes neither drafts nor input-translation call payloads into the app DB; uses shared provider adapters and authentication paths.
- `web/useInputTranslation.ts`: Composer view/draft revision identification, cancellation, temporary original text, and stale-result handling.
- `web/useStory.ts`: Links existing drafts with send-acceptance boundaries without changing request record schemas.
- `web/InputTranslation.tsx`: Composer controls and display of original/previous draft results.
- `web/RequestMessage.tsx`: Exact clipboard copying of saved requests, decoupled from display strings.
- Temporary original text is stored in `sessionStorage` under `input-translation:<기존 draft 키>` (existing draft key), and the target language is stored in `localStorage` under `uimori:input-translation-language`. When browser storage is restricted, original text may exist only in active editor memory; provider-side retention policies are independent of the app's temporary storage.

### Verification

```sh
npm run quality
npm test -- tests/input-translation.test.ts tests/request-edit.test.ts tests/api-errors.test.ts
npm run build
npm run verify:input-translation
```

- Server tests verify model/preset isolation, notation and current chat context, zero DB mutation on success/failure, truncated-output rejection, and cancellation on server shutdown.
- Browser tests verify input translation, original-text recovery, editing, page reload, cancellation, stale responses, send failure/uncertainty, retaining only the final sent text, and clipboard copy success/failure.
- Existing request-editing and Reader send-recovery suites also run alongside; tests use a temporary DB, synthetic responses, and a local browser.
