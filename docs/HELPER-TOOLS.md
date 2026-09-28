# Helper data and app tools

The helper has five native tools: `data.search`, `data.read`, `db.query`, `app.tools`, and `app.call`. This is an input-size boundary, not a new approval mode. The existing app operations remain available through discovery and dispatch, including resource saves, chat options, lore overrides, notes, outlines, context summaries, and independent scene generation.

The writer, advisors, and translation jobs retain their existing source-scoped tools. A helper's live cross-chat SQL access is not automatically inherited by those roles. Conversation summarization still reads its complete selected source prefix, not keyword search hits.

## Search and partial reads

Use `data.search` for factual lookup. It searches authored scalar fields once rather than returning the entire editing model with duplicate projections. Native content uses its card/module fields; the same description is not also repeated through `content.text` and `package.body`. Prompt programs and unsaved editor fields are searchable too. Search does not execute native CBS/Lua or infer facts from scripts. Use discovered app reads, such as `knowledge.read` and `chat.lore`, for their established effective-context contracts.

```json
{"scope":"library","query":"하린","kinds":["bot"],"patterns":["나이","Age","years old"],"match":"any"}
```

`query` filters title/ID/kind; `patterns` searches field text. Patterns are case-insensitive literal strings by default, including two-character Korean terms and punctuation. Set `regex:true` for regular expressions. `match:"all"` requires all patterns in the same field, not necessarily the same returned excerpt. Empty/absent patterns list document references for browsing.

Use `output:"documents"` to locate resources by a name mentioned in their contents, like a filenames-only grep: each matching document appears once without body excerpts. A failed title `query` does not prove that a resource is absent; remove that filter before searching spelling variants in `patterns`. Then pass the selected `ids` and search the requested fact with the default `output:"matches"`. `paths` optionally limits both modes to exact JSON Pointer fields or their children. Human-authored descriptions and lore are searched before extensions/assets; HTML and scripts remain explicitly searchable and are not silently excluded.

Document results retain their `scope` and, for chat sources, `chatId` and `branchId`. When narrowing `scope:"chats"` results, carry those identifiers into the next search so a source stays associated with the selected chat. Other scopes do not accept chat/branch filters.

The scopes are:

| Scope | Data and time boundary |
| --- | --- |
| `current` | This helper task's reserved chat packages, source ancestry, user requests, notes, and chat overrides. Includes original prose that may have been compacted out of a model window. |
| `library` | Current visible library originals, with their current revisions. |
| `chats` | Live original sources in actual chat/branch ancestries. Optional `chatId`/`branchId` filters select the target. |
| `editor` | Editor input captured at admission: either the exact saved revision or an unsaved device draft. Returned origin distinguishes them. |

The default is `editor` when captured editor input is available, otherwise `current` for a chat helper and `library` for a library helper. A clean editor sends only an ID/revision; admission checks that revision and freezes its saved model. A dirty editor sends its prepared device input. Specify the scope when comparing that reservation with live library data. The initial helper context includes identifiers and names without full editor JSON or all source bodies. Current selection is a convenience, not a permission boundary. Unsaved input can be analyzed; writes to that same stored resource require saving the device draft first. Other resources remain usable.

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
| `agent_chats` | Chat titles, branch heads, and attached package references. |
| `agent_messages` | Live source ancestry, scene numbers, original request/text, and source hashes. |
| `agent_usage` | Provider-reported attempt usage, role, model, helper task/purpose/segment. |
| `agent_helper_inputs` | Small per-helper-attempt input estimates and preparation timings. |

Use positional `?` parameters and explicit chat/branch filters for scoped questions. SQL is live cross-chat data, not the helper's frozen reservation or an unsaved editor. `agent_messages.request` is the stored run request, not a claim to reproduce every later native script projection.

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

Both SQL and grep run in a short-lived Node child process with a read-only connection, a three-second deadline, bounded JS/SQLite allocations and cancellation. This keeps a pathological query or regular expression from blocking the server's event loop. There is no persistent file mirror, polling service, new database migration, or extra package dependency. Process creation and bounded source loading still have a local cost; these tools reduce model input, not all work to zero.

## Discovering and executing app operations

For operations unfamiliar to the helper, request their exact schemas first:

```json
{"names":["resource.read","resource.patch"]}
```

That is an `app.tools` request. With no names, the tool returns a compact catalog, optionally filtered by `query`, with an `offset` continuation. Execute the discovered operation through `app.call`:

```json
{"name":"resource.read","arguments":{"kind":"content","id":"<resource-id>"}}
```

`resource.read` defaults to a small overview with `source`, `regions`, and `readyPaths`. Follow a JSON Pointer `path` to page through an object or array (`offset`, `limit`), or name a few object `fields`. Small scalar values keep their JSON types; missing optional fields have `exists:false`. Long strings use `textOffset`, `textLimit`, and `nextOffset`. The serialized read response stays below 24,000 UTF-16 units, including JSON overhead. Pages never claim that omitted text is a complete field.

For example, read the active lore array returned in `source.lorePath`, then a selected entry's `fields:["comment","key","alwaysActive"]`. Authored `data.read` paths such as `/module/lorebook/0/key` correspond to `/package/nativeRisu/module/lorebook/0/key` in this editing view. Use the returned paths and current resource revision; array positions do not identify entries across revisions.

Editable library native string excerpts include an `editTarget` with `kind`, `id`, `expectedRevision` and the exact editable `path`. To replace an unambiguous literal, this excerpt and target are sufficient: discover `resource.patch` and send `replaceText` directly, without rereading the overview or the whole field. The server still requires one occurrence and the current revision. Frozen chat/editor inputs, derived titles, scalar values converted to text, and protected identity/asset paths do not receive this editing target. Protected paths remain searchable and readable; search hints and patch validation share the same protected-field list. Use typed resource reads when an exact non-string value is needed.

