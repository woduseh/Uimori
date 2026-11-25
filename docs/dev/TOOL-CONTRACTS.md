# Model tool contracts

Uimori keeps model-facing tools deliberately small and provider-portable. Runtime services may keep richer internal identifiers and idempotency metadata, but those details do not become extra ways for a model to express the same operation.

A tool's contract is its description and input schema: arguments, defaults, limits, paging and result fields. This document holds the rules for writing those definitions and the constraints that no single definition states.

## Read tools

The main writer and the translation role use the definitions in `core/read-tools.ts` (`knowledge.search`, `knowledge.read`, `skills.list`, `skills.load`) and `core/story-read-tools.ts` (`story.search`, `story.read`); translation adds `translation.search` and `translation.read`. Advisors receive the families enabled for them, and role-specific source scope still applies. `tests/context-tools.test.ts`, `tests/story-context.test.ts`, `tests/translation-context.test.ts` and `tests/main-catalog.test.ts` enforce them.

`readAccess` in `core/read-access.ts` is the only place that decides which read pairs, catalog entries and catalog guidance a request carries; the main writer (`buildMainInput`), translation (`translationInput`), the story guide and advisors all call it. A pair is offered only while it has something to return that the request does not already deliver: a lore entry or skill whose text is not in the input, a scene that `story.*` can reach (not hidden from context) and that is not in the input, or an earlier translation in scope. The catalog lists only undelivered entries of the offered families, so it carries no `loading` marker. Delivery differs by runtime and is decided by the caller:

- The writer's compiled prompt delivers pinned bodies, model-selected lore and retained lore whose full current text is kept (`writerDeliveredReferences`), and the scenes its compiled messages carry by `sourceRevision`. A scene cut by compaction or by a preset's chat range is outside the input.
- The story guide and advisors (`delivery: 'direct'`) send pinned bodies and the compacted history directly, so retained and selected lore stay readable for them.
- Translation delivers the package bodies in its source-time context and the previous scenes it shows in full; an excerpted previous scene stays readable.

The list depends only on the frozen Run snapshot, never on this run's results, so every round, continuation and Batch resume of one run sends the same tools. It changes between requests of a chat only when the snapshot does: `story.*` appears once compaction or a chat range first leaves a scene out, and `knowledge.*` disappears while every reference is delivered, for example when retained lore covers the last discoverable entry. Each change rewrites the provider's cached prefix once. A model that calls a tool its request did not offer gets no correction round, and the attempt fails: the provider decoders reject the unknown name (`UNKNOWN_TOOL`, `ANTHROPIC_UNKNOWN_TOOL`, `CODEX_TOOL_NOT_ALLOWED`), the story guide returns `STORY_GUIDE_INVALID_READ`, advisors `ADVISOR_TOOL_NOT_ALLOWED`, and a translation read outside its list is denied as not allowed.

`data.exec` is not gated: besides the frozen references and history it exports the live library and other chats, so it always has data outside the input.

- Explicit user notes are already pinned to the Run and delivered through host context. There is no separate `notes.list/read` model API.
- `story.read` selects by `sceneNumber` within its returned `sceneScope`. Internal revision IDs are returned provenance, not a second selector.
- The helper's tools are covered in [Helper tools](HELPER-TOOLS.md).

## Schema portability

Provider-visible tool roots are ordinary JSON Schema objects. Do not put `oneOf`, `anyOf`, or `allOf` at the root of a tool `inputSchema`. Providers support different JSON Schema subsets, and Anthropic rejects those root combiners for tool input schemas.

Prefer one canonical argument shape instead of schema unions:

- use `ids: [id]` instead of `id | ids`;
- use `refs: [ref]` instead of `ref | refs`;
- use `sceneNumber` instead of `revisionId | sceneNumber`.

When a semantic condition cannot be represented portably without a union, keep the simple object schema and validate the condition in the host runtime.

## Names, descriptions and parameters

A tool has one canonical dotted name, such as `knowledge.read`. Descriptions, host guidance and result continuations such as `nextRead` always use it.

Providers whose function names allow no dots receive an alias instead, built in `core/provider-tool-names.ts` and enforced by `tests/tool-contract-portability.test.ts`. Where the alias differs from the canonical name, the description is prefixed with `Host tool: <canonical name>.` so the model can connect the two. The alias is part of the retained continuation state, so changing how aliases are formed invalidates recorded continuations like any other changed tool configuration.

Write a description for a reader who has only that text:

