# Model tool contracts

Uimori keeps model-facing tools deliberately small and provider-portable. Runtime services may keep richer internal identifiers and idempotency metadata, but those details do not become extra ways for a model to express the same operation.

## Read tools

The main writer and translation role use the shared definitions in `core/read-tools.ts`. Advisors receive the subset enabled for them. Role-specific source scope still applies:

| Tool | Contract |
| --- | --- |
| `knowledge.search {mode?, query?, nodeRef?, expectedVersion?, offset?, limit?}` | Default/search lists or searches approved local references; browse follows the existing package/folder structure. Body matches include a bounded original excerpt and a ready-to-use read request at the matching location. |
| `knowledge.read {ids, offset?, limit?, tokenLimit?}` | Read one to sixteen references. A single read still uses a one-item `ids` array. Each returned item succeeds or fails independently and returns `nextOffset`; batch `nextIndex` identifies unreturned IDs. |
| `skills.list {query?, offset?, limit?}` | Browse/search available writing guidance. |
| `skills.load {id, offset?, limit?, tokenLimit?}` | Read one guidance resource. |
| `story.search {query?, offset?, limit?}` | With no query, browse frozen story ancestry in order; with a query, search it. Results expose stable 1-based `sceneNumber` values. |
| `story.read {sceneNumber, offset?, limit?, maxTokens?}` | Read one frozen story source by scene number within its returned `sceneScope`. Internal revision IDs remain returned provenance, not an alternate selector. |

Explicit user notes are already pinned to the Run and delivered through host context. There is no separate `notes.list/read` model API.

The helper exposes `data.exec`, `app.tools`, and `app.call` with the configured Linux runner; without it, or during a read-only outline review, only the two gateways are exposed. `data.search`, `data.read`, and `db.query` are discovered app operations callable through `app.call` or the `uimori call` CLI, not additional native tools. Codex registers the same configured set as dynamic tools within one turn. `data.read` always accepts `refs`, including a one-item array. See [Helper tools](HELPER-TOOLS.md) for CLI and file refresh behavior.

