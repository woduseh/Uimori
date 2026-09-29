# Helper data and app tools

The helper exposes five Uimori tools to its provider: `data.search`, `data.read`, `db.query`, `app.tools`, and `app.call`. This is an input-size boundary, not a new approval mode. The existing app operations remain available through discovery and dispatch, including resource saves, chat options, lore overrides, notes, outlines, context summaries, and independent scene generation. For Codex, these five are native dynamic tools within one thread and turn per task; other providers retain their own tool transport.

The writer, advisors, and translation jobs retain their existing source-scoped tools. A helper's live cross-chat SQL access is not automatically inherited by those roles. Conversation summarization still reads its complete selected source prefix, not keyword search hits.

With automatic prompt caching selected, Anthropic and Responses helpers also mark the stable tools/instructions prefix before changing task data. Anthropic uses the last system block; Responses splits the existing request label and JSON into two content blocks and marks the label, preserving their combined text. Responses adds this point only for models with reviewed explicit-cache support; other models keep their existing automatic behavior. Native authored prompt boundaries and signed tool continuations remain intact. Unset, disabled, and explicit-only cache modes do not add this helper boundary; Codex retains its own cache policy. This can reuse provider processing and reduce billed input cost, not context size. Cache eligibility, lifetime, and actual usage remain provider-reported; see [model cache settings](MODEL-PARAMETERS.md#캐시-위치자동-배치유지-시간).

## Search and partial reads

Use `data.search` for factual lookup. It searches authored scalar fields once rather than returning the entire editing model with duplicate projections. Native content uses its card/module fields; the same description is not also repeated through `content.text` and `package.body`. Prompt programs and unsaved editor fields are searchable too. Search does not execute native CBS/Lua or infer facts from scripts. Use discovered app reads, such as `knowledge.read` and `chat.lore`, for their established effective-context contracts.

```json
{"scope":"library","query":"하린","kinds":["bot"],"patterns":["나이","Age","years old"],"match":"any"}
```

Whitespace-separated `query` terms must all match title/ID/kind or, in the library, the category (`bot`, `persona`, `module`, `main`, `translation`). Library document results expose that category as `metadata.category`; prompt resources have kind `prompt` and category `main` or `translation`. `patterns` searches field text. Patterns are case-insensitive literal strings by default, including two-character Korean terms and punctuation. Set `regex:true` for regular expressions. `match:"all"` requires all patterns in the same field, not necessarily the same returned excerpt. Empty/absent patterns list document references for browsing.

Use `output:"documents"` to locate resources by a name mentioned in their contents, like a filenames-only grep: each matching document appears once without body excerpts. A failed title `query` does not prove that a resource is absent; remove that filter before searching spelling variants in `patterns`. Then pass the selected `ids` and search the requested fact with the default `output:"matches"`. `paths` optionally limits both modes to exact JSON Pointer fields or their children. Human-authored descriptions and lore are searched before extensions/assets; HTML and scripts remain explicitly searchable and are not silently excluded.

Document-only discovery stops at the first qualifying hit without constructing unused excerpts, line counts or source-reference hashes. It keeps the same filters, ordering and pagination; exact match/read results still carry their original text and reference hashes.

Document results retain their `scope` and, for chat sources, `chatId`. When narrowing `scope:"chats"` results, carry that identifier into the next search so a source stays associated with the selected chat. Other scopes do not accept a chat filter.

The scopes are:

| Scope | Data and time boundary |
| --- | --- |
| `current` | This helper task's reserved chat packages, source ancestry, user requests, notes, and chat overrides. Includes original prose that may have been compacted out of a model window. |
| `library` | Current visible library originals, with their current revisions. |
| `chats` | Live original sources in chat ancestries. An optional `chatId` filter selects the target. |
| `editor` | Editor input captured at admission: either the exact saved revision or an unsaved device draft. Returned origin distinguishes them. |

The default is `editor` when captured editor input is available, otherwise `current` for a chat helper and `library` for a library helper. A clean editor sends only an ID/revision; admission checks that revision and freezes its saved model. A dirty editor sends its prepared device input. Specify the scope when comparing that reservation with live library data. The initial helper context includes identifiers and names without full editor JSON or all source bodies. Current selection is a convenience, not a permission boundary. Unsaved input can be analyzed; writes to that same stored resource require saving the device draft first. Other resources remain usable.

The discovered `editor.read` operation reads the captured editor. These reads use the captured model, including unsaved input, and return a compact overview by default. Follow a returned JSON Pointer `path` with `fields`, `offset`/`limit`, or `textOffset`/`textLimit` to inspect exact types, missing or empty fields, and long text in pages. Each result includes the captured revision and `inputOrigin`; it never substitutes a later saved version. `data.search/read(scope:"editor")` remains the shorter route for ordinary facts. Neither operation saves the draft.

The reader's **도우미에게 물어보기** action preserves the complete selected text in the helper task's `selection`, including its source ID and hash. It does not copy the passage into the current model request a second time or replace an existing request draft. An empty draft receives a short review request. The saved conversation retains the selected passage and source identity for follow-up turns after completed-task input cleanup; the displayed and editable request remains the user's exact text. Requests and selections each accept up to 2,000,000 UTF-16 units, matching stored prose; oversized device input is retained with an explicit message. The actual model context budget still applies without silently truncating selected text.

Search can filter `kinds` and `ids`. Resource kinds include `bot`, `persona`, `module`, and `prompt`; chat sources use `chat`, notes use `note`, unsaved input uses `editor`, and chat overrides use `override`. Explicit author notes and imported-memory claims have distinct metadata. A conflicting override is identified as conflicting rather than silently presented as an applied fact.

Each hit contains an exact `ref`, source `origin`, an original-text excerpt, UTF-16 `range`, `matchRange`, `line`, `totalChars`, and continuation information. Chat metadata includes its scene number and head. `context` counts surrounding UTF-16 units, not lines. Copy a returned reference unchanged:

```json
{"refs":[{"scope":"library","kind":"bot","id":"<returned-id>","revision":7,"field":"/card/description","hash":"<returned-hash>"}],"offset":120,"limit":1200}
```

An empty reference field denotes a document directory. Read it to obtain paged field references, then read the needed field. Field names are JSON pointers, not executable paths. A live revision/hash change yields `DATA_SOURCE_CHANGED`; search again rather than silently reading a different version. Returned source text and offsets are not normalized or rewritten, and surrogate pairs are not split.

`data.read` always accepts `refs` (one to sixteen). A single read still uses a one-item array. Each entry returns its own result or error; a shared text offset/limit applies to all entries. Mixed directory and text reads work with omitted limits. A non-null `nextIndex` identifies refs not returned because of the batch output budget. Submit `refs.slice(nextIndex)` in another call; `nextIndex` is not a text offset. Source-specific `nextOffset` still indicates unread content inside each field.

Search results page by matching windows. Later matches in the same long field remain discoverable. Follow `nextOffset`; `complete` means the selected search traversal is complete, not that the contents of every excerpt have been read or that a fact is absent. Different aliases, omitted ranges, or a different scope can still matter. Do not reread a full bot merely because a bounded excerpt was returned when the supplied evidence already answers the question.

Search defaults to five results, at most fifty, with at most eight patterns. Search responses fit 8,000 serialized UTF-16 units including metadata; `complete:false` and `nextOffset` expose the remaining page. Excerpts are at most 2,000 UTF-16 units. Each text read defaults to 4,000 and accepts at most 10,000 units; directories default to twenty fields, at most fifty. Directory/SQL result assembly retains its approximately 16,000-character output budget. References, metadata, and JSON transport overhead are separate from text length.

## Read-only SQL

Call `db.query` without `sql` to discover actual view columns and examples. The server supplies connection details; neither database paths nor credentials are tool arguments.

| View | Purpose |
| --- | --- |
| `agent_resources` | Current visible bots/personas/modules/presets and their single authored JSON representation. |
| `agent_chats` | Chat titles, current heads, and attached package references. |
| `agent_messages` | Live source ancestry, scene numbers, original request/text, and source hashes. |
| `agent_usage` | Provider-reported attempt usage, role, model, helper task/purpose/segment. |
| `agent_helper_inputs` | Small per-helper-attempt input estimates and preparation timings. |

Use positional `?` parameters and explicit chat filters for scoped questions. SQL is live cross-chat data, not the helper's frozen reservation or an unsaved editor. `agent_messages.request` is the stored run request, not a claim to reproduce every later native script projection.

```json
{"sql":"SELECT id,title,revision FROM agent_resources WHERE kind=? ORDER BY title LIMIT 20","params":["bot"]}
```

```json
{"sql":"SELECT helper_task_id,SUM(input_tokens) input_tokens,COUNT(*) calls FROM agent_usage WHERE helper_task_id IS NOT NULL GROUP BY helper_task_id ORDER BY input_tokens DESC LIMIT 10"}
```

```json
{"sql":"SELECT m.helper_call,m.estimated_input_tokens,m.tool_schema_tokens,m.preparation_ms,m.compaction_ms,u.input_tokens FROM agent_helper_inputs m JOIN agent_usage u ON u.id=m.attempt_id WHERE m.task_id=? ORDER BY m.helper_call","params":["<helper-task-id>"]}
```

SELECT/CTE, joins, aggregates and built-in JSON functions are available. Mutations, extension loading, multiple statements, and unrelated application tables are not part of this interface. Saves continue through app operations so resource revisions and side effects are maintained.

SQL returns at most 200 rows (default 50). Long text cells become explicit 2,000-character previews. `truncated` signals omitted rows and `truncatedCells` counts cell previews. Continue using deterministic ordering and narrower columns/conditions or SQL LIMIT/OFFSET. Large integers outside JavaScript's safe range return as decimal strings; binary values return omitted-byte metadata.

Library title/ID/kind query filters are checked against metadata before loading matching authored document bodies. This preserves the same normalization, ordering and pagination; it reduces local body transfer, not the returned evidence or provider input. Broad queries may still load every matching document.

Both SQL and grep run in a short-lived Node child process with a read-only connection, a three-second deadline, bounded JS/SQLite allocations and cancellation. This keeps a pathological query or regular expression from blocking the server's event loop. Within one `data.read` transaction, references to the same document reuse its parsed source and field directory; every reference still checks its own revision/hash. The cache ends with that request. There is no persistent file mirror, polling service, new database migration, or extra package dependency. Process creation and bounded source loading still have a local cost; these tools reduce model input, not all work to zero.

When an HTTP provider returns adjacent `data.search`, `data.read` or `db.query` calls in one response, the helper runs up to four at a time, capped by Node's `availableParallelism()`. Each finished reader immediately starts the next read in that group. Results, logs and the shared round-output budget follow the original call order after the group settles. All other calls form sequential boundaries; no read passes an app mutation. Cancellation stops active reads, leaves queued reads unstarted, and waits for active work to settle before leaving the group. Native Codex callbacks keep their existing serialized dispatch. This uses short-lived workers without a persistent pool, background scheduler or new setting. The CPU-based cap is a small heuristic, not a workload or container-memory tuner.

## Discovering and executing app operations

An explicit `chatId` selects the target chat for that operation without changing the helper conversation's default scope. Metadata reads, renames, lore operations and outline navigation do not prepare an unused writing snapshot. Only operations that consume reserved story/reference context, ancestry or a writing head prepare it for an explicit target: story/reference reads, forks, notes, context edits/compaction, independent scenes, and outline detail with `section=writings`. Calls without an explicit target retain the task's original reservation. Read/write classification, outline-review availability and writing-context needs share one helper tool policy; `chat.lore` and `library.organize` remain reads only for `action=read`.

For operations unfamiliar to the helper, request their exact schemas first:

```json
{"names":["resource.read","resource.patch"]}
```

That is an `app.tools` request. With no names, the tool returns a compact catalog, optionally filtered by `query`, with an `offset` continuation. Execute the discovered operation through `app.call`:

```json
{"name":"resource.read","arguments":{"kind":"content","id":"<resource-id>"}}
```

`resource.read` defaults to a small overview with `source`, `regions`, and `readyPaths`. Follow a JSON Pointer `path` to page through an object or array (`offset`, `limit`), or name a few object `fields`. Small scalar values keep their JSON types; missing optional fields have `exists:false`. Long strings use `textOffset`, `textLimit`, and `nextOffset`. The serialized read response stays below 24,000 UTF-16 units, including JSON overhead. Pages never claim that omitted text is a complete field.

Use `paths:[...]` instead of `path` to read one to sixteen paths from the same resource and revision with one load. Common field/range options apply to every path. The response is `{items,nextIndex}`; each item keeps its exact typed values and text continuation or its own expected path error. The entire batch shares the 24,000-unit budget. Resubmit `paths.slice(nextIndex)` for unreturned paths, and use an item's `nextOffset` for text remaining inside that path. These are separate pagination dimensions.

For example, read the active lore array returned in `source.lorePath`, then a selected entry's `fields:["comment","key","alwaysActive"]`. Authored `data.read` paths such as `/module/lorebook/0/key` correspond to `/package/nativeRisu/module/lorebook/0/key` in this editing view. Use the returned paths and current resource revision; array positions do not identify entries across revisions.

Editable library native string excerpts include an `editTarget` with `kind`, `id`, `expectedRevision` and the exact editable `path`. To replace an unambiguous literal, this excerpt and target are sufficient: discover `resource.patch` and send `replaceText` directly, without rereading the overview or the whole field. The server still requires one occurrence and the current revision. Frozen chat/editor inputs, derived titles, scalar values converted to text, and protected identity/asset paths do not receive this editing target. Protected paths remain searchable and readable; search hints and patch validation share the same protected-field list. Use typed resource reads when an exact non-string value is needed.

`resource.patch` edits native card/module content and existing native preset text/options using `kind`, `id`, `expectedRevision`, and `changes`. `set` changes a simple typed field or the complete translation guide at `source.translationGuidePath`; `replaceText` replaces one unique literal occurrence. Existing preset fields live below `/program/nativeRisuPreset/preset` or `/values`. `insert` and `remove` act only on an indexed lore entry or translation-guide term; the current resource revision fixes the array positions. Use field edits for smaller changes. Guide validation belongs to the existing resource save. Read `source.lorePath` and the returned paths before structural edits.

All changes are checked and saved together through the existing resource service, with one undo; a no-op does not create a revision. Arbitrary root/object replacement, identity/asset edits and normalized projections remain excluded. Saving regenerates the existing projections and preserves unrelated native data. `resource.save` remains available for creation and other resource types, and UI/backup APIs still return complete models.

Mutation identity is host-owned: app-operation schemas do not ask the model to invent an `operationId`; the helper passes it separately to services that need receipts. A new provider call ID is a new operation, not an automatic replay of a previous write. Revision checks remain explicit. See [Tool contracts](TOOL-CONTRACTS.md). A user request to review or propose still does not authorize saving.

Resource mutations use the existing helper operation receipt in the same transaction as the save. If the provider subsequently fails, the existing UI can show the committed effects and prevent a blind retry. Read-only resource and theme queries do not create mutation receipts. Retrying a failed task replaces its messages in the effective helper history. If an active summary covers those replaced messages, retry enqueue clears only that active checkpoint reference in the same transaction. Enqueue preserves original messages and leaves historical checkpoints untouched; the existing completed-input retention policy may later prune unreferenced checkpoints. Valid earlier checkpoints remain reusable. Dependency validation and the committed-effect retry block still apply.

`chat.lore action=read` defaults to a compact, paged `items` list with attachment scope, lore ID, package revision, original field hashes and text length. `offset/limit` continue that list. Supply `selector:{id,role,modulePath,loreId,field}` to read just one field: `original` and the optional chat `override` have separate text pages, with UTF-16 `textOffset/textLimit` and `nextOffset`. Original text and its hash stay distinct from overridden text and conflict metadata. Copy the returned `expectedRevision`, `expectedHeadRevision`, `expectedProfileRevision`, `expectedPackageRevision` and `expectedFieldHash` into a patch body. Remove still needs only its existing selector/revision/head guard. Reads share a 24,000-unit serialized budget, and successful mutations return a small revision/override receipt rather than the complete original lore. UI models and stored undo/conflict data remain complete.

Overrides whose original lore or attachment has disappeared remain listed with `originalMissing:true`, their selector and conflict information. A selected read returns `original:null` and the saved override page, with revision/head guards for removal but no original-field patch guards. They can still be inspected and explicitly removed without restoring the shared source.

Errors caught by the helper dispatcher return `code`, `retryMode`, `outcome` and `nextAction`: fix arguments, refresh the affected source, narrow a read, or stop. An unexpected write failure records `inspect_outcome`/`unknown` and ends the task instead of inviting another write. Existing receipts determine which effects committed and whether an explicit task retry is eligible. No automatic replay or new retry service is introduced.

The Uimori tool list stays fixed at five throughout a continuation (the same five names with read-only app discovery/dispatch during an explicit outline review). `app.call` retains its envelope name/arguments in native tool history; the host dispatches the inner operation and the UI reports its real operation name. Read exchanges above 32,000 serialized UTF-16 units, or beyond 64,000 new read units in one externally managed provider round, return an explicit `HELPER_READ_TOO_LARGE` result and a smaller-read direction before entering either the helper or summarizer context. This is not silent text truncation and does not turn a committed write into a failed read.

Compaction classifies the inner operation: read bodies can be summarized, while completed mutation exchanges retain exact arguments and results and are not replayed. Named tool schemas and scoped editing reads of at most 8,000 serialized units retain exact returned values in the existing continuation references. Very large mandatory instructions or mutation arguments can still exceed a small context window; the host rejects an oversized fixed context before spending another summary call.

Browser helper input, selection, outline selection, unacknowledged requests and artifact drafts use the existing IndexedDB recovery store. Requests are held in memory before persistence. A failed outbox write offers an explicit send-without-storage action; it cannot promise recovery after reload. An outbox read failure is distinct from an empty outbox. Accepted requests are cleared conditionally, and cleanup or view-refresh failure does not turn server acceptance into transmission failure. Reload never automatically sends recovered requests. Admission compares a small request fingerprint before resolving current resource references, including after completed input cleanup.

## Settings, diagnostics and task control

`model.list` returns stored model IDs/titles and selectable state without credentials or endpoints. `settings.read` returns global and selected-chat model/prompt references, pinned versus effective choices, and revisions without prompt bodies. `settings.update` changes one requested setting with its `expectedRevision`: global model roles, a chat's main model/prompt pin, automatic status or call limit. Existing services preserve unrelated values and emit their normal events. The helper also emits `settings.updated` so a library helper refreshes open settings even without a selected chat. Unsaved settings/editor drafts keep their existing conflict behavior.

`usage.read` reuses the usage page's date ranges, Seoul timezone and known/unknown cost semantics. `task.list` discovers recent active or failed tasks, including queued tasks that have not started a model request. `task.inspect` returns a known task's status, usage and available actions. Helper diagnostics group usage by purpose and show tool-result sizes, `timedCalls`, `elapsedMs` and `queueMs`, including per-tool totals. Elapsed time covers each call's host dispatch and result preparation, including its worker/provider waiting but excluding waiting for a sibling read to finish; queue time covers native host-tool serialization before dispatch. Summed overlapping call times are not batch wall time. A timing total is null when any included call lacks that measurement. Missing usage and unknown Codex internal call counts are not converted to zero.

For `kind:"helper"`, `task.inspect` also returns `committedEffects:{total,offset,items,nextOffset}`. Each item contains a durable `receiptId`, `committed:true`, `createdAt` and optional attribution (`tool`/`callId`, null when unknown). The receipt ID identifies the existing helper operation record; it is not an instruction or idempotency key to submit another write. Results are ordered by receipt creation and paged at twenty items; copy `nextOffset` to `effectsOffset` on the next inspect call. This includes receipts already committed in an otherwise running/failed task. A no-op may still have a committed operation receipt, and a task can fail after an app operation commits.

Only `helper_operations` establishes a commit. Existing `tool.finished` call metadata is matched by the unchanged host call identity, never by a success message, fuzzy name match or output body. This also works after normal completed-input cleanup, which retains receipt identity/time and event callId/name; no new retained manuscript, schema, index or audit store is introduced. If the worker committed but stopped before publishing its event, that receipt is still returned with unknown attribution. Counts cover surviving receipt-backed effects, not all imaginable external actions; an absent receipt is not evidence that an uncertain write failed or permission to retry it. The returned receipt identity, commit flag and attribution also survive the existing read-metadata projection during context compaction. Inspection never replays a mutation, exposes old result payloads, or claims current resource state. Existing task retry eligibility and completed-effect protection remain authoritative.

`task.cancel` and `task.retry` control one explicitly requested run, auxiliary job, illustration job or other helper task. The current helper cannot cancel/retry itself. Retry may create an independent chat; the result identifies the actual new task and chat. Existing eligibility and committed-helper-effect checks remain authoritative. State changes and the helper receipt commit together; controller abort, publication and worker start happen only after that commit. No uncertain task is automatically replayed.

## Accounting and summary preparation

Public task lists and task detail views read a compact projection of task status, usage, the reserved model title and committed-effect counts. They do not restore the full execution snapshot in JavaScript. The browser advances its event cursor without reloading the conversation for diagnostic-only tool/input/context/progress events; task usage/status changes still refresh the view. Execution and retry still read the original snapshot; failed-task inputs and committed-effect receipts keep their existing retention and retry rules.

Closed helper panels and hidden browser tabs pause display timers and response-stream reads while retaining server work, drafts and the received stream cursor. Reopening or focusing the page refreshes immediately. Active work keeps short polling intervals; idle helper lists and sidebar summaries poll every ten seconds. The selected conversation reads events when the list's `latestEventSeq` advances, preserving theme/settings/artifact notifications, and accepting a local task triggers an immediate refresh.

The helper UI labels input tokens as cumulative and counts execution requests. A native Codex request can contain several internal model calls; their count remains unknown, and the configured call limits count host requests rather than those internal calls. The selected model timeout, cancellation and existing task deadline still apply. Provider usage is accumulated across attempts; it is not the last request size. The new `input.measured` event is tied to the actual attempt ID and records local input estimates, component estimates, local preparation time and compaction time without preserving another full request copy. The component estimates are independently serialized diagnostics and do not necessarily sum to the encoded request estimate. `preparation_ms` excludes measured compaction work; `compaction_ms` includes summary work and provider waiting. Neither is a first-token or total end-to-end latency measurement.

These numeric events remain after ordinary completed-input cleanup. Tool events retain `callId`, `elapsedMs`, `queueMs`, `originalResultChars` and `providedResultChars` for the handler result before and after the helper boundary; the size fields do not measure the entire source resource behind a paged read. Old attempts need not have these values; no historical values are fabricated. `agent_usage` is provider-reported usage; `agent_helper_inputs` is local o200k-based estimation with the app's margin. Do not combine them as though both were actual billed tokens.

Codex helpers use one ephemeral native thread and turn for each helper task. The five Uimori tools are registered as dynamic tools; `item/tool/call` feeds the same dispatcher, result limits, revision checks and receipts used by other providers. Uimori does not create another Codex process and serialize the accumulated results after each tool call. Native tool exchanges are recorded as task events without accumulating a second in-memory history for host compaction. Final output is ordinary assistant text; public commentary is kept separate from the final answer. The native turn may compact its own history. Host compaction can still prepare an oversized conversation history before the turn starts, and manual conversation summaries keep their existing owner.

A short Uimori-specific `baseInstructions` replaces the default coding instructions. Illustration turns have their own short instructions and image-only tool configuration. Each override participates in the descriptor and stable-prefix identity. Codex's native tool descriptions and other runtime context remain outside the local app-input estimate, so the provider input total can still be higher. Reported cached-input and reasoning-output usage are retained in numeric raw usage when supplied; absent values remain unknown.

Manual conversation compaction indexes logical messages once and fits its known source prefix without reconstructing the full writer input for every candidate. It still validates source identity and complete source coverage, preserves recent exchanges, sends every selected fragment, and checks the actual merged summary before adopting it. Automatic compaction and semantic summary length policy are not replaced by a keyword-only shortcut.

## Goal evaluation

[Helper goal evaluation](HELPER-EVALUATION.md) fixes synthetic sources, allowed/forbidden changes and completion oracles before execution. Scripted provider checks verify transport and storage; they do not establish a real model's tool-selection or instruction-following quality.


### Illustration presets

Discover `illustration-preset.list` and `illustration-preset.guide` through `app.tools` and invoke them with `app.call`. The list returns compact names/revisions/descriptions and selections, not every workflow. Use `resource.read/save/undo/delete` with `kind: illustration-preset` for the authored model and the existing revision/operation receipt contract. A new save does not select a preset or generate an image. Editing a selected preset changes future reservations only; existing jobs and retries keep their frozen recipe. Provider credentials, model routing, automatic policies and per-chat reference images stay outside the preset. User-facing selection and portability are documented in [Illustrations](ILLUSTRATIONS.md#삽화-프리셋).


### Bounded composition reads

`outline.read` through `app.call` uses overview/subtree/detail modes, not the browser's full tree response. All modes use offset/limit: lists count items and intent counts UTF-16 units. Lists clamp at 50 items and intent at 10,000 units; defaults are 20 and 6,000. Only a selected intent is materialized, and selected preview rows are read in one query. Related/writings references are fetched only for those sections. `coverage` distinguishes returned metadata/previews from intent ranges, counts depth-excluded nodes, and never certifies a complete review. For intent only, `wholeField` replaces the ambiguous `complete`: it is true only when this response covers start=0 through the field end. A last partial page still has wholeField=false and nextOffset=null. Follow nextOffset for pagination; aggregate returned ranges only within the same view. Search tools keep their existing complete semantics. Copy `nextRead` including `expectedVersion` to continue the same query scope; start a new first page when changing mode/section. Unrelated sibling edits do not invalidate a node detail or another subtree. Changed views return a recoverable `OUTLINE_CHANGED` without read coverage; a removed selection redirects to overview. A round-budget rejection retries the same outline range at a smaller size, not an unrelated library search. Coverage, version, exact source refs and continuation instructions remain in completed-read metadata after host compaction.

Writings identify exact frozen or current edited source hashes and return existing data.read refs. The live agent_messages view uses the latest source edit; current scope remains the task's frozen text. A source absent from the current history is reported unavailable rather than matched to another scene. `outline.write` retains its atomic operation receipt but returns only created IDs and per-operation results instead of hydrating the entire tree. Browser outline responses remain unchanged. See [OUTLINE](OUTLINE.md) for modes, limits, seed coverage and review staleness.


`knowledge.search mode=browse` is also available through existing `app.tools/app.call`, including read-only review. Its package/folder references and versions address the task's frozen effective writing resources, not the live outline view or an unrestricted library. Wrap its returned main-tool `nextRead` in app.call. Browse metadata carries scope/coverage into compaction but does not count as a retained knowledge.read range. The view is built once per frozen Run object/role and weakly held for that object’s lifetime; page navigation does not rehash the corpus. The current JEV and flat catalog policy is unchanged; see [Folder navigation](TOOL-CONTRACTS.md#folder-navigation).
