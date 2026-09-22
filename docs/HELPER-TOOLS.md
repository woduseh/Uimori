# Helper data and app tools

The helper has five native tools: `data.search`, `data.read`, `db.query`, `app.tools`, and `app.call`. This is an input-size boundary, not a new approval mode. The existing app operations remain available through discovery and dispatch, including resource saves, chat options, lore overrides, notes, outlines, context summaries, and independent scene generation.

The writer, advisors, and translation jobs retain their existing source-scoped tools. A helper's live cross-chat SQL access is not automatically inherited by those roles. Conversation summarization still reads its complete selected source prefix, not keyword search hits.

## Search and partial reads

Use `data.search` for factual lookup. It searches authored scalar fields once rather than returning the entire editing model with duplicate projections. Native content uses its card/module fields; the same description is not also repeated through `content.text` and `package.body`. Prompt programs and unsaved editor fields are searchable too. Search does not execute native CBS/Lua or infer facts from scripts. Use discovered app reads, such as `knowledge.read` and `chat.lore`, for their established effective-context contracts.

```json
{"scope":"library","query":"하린","kinds":["bot"],"patterns":["나이","Age","years old"],"match":"any"}
```

`query` filters title/ID/kind; `patterns` searches field text. Patterns are case-insensitive literal strings by default, including two-character Korean terms and punctuation. Set `regex:true` for regular expressions. `match:"all"` requires all patterns in the same field, not necessarily the same returned excerpt. Empty/absent patterns list document references for browsing.

The scopes are:

| Scope | Data and time boundary |
| --- | --- |
| `current` | This helper task's reserved chat packages, source ancestry, user requests, notes, and chat overrides. Includes original prose that may have been compacted out of a model window. |
| `library` | Current visible library originals, with their current revisions. |
| `chats` | Live original sources in actual chat/branch ancestries. Optional `chatId`/`branchId` filters select the target. |
| `editor` | Device input captured with this helper task; it is not a saved resource. |

The default is `editor` when an editor model was supplied, otherwise `current` for a chat helper and `library` for a library helper. Specify the scope when comparing saved data with unsaved input. The initial helper context includes selected resource identifiers and names without its full editor JSON or all source bodies. Current selection is a convenience, not a permission boundary.

Search can filter `kinds` and `ids`. Resource kinds include `bot`, `persona`, `module`, and `prompt`; chat sources use `chat`, notes use `note`, unsaved input uses `editor`, and chat overrides use `override`. Explicit author notes and imported-memory claims have distinct metadata. A conflicting override is identified as conflicting rather than silently presented as an applied fact.

Each hit contains an exact `ref`, source `origin`, an original-text excerpt, UTF-16 `range`, `matchRange`, `line`, `totalChars`, and continuation information. Chat metadata includes its scene number and head. `context` counts surrounding UTF-16 units, not lines. Copy a returned reference unchanged:

```json
{"refs":[{"scope":"library","kind":"bot","id":"<returned-id>","revision":7,"field":"/card/description","hash":"<returned-hash>"}],"offset":120,"limit":1200}
```

An empty reference field denotes a document directory. Read it to obtain paged field references, then read the needed field. Field names are JSON pointers, not executable paths. A live revision/hash change yields `DATA_SOURCE_CHANGED`; search again rather than silently reading a different version. Returned source text and offsets are not normalized or rewritten, and surrogate pairs are not split.

`data.read` always accepts `refs` (one to sixteen). A single read still uses a one-item array. Each entry returns its own result or error; a shared text offset/limit applies to all entries. Mixed directory and text reads work with omitted limits. A non-null `nextIndex` identifies refs not returned because of the batch output budget. Submit `refs.slice(nextIndex)` in another call; `nextIndex` is not a text offset. Source-specific `nextOffset` still indicates unread content inside each field.

Search results page by matching windows. Later matches in the same long field remain discoverable. Follow `nextOffset`; `complete` means the selected search traversal is complete, not that the contents of every excerpt have been read or that a fact is absent. Different aliases, omitted ranges, or a different scope can still matter. Do not reread a full bot merely because a bounded excerpt was returned when the supplied evidence already answers the question.

Search defaults to ten results, at most fifty, with at most eight patterns. Excerpts are at most 2,000 UTF-16 units. Each text read defaults to 4,000 and accepts at most 10,000 units; directories default to twenty fields, at most fifty. Search/directory/SQL result assembly uses a small approximately 16,000-character output budget. References, metadata, and JSON transport overhead are separate from text length.

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

Both SQL and grep run in a short-lived Node child process with a read-only connection, a three-second deadline, bounded JS/SQLite allocations and cancellation. This keeps a pathological query or regular expression from blocking the server's event loop. There is no persistent file mirror, polling service, new database migration, or extra package dependency. Process creation and bounded source loading still have a local cost; these tools reduce model input, not all work to zero.

## Discovering and executing app operations

For operations unfamiliar to the helper, request their exact schemas first:

```json
{"names":["resource.read","resource.save"]}
```

That is an `app.tools` request. With no names, the tool returns a compact catalog, optionally filtered by `query`, with an `offset` continuation. Execute the discovered operation through `app.call`:

```json
{"name":"resource.read","arguments":{"kind":"content","id":"<resource-id>"}}
```

For an existing save, preserve the native editing model and supply the latest revision according to `resource.save`'s discovered schema. Mutation identity is host-owned: app-operation schemas do not ask the model to invent an `operationId`; the helper passes it separately to services that need receipts. A new provider call ID is a new operation, not an automatic replay of a previous write. Revision checks remain explicit. See [Tool contracts](TOOL-CONTRACTS.md). Editing tools intentionally retain full models where necessary; a simple factual question should use the data tools instead. A user request to review or propose still does not authorize saving.

Resource mutations use the existing helper operation receipt in the same transaction as the save. If the provider subsequently fails, the existing UI can show the committed effects and prevent a blind retry. Read-only resource and theme queries do not create mutation receipts.

The provider-visible tool list stays fixed at five throughout a native continuation. `app.call` retains its envelope name/arguments in native tool history; the host dispatches the inner operation and the UI reports its real operation name. Compaction classifies the inner operation: read bodies can be summarized, while completed mutation exchanges retain exact arguments and results and are not replayed. Very large mandatory instructions or mutation arguments can still exceed a small context window; the host does not silently truncate them to claim success.

## Accounting and summary preparation

The helper UI labels input tokens as cumulative. Provider usage is accumulated across attempts; it is not the last request size. The new `input.measured` event is tied to the actual attempt ID and records local input estimates, component estimates, local preparation time and compaction time without preserving another full request copy. The component estimates are independently serialized diagnostics and do not necessarily sum to the encoded request estimate. `preparation_ms` excludes measured compaction work; `compaction_ms` includes summary work and provider waiting. Neither is a first-token or total end-to-end latency measurement.

These numeric events remain after ordinary completed-input cleanup. Old attempts need not have them; no historical values are fabricated. `agent_usage` is provider-reported usage; `agent_helper_inputs` is local o200k-based estimation with the app's margin. Do not combine them as though both were actual billed tokens.

Manual conversation compaction indexes logical messages once and fits its known source prefix without reconstructing the full writer input for every candidate. It still validates source identity and complete source coverage, preserves recent exchanges, sends every selected fragment, and checks the actual merged summary before adopting it. Automatic compaction and semantic summary length policy are not replaced by a keyword-only shortcut.