Helper resource editing uses discovered `resource.read` overviews and exact typed paths, then `resource.patch` for native card/module fields and preset fields, including independent display `/title`. Editable library string search/read results can supply the target and revision directly. `set` accepts simple typed fields and the complete card/module translation guide at the returned `translationGuidePath`; indexed `insert`/`remove` support lore entries, guide terms and native `promptTemplate` blocks. `move` supports only that block array, with the destination evaluated after removal and changes applied sequentially. Preset array reads expose compact block metadata and source text lengths by default, with optional `includeBodies:true` on the exact promptTemplate path, serialized-size-aware block pagination, and explicit paths for any oversized omitted bodies. Prompt overviews include the independent native name. `resource.clone` creates a saved content/preset copy from `sourceId`, `expectedSourceRevision` and a new title, then returns the new identity for editing. An optional `syncNativeName:true` synchronizes only cloned prompt presets; the default keeps the authored native name. Resource revision checks, atomic save, one-save undo and operation receipts remain owned by the existing resource service. Creation does not become an undoable edit of the source. This does not change complete UI or export models. See [Helper tools](HELPER-TOOLS.md#discovering-and-executing-app-operations) for copy policy, pagination and result budgets.

## Schema portability

Provider-visible tool roots are ordinary JSON Schema objects. Do not put `oneOf`, `anyOf`, or `allOf` at the root of a tool `inputSchema`. Providers support different JSON Schema subsets, and Anthropic rejects those root combiners for tool input schemas.

Prefer one canonical argument shape instead of schema unions:

- use `ids: [id]` instead of `id | ids`;
- use `refs: [ref]` instead of `ref | refs`;
- use `sceneNumber` instead of `revisionId | sceneNumber`.

When a semantic condition cannot be represented portably without a union, keep the simple object schema and validate the condition in the host runtime.

## Pagination and results

Helper `resource.read` accepts either one `path` or up to sixteen `paths` from one resource/revision. Batch `nextIndex` continues unreturned paths; per-item `nextOffset` continues text. `chat.lore` lists compact items by default and reads original/override field pages through a selector. Both contracts bound the complete serialized response; they do not send full editing models by default.

`resource.readMany` accepts up to sixteen flat resource/path selections and shares one 12,000-local-token response budget, with `requestIndex`, local errors and `nextIndex`. Existing `data.read` already batches text references across resources. `resource.read version=previous` exposes only the retained undo model, marked with `revision:null` and `currentRevision`, without editing anchors. `preset.validate` reports bounded advisory toggle diagnostics and explicit unchecked CBS coverage, never executes source or changes values. `resource.patchMany` applies explicit distinct resource patches atomically and tracks every target for draft protection and grouped undo; it does not establish preset synchronization. See [Helper tools](HELPER-TOOLS.md) for anchor, newline, reconciliation and failure-detail semantics.

Main reference collections use `items` or `results`, `total`, and explicit `nextOffset` or batch `nextIndex` continuations. Text reads expose `totalChars`, the returned range, and `nextOffset`. A null `nextOffset` means no later page remains; it does not claim that an omitted earlier range was read.

`knowledge.search` limits the complete serialized result to 6,000 local tokens. A body hit adds `match` with a token-bounded original excerpt (120 tokens), source identity and range, plus `nextRead` for the relevant `knowledge.read` or `skills.load` call. The first located term is an excerpt, not evidence of reading every matching term or the whole reference. Title/description-only matches and browsing keep metadata-only results. If one item's metadata would exceed the page budget, `metadataPreview` declares the reduced description/relations and a read request keeps the body reachable.

`knowledge.read` defaults to a 2,000-token serialized page. The minimum 8,192-token context keeps the default page. For larger contexts, the main model loop may increase a multi-ID page to at most 16,000 tokens using half the measured headroom below the 85% compaction threshold; results in the same response share that allowance. The body defaults to 2,000 tokens per entry, with `tokenLimit` selecting its bounded token allowance. Explicit legacy `limit` remains a UTF-16 cap, while offsets and source ranges always remain UTF-16. Independent known references should be requested together. Resubmit `ids.slice(nextIndex)` for unread IDs and follow each item's `nextOffset` for unread text. New host `readBudget` receipts preserve the chosen tokenizer, budget and actual returned ranges; source verification uses those frozen ranges rather than recomputing past cuts with a possibly changed tokenizer. Historical `knowledgeReadChars` and metadata-free receipts retain their original character-based verification. Final request admission/compaction remains authoritative.

Helper `data.read` has two distinct pagination dimensions: each item's `nextOffset` continues its text or field directory, while batch `nextIndex` points to unreturned refs. Resubmit `refs.slice(nextIndex)` rather than passing that index as a text offset. The helper's streaming search reports `complete` instead of an exact total. See [Helper tools](HELPER-TOOLS.md) for its page sizes and result budgets.

Batch reads keep resource failures local to each entry, including a malformed helper ref. Invalid batch structure, such as a missing or empty array, still fails the call. Mistyped scene numbers and text offsets return correctable errors; corrupt frozen story sources are still denied, never silently read.

### Folder navigation

`knowledge.search({mode:"browse"})` lists package/attachment scopes and standalone references from the same already-authorized Run corpus. A package contains its nonempty authored folders and unfiled entries; a folder contains references. Distinct override connection scopes are separate groups even when their package, folder and lore IDs coincide. Empty folders have no readable entries and are omitted. Folders are navigation only, not a new loading or prompt-order policy.

Copy a group's `nextRead` to descend. Every page returns `version`, `scope`, metadata-only `coverage`, `total`, `offset`, `nextOffset` and a ready continuation. A later page requires `expectedVersion`; stale views return `KNOWLEDGE_VIEW_CHANGED`, unknown nodes return `RESOURCE_UNAVAILABLE`, both with a root restart. The version binds the role, scoped metadata and effective source hashes, including native rendering and chat overrides. No live library lookup or script reexecution is introduced. Body text remains behind `knowledge.read` or `skills.load`; leaf metadata includes its effective `sourceHash` and the existing read call. Browsing is not proof of a full-text read and never creates retained lore.

Pages fit 6,000 local tokens, including JSON metadata and continuations. Leaf titles/descriptions/relations use explicit previews and original counts. Very large results can return fewer than the requested limit and resume at the actual end. Plain search, empty-query flat listings and known-ID reads remain available; query cannot be combined with mode=browse. No heading index, LLM indexing, new search provider or persistent index is used. On first browse, a WeakMap-owned view compiles/groups/hashes the frozen Run corpus once per role; descending and paging reuse it. A new Run object has its own view, and garbage collection releases old views without timers, eviction policies or settings. Callers must not mutate the frozen tool corpus in place. This view is not initialized for ordinary search or read calls; model tool-loop inference and its latency are not free.

For a helper, wrap returned main read operations in `app.call({name,arguments})`. The helper exposes `data.exec`, `app.tools` and `app.call` when its Linux runner is configured; explicit review retains only the read-only gateways. A helper round-budget rejection supplies a smaller retry of the same browse range, not an unrelated library search.

## Mutations

Helper `scene.read` exposes live editable original or translation text with an `editTarget`. `scene.search` can search the current chat's editable scenes in one call with a paged, ancestry/version-bound continuation or an isolated regex scan, while `scene.patchMany` atomically commits up to sixteen guarded scene edits. A source patch can optionally include a separately guarded translation patch, saving a new manual translation bound to the new source hash. `scene.patch` requires its source revision/hash and exact text hash, so completion of a pending translation cannot silently replace the text the helper read. Related literal replacements validate against one base and save atomically. `scene.versions/restore` use the existing retained original versions; restoration creates a new edit. These operations remain behind `app.tools/app.call`, retain chat ancestry checks and host-owned receipts, and share HTTP editing's post-commit reader notification and cancellation. Frozen `story.read` and rendered Risu presentation are separate representations. See [Helper scene editing](HELPER-TOOLS.md#editing-saved-scenes).

Revision and source-hash checks remain explicit when they protect stale-write correctness. Idempotency identity is different: the model does not invent `operationId` values for helper app mutations.

The helper derives mutation identity from the helper task ID and provider tool-call ID and passes it separately from model arguments. Only adapters for services that use receipts add the identity to their internal commands. There is no second mutation-tool registry to maintain.

Reusing a completed tool-call ID is rejected by the helper loop. A new call ID is a new operation, not a semantic replay of a prior request. Existing-resource saves still use revision checks; identical new-resource creation requests with different call IDs are not automatically deduplicated.

`app.tools -> app.call` remains intentional. It keeps the helper's native tool list and per-request schema tokens small while exposing exact operation schemas only when needed.

## Execution boundaries

Provider-native function calls remain the portable default. Responses, Chat, Anthropic and Vertex adapters preserve call identity and continuation data; the host executes the approved operations and returns their results. OpenAI bootstrap history uses the same wire alias as the registered tool, while an unregistered historical name remains unchanged.

Do not equate a read-only purpose with independent execution. Writer reference reads operate synchronously on a frozen snapshot; wrapping them in promises does not parallelize that CPU work. `agents.consult` spends shared model/call budgets. Evaluation, artifact submission and app mutations retain their existing execution and receipt boundaries. The writer no longer receives `context.read/write/new`; context lifecycle belongs to the host. User-requested helper summary operations remain app operations.

Programmatic Tool Calling is not currently enabled. OpenAI's hosted programs require `program`/`program_output` replay and matching `caller` on function results; Anthropic requires its code-execution/container continuation and server-tool handling. These are provider adapter responsibilities, not a reason to introduce a second app tool runtime. If a measured workload justifies PTC, enable it only for well-defined read operations and preserve the portable direct path. The mixed `app.call` gateway must not be classified as read-only.

Current references: [OpenAI PTC](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [Anthropic PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [Vertex function calling](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling). Provider-native code execution alone does not establish support for invoking Uimori functions from inside generated code.

## Units and model-facing budgets

Character limits are not mechanically renamed to token limits. HTTP request acceptance uses independent byte constants such as `PROMPT_HTTP_BODY_MAX_BYTES`; `EXECUTION_INPUT_MAX_CHARS` remains an allocation guard. Stored prose, identifiers, regex inputs, source coordinates and isolated-process/stream byte limits retain their existing contracts.

Model-facing serialized results count their JSON metadata as well as prose. Shared tool page policies use stable local o200k estimates unless a frozen consuming-model tokenizer is explicitly supplied; final model request admission uses that model's context budget. These counts are local estimates, not billed provider usage. Existing explicit `limit`/`textLimit` inputs retain their UTF-16 meaning; omitted text lengths use token defaults. A zero-progress tiny token page must return a recoverable error instead of a successful unchanged continuation.

Story reads default to 2,048 tokens with an optional `maxTokens` up to 8,192; story search excerpts default to 120 tokens. Story responses retain their independent 24,000-byte transport guard and add a 6,000-token delivery budget. Translation evidence reads default to 2,048 tokens; recent source context for input translation uses 1,500 tokens, and Codex content preflight uses 8,000. None of these projections changes saved source text.
