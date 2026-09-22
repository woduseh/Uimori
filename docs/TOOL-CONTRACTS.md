# Model tool contracts

Uimori keeps model-facing tools deliberately small and provider-portable. Runtime services may keep richer internal identifiers and idempotency metadata, but those details do not become extra ways for a model to express the same operation.

## Read tools

The main writer, translation role, and advisors share these reference tools:

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

Collection reads use `items` or `results`, `total`, and `nextOffset`. Text reads expose `totalChars` and `nextOffset`. A null `nextOffset` means the selected item or traversal is complete.

Batch reads keep failure local to each entry. For example, one unavailable `knowledge.read` ID produces an item-level error without discarding successful reads from the same batch.

## Mutations

Revision and source-hash checks remain explicit when they protect stale-write correctness. Idempotency identity is different: the model does not invent `operationId` values for helper app mutations.

The helper derives mutation identity from the immutable helper task ID and the provider tool-call ID, then passes that host-owned value to internal services that need receipts or idempotency keys. This preserves duplicate-write protection without adding bookkeeping arguments to every model-facing mutation schema.

`app.tools -> app.call` remains intentional. It keeps the helper's native tool list and per-request schema tokens small while exposing exact operation schemas only when needed.