- Lead with what the operation is for in the user's terms (bot, persona, lorebook entry, scene, outline) and when to use it or a neighbouring operation instead. The compact helper catalog shows only the first 260 characters.
- Then state what comes back and how to continue.
- Keep the limits and caveats a model can act on, and leave out how the host implements them.
- Put the meaning, unit, default and source of each argument in that property's `description`. A size argument always names its unit, because `limit` counts entries in some operations and UTF-16 code units in others.

Natively registered definitions are sent with every request and count toward the input estimate. This matters most for the writer's read tools: at the minimum 8,192-token input limit, longer definitions leave room for fewer recent exchanges before compaction (see [Context limits](../CONTEXT-LIMITS.md#입력-한도와-자동-정리)). Helper app operations are loaded on demand through `app.tools` and do not carry that fixed cost.

Whether the user asked for a save, selection, cancellation or deletion is decided once in the helper contract, not repeated per operation. A description still states facts about the operation itself, such as a deletion that cannot be undone.

The token-budget arguments (`tokenLimit`, `maxTokens`, `textLimit`) and the UTF-16 `limit` keep their existing names. Recorded read receipts and replayed arguments depend on them, so their descriptions name the unit instead.

## Provider continuation state

OpenAI Responses/Chat (including compatible gateways), Anthropic Messages and Gemini continuations keep the adapter's native transcript once and bind the already completed host-result prefix by its count and digest. A later request must match that prefix, the pending call IDs and names, the used IDs and the fixed configuration, which includes the tool list and its aliases. `tests/provider-continuation-results.test.ts` enforces this.

- A mismatch is rejected, not repaired. A continuation recorded under another continuation format or tool configuration cannot be resumed and has no compatibility fallback, so finish active or resumable Batch runs before switching builds.
- Native thinking signatures, media and steering stay at their positions in the provider transcript.
- The continuation record is host bookkeeping. It never rewrites authored resources, completed outputs or mutation receipts, and it does not reduce the transcript tokens a stateless provider API requires.

## Pagination and results

Page sizes, defaults and budgets are stated in each tool's description and schema. The conventions they share:

- Reference collections return `items` or `results` with `total` and an explicit `nextOffset`, or a batch `nextIndex`. Text reads return `totalChars`, the returned range and `nextOffset`.
- A null `nextOffset` means no later page remains. It does not claim that an omitted earlier range was read.
- A batch read has two continuations that must not be mixed: `nextIndex` points to the ids or refs that were not returned, and each item's `nextOffset` continues that item's text or field directory.
- A failure inside a batch stays local to its entry, including a malformed helper ref. An invalid batch structure, such as a missing or empty array, fails the call. Mistyped scene numbers and text offsets return correctable errors; a corrupt frozen story source is denied, never silently read.
- An excerpt, a metadata listing or a compacted read summary covers only what it shows. None of them establishes that a whole reference was read.
- The helper's streaming `data.search` reports `complete` instead of an exact total.

Constraints on the writer's catalog and reads:

- The initial catalog only selects discovery metadata for entries left to read. The complete approved corpus stays reachable through search, browse and known-ID reads; `catalogPage.total` and catalog relations count the undelivered entries. Catalog selection does not alter authored prompt order, JEV selection, retained lore or read permissions, and the request lore record takes its titles from the role's resources, not from the catalog (`requestLore`).
- For a context above the minimum, the main model loop may give `knowledge.read` a larger page than its default, taken from the measured headroom below the compaction threshold and shared by the results in one response. Final request admission and compaction remain authoritative.
- A `knowledge.read` receipt records the tokenizer, the budget and the returned ranges in `readBudget`. Source verification uses those frozen ranges instead of recomputing past cuts with a tokenizer that may have changed. A receipt without `readBudget` is not re-verified and never carries lore into later context.

### Folder navigation

`knowledge.search` with `mode:"browse"` is implemented in `core/knowledge-browse.ts`. Its arguments, version guard and page budget are in the `knowledge.search` definition, and `tests/knowledge-browse.test.ts` enforces them.

- Browse lists the Run corpus that is already authorized. It adds no live library lookup and re-executes no script.
- Folders are navigation only, not a loading or prompt-order policy. Empty folders are omitted, and distinct override connection scopes are separate groups even when their package, folder and lore IDs coincide.
- The view version binds the role, the scoped metadata and the effective source hashes, including native rendering and chat overrides.
- Browsing is not proof of a full-text read and never creates retained lore.
- There is no heading index, LLM indexing, new search provider or persistent index. The browse view is built once per role on first browse and belongs to the Run object: a new Run gets its own view, and garbage collection releases old ones without timers, eviction policies or settings. Do not mutate the frozen tool corpus in place.
- Ordinary search and read calls do not build the view.

