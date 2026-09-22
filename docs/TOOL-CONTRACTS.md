# Model tool contracts

Uimori keeps model-facing tools deliberately small and provider-portable. Runtime services may keep richer internal identifiers and idempotency metadata, but those details do not become extra ways for a model to express the same operation.

## Read tools

The main writer and translation role use the shared definitions in `core/read-tools.ts`. Advisors receive the subset enabled for them. Role-specific source scope still applies:

| Tool | Contract |
| --- | --- |
| `knowledge.search {query?, offset?, limit?}` | Browse/search approved local references. |
| `knowledge.read {ids, offset?, limit?}` | Read one to sixteen references. A single read still uses a one-item `ids` array. Each item succeeds or fails independently and returns `nextOffset`. |
| `skills.list {query?, offset?, limit?}` | Browse/search available writing guidance. |
| `skills.load {id, offset?, limit?}` | Read one guidance resource. |
| `story.search {query?, offset?, limit?}` | With no query, browse frozen story ancestry in order; with a query, search it. Results expose stable 1-based `sceneNumber` values. |
| `story.read {sceneNumber, offset?, limit?}` | Read one frozen story source by scene number. Internal revision IDs remain returned provenance, not an alternate selector. |

Explicit user notes are already pinned to the Run and delivered through the `notes` prompt slot or host context. There is no separate `notes.list/read` model API.

The helper's native data surface stays at five tools: `data.search`, `data.read`, `db.query`, `app.tools`, and `app.call`. `data.read` likewise always accepts `refs`, including a one-item array.

## Schema portability

Provider-visible tool roots are ordinary JSON Schema objects. Do not put `oneOf`, `anyOf`, or `allOf` at the root of a tool `inputSchema`. Providers support different JSON Schema subsets, and Anthropic rejects those root combiners for tool input schemas.

Prefer one canonical argument shape instead of schema unions:

- use `ids: [id]` instead of `id | ids`;
- use `refs: [ref]` instead of `ref | refs`;
- use `sceneNumber` instead of `revisionId | sceneNumber`.

When a semantic condition cannot be represented portably without a union, keep the simple object schema and validate the condition in the host runtime.

## Pagination and results

Main reference collections use `items` or `results`, `total`, and `nextOffset`. Text reads expose `totalChars`, the returned range, and `nextOffset`. A null `nextOffset` means no later page remains; it does not claim that an omitted earlier range was read.

Helper `data.read` has two distinct pagination dimensions: each item's `nextOffset` continues its text or field directory, while batch `nextIndex` points to unreturned refs. Resubmit `refs.slice(nextIndex)` rather than passing that index as a text offset. The helper's streaming search reports `complete` instead of an exact total. See [Helper tools](HELPER-TOOLS.md) for its page sizes and result budgets.

Batch reads keep resource failures local to each entry, including a malformed helper ref. Invalid batch structure, such as a missing or empty array, still fails the call. Mistyped scene numbers and text offsets return correctable errors; corrupt frozen story sources are still denied, never silently read.

## Mutations

Revision and source-hash checks remain explicit when they protect stale-write correctness. Idempotency identity is different: the model does not invent `operationId` values for helper app mutations.

The helper derives mutation identity from the helper task ID and provider tool-call ID and passes it separately from model arguments. Only adapters for services that use receipts add the identity to their internal commands. There is no second mutation-tool registry to maintain.

Reusing a completed tool-call ID is rejected by the helper loop. A new call ID is a new operation, not a semantic replay of a prior request. Existing-resource saves still use revision checks; identical new-resource creation requests with different call IDs are not automatically deduplicated.

`app.tools -> app.call` remains intentional. It keeps the helper's native tool list and per-request schema tokens small while exposing exact operation schemas only when needed.