`resource.patch` changes existing native card/module fields with `kind`, `id`, `expectedRevision`, and `changes`. Each change is either `{path,op:"set",value}` for a scalar or scalar array, or `{path,op:"replaceText",oldText,newText}` for one unique literal occurrence. All changes are checked and saved together through the existing resource service, with one undo; a no-op does not create a revision. Root/object replacement, structural array edits, internal identity fields and normalized projections are not patch targets. Follow the active card/module owner; saving regenerates the existing projections and preserves unrelated native data. `resource.save` remains available for creation and other resource types, and UI/backup APIs still return complete models.

Mutation identity is host-owned: app-operation schemas do not ask the model to invent an `operationId`; the helper passes it separately to services that need receipts. A new provider call ID is a new operation, not an automatic replay of a previous write. Revision checks remain explicit. See [Tool contracts](TOOL-CONTRACTS.md). A user request to review or propose still does not authorize saving.

Resource mutations use the existing helper operation receipt in the same transaction as the save. If the provider subsequently fails, the existing UI can show the committed effects and prevent a blind retry. Read-only resource and theme queries do not create mutation receipts. Retrying a failed task replaces its messages in the effective helper history. If an active summary covers those replaced messages, retry enqueue clears only that active checkpoint reference in the same transaction. Enqueue preserves original messages and leaves historical checkpoints untouched; the existing completed-input retention policy may later prune unreferenced checkpoints. Valid earlier checkpoints remain reusable. Dependency validation and the committed-effect retry block still apply.

The provider-visible tool list stays fixed at five throughout a native continuation. `app.call` retains its envelope name/arguments in native tool history; the host dispatches the inner operation and the UI reports its real operation name. Read exchanges above 32,000 serialized UTF-16 units, or beyond 64,000 new read units in one round, return an explicit `HELPER_READ_TOO_LARGE` result and a smaller-read direction before entering either the helper or summarizer context. This is not silent text truncation and does not turn a committed write into a failed read.

Compaction classifies the inner operation: read bodies can be summarized, while completed mutation exchanges retain exact arguments and results and are not replayed. Named tool schemas and scoped editing reads of at most 8,000 serialized units retain exact returned values in the existing continuation references. Very large mandatory instructions or mutation arguments can still exceed a small context window; the host rejects an oversized fixed context before spending another summary call.

Browser helper input, selection, outline selection, unacknowledged requests and artifact drafts use the existing IndexedDB recovery store. Legacy localStorage values are removed only after successful migration, and conflicting values are preserved. Requests are held in memory before persistence. A failed outbox write offers an explicit send-without-storage action; it cannot promise recovery after reload. An outbox read failure is distinct from an empty outbox. Accepted requests are cleared conditionally, and cleanup or view-refresh failure does not turn server acceptance into transmission failure. Reload never automatically sends recovered requests. Admission compares a small request fingerprint before resolving current resource references, including after completed input cleanup.

## Accounting and summary preparation

The helper UI labels input tokens as cumulative. Provider usage is accumulated across attempts; it is not the last request size. The new `input.measured` event is tied to the actual attempt ID and records local input estimates, component estimates, local preparation time and compaction time without preserving another full request copy. The component estimates are independently serialized diagnostics and do not necessarily sum to the encoded request estimate. `preparation_ms` excludes measured compaction work; `compaction_ms` includes summary work and provider waiting. Neither is a first-token or total end-to-end latency measurement.

These numeric events remain after ordinary completed-input cleanup. Tool events also retain `originalResultChars` and `providedResultChars` for the handler result before and after the helper boundary; they do not measure the entire source resource behind a paged read. Old attempts need not have these values; no historical values are fabricated. `agent_usage` is provider-reported usage; `agent_helper_inputs` is local o200k-based estimation with the app's margin. Do not combine them as though both were actual billed tokens.

Codex helper turns use a short Uimori-specific `baseInstructions` instead of the model's default coding instructions. Other roles and illustration turns retain their existing instructions, and the native tool configuration is unchanged. The same override participates in the descriptor and stable-prefix identity. Codex's native tool descriptions and other runtime context remain outside the local app-input estimate, so the provider input total can still be higher. Reported cached-input and reasoning-output usage are retained in numeric raw usage when supplied; absent values remain unknown.

Manual conversation compaction indexes logical messages once and fits its known source prefix without reconstructing the full writer input for every candidate. It still validates source identity and complete source coverage, preserves recent exchanges, sends every selected fragment, and checks the actual merged summary before adopting it. Automatic compaction and semantic summary length policy are not replaced by a keyword-only shortcut.

## Goal evaluation

[Helper goal evaluation](HELPER-EVALUATION.md) fixes synthetic sources, allowed/forbidden changes and completion oracles before execution. Scripted provider checks verify transport and storage; they do not establish a real model's tool-selection or instruction-following quality.


### Illustration presets

Discover `illustration-preset.list` and `illustration-preset.guide` through `app.tools` and invoke them with `app.call`. The list returns compact names/revisions/descriptions and selections, not every workflow. Use `resource.read/save/undo/delete` with `kind: illustration-preset` for the authored model and the existing revision/operation receipt contract. A new save does not select a preset or generate an image. Editing a selected preset changes future reservations only; existing jobs and retries keep their frozen recipe. Provider credentials, model routing, automatic policies and per-chat reference images stay outside the preset. User-facing selection and portability are documented in [Illustrations](ILLUSTRATIONS.md#삽화-프리셋).