### Writer Linux workspace

With `UIMORI_SHELL_ROOT` configured, the main writer also receives `data.exec`, defined in `core/main-shell.ts`, on the Linux runner the helper uses ([Linux data workspace](HELPER-TOOLS.md#linux-data-workspace)). Its description states the workspace layout, exports, limits and results, and `tests/main-shell.test.ts` enforces them.

- Without runner configuration the writer keeps its read tools. A configured but unavailable runner returns a recoverable tool error.
- The workspace is prepared only when used. It survives interrupted execution for recovery and is removed on terminal completion, including partial or refused results.
- For HTTP-managed writer continuations, a shell result that would exceed the budget of the next request is returned as a recoverable `TOOL_CONTEXT_LIMIT_EXCEEDED` result instead of its stdout. The execution status and the log path stay available, and pending tool results keep their paired responses. Nothing summarizes shell output automatically, and native Codex keeps its own continuation handling.

## Mutations

Helper mutations stay behind `app.tools` and `app.call`; see [Helper tools](HELPER-TOOLS.md#discovering-and-executing-app-operations) and [Editing saved scenes](HELPER-TOOLS.md#editing-saved-scenes).

- Revision and source-hash checks remain explicit arguments where they protect stale-write correctness.
- Idempotency identity is different: the model does not invent `operationId` values. The helper derives mutation identity from the helper task ID and the provider tool-call ID and passes it separately from model arguments. Only adapters for services that use receipts add the identity to their internal commands. There is no second mutation-tool registry to maintain.
- Reusing a completed tool-call ID is rejected by the helper loop. A new call ID is a new operation, not a semantic replay of a prior request: existing-resource saves still rely on revision checks, and identical new-resource creations with different call IDs are not deduplicated.
- For Gemini 4 helper models on AIS or Vertex, `web.search` is one additional provider-facing read-only tool. It delegates to an independent Google Search Grounding-only request via the existing Gemini adapter. This is not an additional mutation registry and does not change the existing gateway for app operations.
- `app.tools -> app.call` is intentional. It keeps the helper's native tool list and per-request schema tokens small and exposes an operation's exact schema only when needed. A later task of the same conversation also receives, outside the tool list, the bounded set of schemas that the conversation has already called ([Discovering and executing app operations](HELPER-TOOLS.md#discovering-and-executing-app-operations)).

## Execution boundaries

Provider-native function calls remain the portable default. Responses, Chat, Anthropic and Vertex adapters preserve call identity and continuation data; the host executes the approved operations and returns their results. OpenAI bootstrap history uses the same wire alias as the registered tool, while an unregistered historical name remains unchanged.

Do not equate a read-only purpose with independent execution. Writer reference reads operate synchronously on a frozen snapshot; wrapping them in promises does not parallelize that CPU work. `agents.consult` spends shared model/call budgets. Evaluation, artifact submission and app mutations retain their existing execution and receipt boundaries. The writer does not receive `context.read/write/new`; context lifecycle belongs to the host. User-requested helper summary operations remain app operations.

Programmatic Tool Calling is not currently enabled. OpenAI's hosted programs require `program`/`program_output` replay and matching `caller` on function results; Anthropic requires its code-execution/container continuation and server-tool handling. These are provider adapter responsibilities, not a reason to introduce a second app tool runtime. If a measured workload justifies PTC, enable it only for well-defined read operations and preserve the portable direct path. The mixed `app.call` gateway must not be classified as read-only.

Current references: [OpenAI PTC](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [Anthropic PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [Vertex function calling](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling). Provider-native code execution alone does not establish support for invoking Uimori functions from inside generated code.

## Units and model-facing budgets

Character limits are not mechanically renamed to token limits. HTTP request acceptance uses independent byte constants such as `PROMPT_HTTP_BODY_MAX_BYTES`; `EXECUTION_INPUT_MAX_CHARS` remains an allocation guard. Stored prose, identifiers, regex inputs, source coordinates and isolated-process/stream byte limits retain their existing contracts.

Model-facing serialized results count their JSON metadata as well as prose. Shared tool page policies use stable local o200k estimates unless a frozen consuming-model tokenizer is explicitly supplied; final model request admission uses that model's context budget. These counts are local estimates, not billed provider usage. Existing explicit `limit`/`textLimit` inputs retain their UTF-16 meaning; omitted text lengths use token defaults. A zero-progress tiny token page must return a recoverable error instead of a successful unchanged continuation.

Token-bounded projections of story text, translation evidence and preflight input never change saved source text.
