# Helper tools and runtime invariants

Developer-only technical specifications for the helper tools, attachments, and execution diagnostics.

## Overview

Tool arguments, limits, and result contracts live in the model-facing tool descriptions, input schemas, and tests; this document records only what that code does not state. [CODE-MAP](CODE-MAP.md) owns the feature entry files.

The helper's provider-facing tools are `app.tools` and `app.call`, plus `data.exec` when `UIMORI_SHELL_ROOT` configures the Linux runner. Everything else, including `data.search`, `data.read` and `db.query`, is an app operation reached through those gateways or the `uimori call` CLI.

Constraints on changing the helper's tools:

- A new capability is an app operation, not another provider tool; see [Mutations](TOOL-CONTRACTS.md#mutations) for why `app.tools` and `app.call` exist.
- An explicit outline review is read-only: `data.exec` is omitted, and both discovery and `app.call` use the `reviewAllowed` allowlist in `helperToolTraits`, which is narrower than the set of read-only operations.
- Safety does not depend on call order; revision checks and uncertain-write handling are enforced at save time, so discovery and confirmation rereads remain optional.
- For non-Codex helper and advisor requests without an authored prompt, unchanged `history` and `catalog` go in the first user-content block so follow-up requests share a prefix without dropping context or promoting it to system instructions (`tests/provider-reference-context.test.ts`). A shared prefix is not a measured cache hit; see [model cache settings](../MODEL-PARAMETERS.md#캐시-위치자동-배치유지-시간).
- A Codex helper registers the same tools as native dynamic tools and runs one task in one thread and turn; see [App Server communication and turn lifecycle](PROVIDERS-AND-CODEX.md#app-server-communication-and-turn-lifecycle).

Outside the helper's tools:

- The writer, advisors and translation jobs have their own source-scoped tools ([Read tools](TOOL-CONTRACTS.md#read-tools)) and never inherit the helper's live cross-chat SQL access.
- Conversation summarization reads its complete selected source prefix, not keyword search hits.

## General tool discovery, CLI and results

Discovery ranking, paging, review filtering, the area index, and the library-scope error to `chat.list` are enforced by `tests/helper-discovery.test.ts`, `tests/helper-tool-contracts.test.ts`, and `tests/tool-contract-portability.test.ts`; CLI flags and failed-shell reporting are enforced by `tests/helper-cli.test.ts` and `tests/helper-shell-runtime.test.ts`. Caller-visible ranking rules live in [General tool discovery, CLI and results](../HELPER-TOOLS.md#general-tool-discovery-cli-and-results).

Constraints on changing these operations:

- Operation names, descriptions, schema parameter descriptions, and per-operation synonyms are the BM25 ranking corpus (with deliberately mild length normalization so complex operations are not penalized for length); rewording them shifts ranking ([Names, descriptions and parameters](TOOL-CONTRACTS.md#names-descriptions-and-parameters)).
- The `uimori` CLI carries no copy of any schema; its flags are typed against the operation's live input schema when the call reaches the app.

## Stored content images

`MAX_BYTES`, reads inside `data.exec`, and image release across compaction are enforced by `tests/helper-image-runtime.test.ts`. Caller-visible delivery and memory lifetime live in [Stored content images](../HELPER-TOOLS.md#stored-content-images).

Constraints on changing these operations:

- `prepareHelperImage` is the single choke point that decodes, resizes, and hashes pictures for `image.read`, `illustration.image.read`, and `illustration.cut.read`; transports send the prepared bytes unchanged.
- `providerImagePart` decides per-connection delivery; only a model `imageInputSupported` knows to be text-only is refused before the read.

Outside these operations:

- Unsaved editor drafts, image versions pinned by older chats, and helper message attachments ([도우미 첨부](../HELPER-ATTACHMENTS.md)); `image.list` and `image.read` read current saved library content only.

## Illustration appearance profiles

Chat targeting from the library, all-or-nothing batches, and wrong-scope errors are enforced by `tests/helper-tool-contracts.test.ts`.

Outside these operations:

- Shared default profiles of a bot or persona are library data saved via `resource.patch` at `source.appearanceProfilesPath`. `illustration.profiles.save` never writes them and stores chat-local overrides only; see [인물 외형과 참고 이미지](../ILLUSTRATIONS.md#인물-외형과-참고-이미지).

### Work with generated illustrations

Guards, all-or-nothing reservation, and withheld fields on illustration task inspection are enforced by `tests/helper-tool-contracts.test.ts`.

Constraints on changing these operations:

- These operations add no generation, deletion, or layout path of their own: `illustration.generate`, `illustration.cut.redraw`, and `illustration.cut.revise` reserve jobs in the normal illustration queue (with ordinary prompt preparation and content checks), `illustration.cut.delete` calls existing deletion, and placement saves the scene's existing layout.

Outside these operations:

- Generators, queueing, limits, and Reader display; see [Scene illustrations](PROVIDERS-AND-CODEX.md#scene-illustrations).

## Conversation history and task results

Scope filters, deletion ownership, no-op outcomes, payload-cleanup survival, net-change calculation, asset cleanup, and withheld private fields are enforced by `tests/helper-workspace.test.ts` and `tests/helper-changes.test.ts`. Caller-visible field behavior lives in [Conversation history and task results](../HELPER-TOOLS.md#conversation-history-and-task-results).

Semantics the response shapes (`HelperTaskResultsView`) leave out:

- A receipt without a compact outcome counts in `unrecordedOperations`; its changes are unknown and are never reconstructed from tool arguments or message text.
- An `outcome` confirms a commit (or queueing, for `scene.request` and `scene.translate`), not the target's current state.
- `usage.toolExecutions` counts recorded `tool.finished` events (interrupted callbacks are excluded); `usage.latestInputEstimate` is the last stored local estimate, not a percentage or a native agent's current context; `usage.latestInputParts` and `usage.latestInputExecution` split measured request parts and loop mode.
- The composer indicator draws a budget bar only for the provider loop, marks automatic compaction at `HELPER_COMPACTION_INPUT_RATIO`, and triggers manual compaction (`HelperRuntime.compactConversation` → `publishManualHelperContext`) with numeric-only `summary` usage, refusing while a task or compaction is active or on `codex-native` (`HUSAGE02`, `tests/helper-compaction.test.ts`).
- Manual compaction is detached from its HTTP request so a closed tab or a sleeping phone cannot abort a long summary; only `DELETE …/compact` (`HelperRuntime.cancelCompaction`), the helper task timeout or server shutdown stop it. The running flag lives in `HelperRuntime.compacting` and is lost on restart, which costs at most one in-flight summary because `publishManualHelperContext` publishes atomically. The last outcome is not stored separately: `readHelperContextState` derives it from the taskless `context.compaction` / `context.compaction.failed` events and hides it once a task event or `messages.changed` follows, because the post-compaction estimate (`afterTokens` replacing `beforeTokens` in the latest measurement) is only meaningful until the next request is measured. Taskless `context.compaction*` events are therefore not diagnostic (`diagnosticHelperEvent`): they are how a second tab or the initiating panel learns that a compaction started or ended. They reach every tab as `helper` frames on the tab's live connection, and the frame alone decides whether the panel reads, so a new taskless kind that should refresh other tabs must keep the `context.compaction` prefix or another non-diagnostic name.
- The summary dialog (`HUSAGE03`) reads `GET …/context` on open rather than widening `/view`, because the text can be large. Editing (`HelperRuntime.editContextSummary` → `publishEditedHelperContext`) inserts an `edit` checkpoint that keeps the active plan's compacted ranges and replaces only the summary; reset (`resetHelperContext`) drops the head's checkpoint the same way message edits do. Both are refused with `HELPER_COMPACTION_BUSY`, not deferred, while a task is queued or running or a compaction holds `HelperRuntime.compacting`, so a running task never sees its pinned checkpoint replaced underneath it. Idempotency is the head-revision CAS alone: `context_commands.chat_id` cannot hold a library-scoped conversation, so the client resolves a 409 by re-reading and treating an identical stored summary as its own save. An edit over `HELPER_COMPACTION_INPUT_RATIO` of the current helper model's input limit is refused (`HELPER_SUMMARY_TOO_LARGE`) because the next task would re-summarize it at once. Both emit a taskless `context.compaction.edited` (`origin: 'edit' | 'reset'`) that `readHelperContextState` reads as a completed outcome; its `beforeTokens` carries forward the visible outcome's value, so the composer estimate (`amount - beforeTokens + afterTokens`) stays right across consecutive edits, and a reset's `afterTokens` is the estimate of the restored messages.
- The summary call shares the main loop's overload retry (`HelperRuntime.waitForProviderRetry`, `HELPER_PROVIDER_RETRY_DELAYS_MS`) and sends only the attachments the context model accepts (`imageInputSupported`, `fileInputSupported`, the protocol's file-size limits); the attachment names stay in the summarized history JSON. A failure is recorded as one of `HELPER_COMPACTION_FAILURES`. `HELPER_COMPACTION_EMPTY` covers both empty text and an output-limit stop: `contextSummaryPolicy` caps `maxOutputTokens` at twice the summary goal when no thinking option is set, while models whose capability table defaults to thinking (`defaultThinkingLevel`, `defaultReasoningEffort`) still spend that budget on reasoning; setting the option explicitly lifts the cap.
- Resource change entries diff `authoredView` (authored native source, images, kind, loading, related items—not regenerated projections) with content-aligned list items, omit empty net changes, and cap total diff text per response at `RESPONSE_DIFF_CHARS` (later diffs come back omitted for size).
- `location` is structured data localized on the client via `helperChangeLocationParts` and the section registry in `web/studio-sections.ts` (`contentSection` / `presetSection` pick the section whose `owns` matcher claims the path) (user-written names pass through; unknown paths show as identifiers; legacy Korean strings display as stored). Entries whose text was removed report `textRemoved` (`deleted` or `expired` per `HELPER_CHANGE_RETENTION`) without `location`, `diff`, or `anchor`.

Constraints on changing these routes:

- Record both outcomes and change entries inside the `operation` callback so they commit or roll back atomically with their mutation and receipt, preventing duplicate entries on replay.
- Route every helper save of a recorded domain through `withHelperChange` (scenes, scene titles, outline, notes, and `uimori apply`'s `store.editSource`), `recordHelperResourceChange` (via `applyHelperResourceMutation`), or `recordHelperAction` (called by `recordHelperTaskResult` for settings); never write `helper_changes` directly.
- The stored baseline is the full pre-change state restored by [turn rollback](#rolling-back-a-helper-task); deletion paths that remove a target must call the matching `forgetHelper*Changes` (see [Deletion, unused-data reclamation and helper cleanup](APP-INVARIANTS.md#deletion-unused-data-reclamation-and-helper-cleanup)).
- The results view never exposes resource bodies, pricing notes or source URLs, connection or credential data, request bodies, arbitrary tool arguments, or raw provider usage payloads.
- `kind=all` only lists; it creates and migrates nothing.

Outside these routes:

- A second undo history; turn rollback reads the same records, while editor resource undo and draft protection keep their own contracts.

## Rolling back a helper task

Restore ordering, stale-translation recovery, active-task refusal, status/reason codes, single-target rollback, asset cleanup, and seeded randomized multi-task rollback invariants are enforced by `tests/helper-rollback.test.ts`.

Semantics `HelperRollbackView` and `HelperRollbackUnit` leave out:

- One unit is one target (one resource, one scene's original and translation together, one chat's outline, or one chat's author notes); translations never roll back apart from their original, and `changeTargetIds` may cover a hidden translation record kept so a source-only edit can restore the translation it made stale.
- Covered domains are library resources, scene originals and translations, outline, author notes, and chat-only lore; scene titles, settings, card variables, story guide, illustrations, and queued requests return `not-covered` with `other-domain`, while task-created or task-deleted resources return `not-covered` with `created` or `deleted` (deletion clears the baseline so deleted resources cannot return).
- `changed-since` means the target differs from the state the task left (`changed-after-task`) or another save intervened between two task writes (`changed-during-task`). Whole-target comparison includes `contentPackageSettings` in full (while change entries show only owner-set lore mode and matching image-handoff ranges, and legacy card-only hashes also verify unchanged settings); outline and notes compare by content and tree position rather than IDs so earlier tasks remain rollbackable after later ones.
- A rolled-back unit stays `restored`: repeating the request (including after a lost response or subsequent edits) writes nothing again.
- `touches` lists write targets so the client can warn before overwriting unsaved drafts, which the server cannot see. Resource touches are not held back: a resource restore is a saved-revision write like a helper save, and the editor's conflict state keeps the draft (see [Editor context](#editor-context)). Scene, outline and notes touches still hold the unit while their editors are unsaved, because those editors were not part of the released rule.
- Scene restore saves original then translation via `editSource` and `editTranslation`; translation illustration placement is not restored (`translation-images-not-restored`).
- A chat-lore unit is one selector (`chatLoreKey`). `recordHelperChatLoreChange` stores the selector and the override entry active before the task (`ChatLoreBaseline`, `null` when none was), and the result hash covers only the active override value, so a library edit of the shared original does not block the rollback. The restore goes through `ChatOverridesStore.restore` and the same `write` transaction as the chat settings: it removes the override the task added, or reinstates a copy of the earlier entry with its original base, so an override whose shared original was deleted comes back with the same `entry-missing` conflict instead of failing a `patch` against a missing original. Records written before the selector was stored have no result hash and stay `recorded-before-rollback`. This is what lets `chat.lore` removal run without a confirmation.
- Recreated outline nodes and notes receive new IDs; restored notes carry author `도우미 변경 되돌리기`, restored imported memories keep the replaced note's origin, and outline restore is refused if a task-created node was edited since.
- Because outline saves validate parent-larger-than-child levels against the live tree, outline restore runs in three saves: (1) lift changed-parent/level nodes to top, remove added nodes, restore earlier levels; (2) recreate deleted nodes; (3) move nodes under their prior parents/positions and restore titles, intents, pins, and related nodes. Intermediate saves only alter plans whose final plan differs, preserving normal scheduled-scene cancellation semantics.

Constraints on changing this behavior:

- Restores must go through `saveResource`, `editSource`, `editTranslation`, `outline.applyReceipt`, and `notes.write` so revision checks, job invalidation, and events stay identical to normal saves; never write target tables directly.
- All selected units run in one transaction with per-unit savepoints (a failed unit reports `failed` cleanly while other units commit), and rollback fails with `HELPER_TASK_ACTIVE` while any task in the conversation is queued or running.
- Rollback is synchronous, short, and non-cancellable; a client that lost the response retries the same request safely.

### Review strip and what the next task learns

- Changes apply immediately; there is no pending-proposal state. The review strip (`useHelperRollback` with `review`) is the only prominent review surface and appears only on the conversation's latest task (`latestTaskId` in `HelperPanel`) once it has finished with a restorable or restored unit. "Keep" is implicit and stores nothing: when the next task's message appears, the strip leaves and older tasks keep the per-card icon actions. The strip is disabled while a task is queued or running, while a request is being sent (`busy`), and when the server reports `blocked: 'task-active'`.
- `helperRevertedChanges` orders rollbacks against task admissions by the shared helper event sequence. Both can have the same wall-clock timestamp. A retry or resume carries its failed attempt’s feedback forward and includes units first restored since that attempt.
- Declines stay browser-only state (`helperConfirmationDeclined`); the next new request sends the latest task's declined IDs as `declinedConfirmations` (at most `HELPER_DECLINED_CALLS_LIMIT`). `resolveHelperDeclines` keeps only IDs the latest task held, drops the arguments, and snapshots them as `declinedCalls`; a decline grants and revokes nothing. Retries inherit the retried task's list.
- Both lists reach the model through `HelperRuntime.request`, which feeds the HTTP loop and `nativeHelperRequest` alike, as `source.revertedChanges` (with `revertedChangesOmitted`) and `source.declinedCalls`; the contract line telling the model not to make them again is part of the stable `helperContract`. `tests/helper-rollback.test.ts` checks the once-only listing, the bound and Codex/HTTP equality; `tests/helper-confirmation.test.ts` checks declines.

## Plan mode

Read-only refusals, the reviewed read-operation set, task-list mode reporting, and reused request keys are enforced by `tests/helper-plan-mode.test.ts`.

- Requests with `mode: "plan"` store `mode` in the task snapshot and inject `PLAN_MODE_GUIDANCE`; `invokeOperation` refuses non-read-only operations (`helperToolTraits`) with `PLAN_MODE_READ_ONLY`, and `operation` refuses receipt writes as a backstop for saves that bypass the tool gate (such as `uimori apply` inside `data.exec`), guaranteeing zero recorded changes or rollbacks.
- Refusal uses the same `helperToolTraits` classification that governs receipts and change tracking so there is one list; discovery still lists write operations so a plan can name exact calls and arguments.
- Executing a plan is an ordinary follow-up request: the server keeps no link between plan and execution, and a retry preserves the retried task's mode.

## Confirmation before deletion or paid generation

Defaults, `helperConfirmPaidGeneration`, exact-argument single-use grants across restarts, latest-task scoping, argument release, and deletion cleanup are enforced by `tests/helper-confirmation.test.ts` and `HCONFIRM01` in `tests/helper-safety-browser.spec.ts`.

- Neither an HTTP provider loop nor a native Codex turn can pause mid-tool-call for user input: `helperConfirmationGate` refuses a held call with `CONFIRMATION_REQUIRED`, emits `confirmation.required` (surfaced as `HelperConfirmation`), lets the turn finish, and accepts `confirmations: [id]` on the next request (`confirmation.used`). Because all state lives in SQLite, reloads and restarts lose nothing and declining simply omits the grant; the next request reports the decline to the model ([review strip](#review-strip-and-what-the-next-task-learns)).
- A confirmation binds to the conversation, target chat, operation, and exact arguments (revision guards included); a grant is consumed at dispatch even if the save fails, a replayed call identity never consumes it twice, and the granted request carries `source.confirmedCalls` so the next task can repeat arguments verbatim.
- Only confirmations from the conversation's latest task can be granted (`CONFIRMATION_UNAVAILABLE` otherwise), retries keep their task's grants, and plan mode refuses grants (`HELPER_PLAN_CONFIRMATIONS`).
- The same call identity may be held again in a later task; each hold's `grantedBy` names only a subsequent task, and declines are keyed per task and confirmation.
- `helperConfirmationTrait`, exposed as `helperToolTraits(...).confirmation`, is the one classification of held calls: `delete` marks a deletion that turn rollback cannot undo and is always held; `paid` marks a call that starts paid generation and is held only with `helperConfirmPaidGeneration`, which is snapshotted at task admission like the timeout and cannot be changed by the helper's own `settings.update` or by the settings keys it adds. Argument-dependent refinements stay in `requirement`: `task.retry` is held only when `retriesPaidGeneration` says the retried task generates paid output (a run, an illustration, or a translation or image job; never a helper task, which no paid confirmation covers when it is first requested).
- Nothing is held only for its size: the owner released the earlier rule that held a `resource.patchMany` over three or more resources, because every resource it saves is its own restorable unit in the review strip. Stored `bulk` holds from before keep their card label so old task results still render.
- The trait lives in its own module because `helper-task-results` reads confirmations and `helper-app-tools` reaches `helper-task-results` through the settings tools; importing the trait from `helper-app-tools` made that cycle fail at module initialization.
- `tests/helper-confirmation.test.ts` requires every operation, or top-level `action` value, named `delete` or `remove` to carry the `delete` trait or an exemption with its reason, and every held operation to have a card label in `HELPER_CONFIRMATION_OPERATION_LABELS`. It exists because `illustration.cut.delete`, `font.delete` and `palette.delete` once shipped without confirmation.
- A hold records `count` for `illustration.generate` and, for targets the client cannot name (models, fonts, palettes), the title at hold time; titles are display text only and play no part in the grant identity.
- The results view never exposes held-call arguments. `releaseHelperConfirmationArguments` drops stored arguments from `confirmation.required` once a later task exists and from granted calls once completed or retried, while `forgetHelperConfirmationTargets` clears both on chat, scene, or resource deletion (including library holds targeting via `chatId`); argument-stripped holds show as expired and fail grant or retry with `CONFIRMATION_UNAVAILABLE`.

## Choice question cards and `@` target references

- `helper.ask` is a read-only tool available in both `apply` and `plan` modes. Like confirmations, it never blocks an open provider loop: it records a durable `question.asked` event returned as `question` on task results and ends the turn cleanly (`tests/helper-tool-contracts.test.ts`, `HELPASK01`).
- `@` target references (capped at `MAX_HELPER_REFERENCES`) store only `{ kind, id }` pointers in the task snapshot—never mutable titles or prose—and resolve live metadata on read and in `source.referencedTargets`, so deleted scenes and resources drop cleanly (`EHELP01`).

## Linux data workspace

Workspace layout, on-demand export/apply/refresh, CLI syntax, receipts, revision conflicts, unknown outcomes, and child-process termination are enforced by `INDEX.md`, `GUIDE.md`, `tools/repetition.py`, `tests/helper-shell-runtime.test.ts`, `tests/helper-runner.test.ts`, and `tests/helper-cli.test.ts`. Caller-visible workspace behavior lives in [Linux data workspace](../HELPER-TOOLS.md#linux-data-workspace).

Constraints on changing these operations:

- The runner's sole path to the app is the Unix sockets in the shared workspace volume; its `runner-egress` network holds neither the app nor the proxy ([저장과 운영](../SELF-HOST.md#저장과-운영)).
- The `uimori` CLI is a thin adapter to the `app.call` dispatcher with no storage code of its own, keeping task scope, editor-draft protection, revision checks, save effects, and operation identity identical.
- `uimori apply` adds no save path: resource files route through helper `resource.save` (preserving undo provenance and receipts), scene files route through source save and post-commit handling ([Editing saved scenes](#editing-saved-scenes)), and scene apply/refresh enforce current-chat ancestry checks.
- After an apply commits, a projection or reader-notification failure returns as a warning on the saved result, never a failed save.
- Exported translation copies use the Reader's completed-result projection (matching scene translation reads).
- The 24-hour `timeoutMs` maximum is a timer sanity cap only; task deadline and cancellation bound shell execution.
- Helper shell calls default to 64 KB output previews (`HELPER_SHELL_OUTPUT_DEFAULT_BYTES`, the runner maximum): with the earlier 16 KB default, 73 of 256 production shell calls truncated mid-output and caused follow-up rounds, and 54 of those 73 outputs fit in 64 KB (an extra round resends the full context and costs far more than the preview bytes). The main writing shell retains 16 KB because it has a tighter input budget and no comparable measurement.

Outside these operations:

- Background jobs (children are terminated via process group), draft merging (`uimori refresh` never merges or writes DB), and post-crash task-directory cleanup.

## Search and partial reads

Execution through the helper loop is enforced by `tests/helper-data-runtime.test.ts`; pagination continuations (`nextIndex`, `nextOffset`), local batch errors, and omitted exact totals live in [Pagination and results](TOOL-CONTRACTS.md#pagination-and-results). Caller-visible search fields, ordering, and page limits (`MAX_RESULT_CHARS`, `MAX_SEARCH_CHARS`, `FOLLOWING_ITEMS`) live in [Search and partial reads](../HELPER-TOOLS.md#search-and-partial-reads).

Constraints on changing these operations:

- Both `data.search` and `data.read` run in the isolated read-only data process ([Read-only SQL](#read-only-sql)).
- The `conversation` scope reads saved helper messages directly; do not maintain a second transcript.
- Search does not reproduce effective context; `knowledge.read` and `chat.lore` own that contract.

Outside these operations:

- The editor target ([Local recovery storage (IndexedDB)](APP-INVARIANTS.md#local-recovery-storage-indexeddb); context only, not a permission boundary per [도우미와 과거 가정 장면](../USAGE.md#도우미와-과거-가정-장면); the prompt library action **도우미에게 묻기** clears when opening an editor, leaving the library, or clearing the target).
- Reader selections (**도우미에게 물어보기** passes the whole passage as task `selection` and keeps it whole across later turns, `tests/helper-composer-browser.spec.ts`).

## Editor context

`EditorFocus` (`core/editor-focus.ts`) is the shape of where the user is in an open resource editor; `parseEditorFocus` is the request-boundary check (`helper-routes.ts`, `tests/editor-focus.test.ts`, `tests/helper-workspace.test.ts`) and the snapshot passes it unchanged as `source.editor.focus` beside `hasUnsavedInput`. User-facing behavior lives in [편집기에서 도우미에게 묻기](../EDITING.md#편집기에서-도우미에게-묻기).

- One publisher: `web/resource-editor.tsx` builds the focus per editor session from the studio location (`usePublishedEditorLocation`, including `unsavedSections`), the last focused code field's report (`usePublishedEditorField`) and an explicit ask (`useEditorHelperAsk`, the `editor.askHelper` shortcut) that pins the focus until the next field report or a move to another item. `captureActiveEditorContext` adds it to the editor reference the helper composer already sends; there is no second channel. Code fields report on focus, selection and analysis changes after a short debounce, and an ask flushes a pending report first so the shortcut never sends a stale field.
- Offsets, lines and columns are in the field's LF text, the same text `analyzeCbs` reads; diagnostics are the CBS analysis the field already computed (Lua fields and the plain textarea fallback send none). Only the selection carries text, bounded by `EDITOR_FOCUS_SELECTION_MAX_CHARS`; the field's full draft travels in `editor.model` only when the editor is unsaved, as before.
- The focus is context, not a permission boundary or a write target: saves go through `resource.patch` and its revision checks against the saved revision.
- An unsaved draft does not block writes to its resource (the owner released the earlier `EDITOR_SAVE_REQUIRED` refusal). No operation saves the draft, so every write targets the saved revision, and the guards that keep both sides are the ones the editor already has: a helper save moves the saved revision, `ResourceEditorSession.refresh` (run on the `resource.updated` helper frame) marks the dirty session `conflict` instead of adopting it, and a later editor save is refused until the user reviews the saved version (`requestResourceConflictReview`); an editor save that lands first makes the helper's `expectedRevision` stale (`SOURCE_CONFLICT`). The draft in `editor.model` and `data.search scope=editor` carries no `editTarget`, and `helperContract` and the `editor.read` description send the helper to saved reads for revisions, paths and replaced text, because array indexes and text in the draft can differ. `seededHelperOperations` still seeds only `editor.read` for an unsaved editor: also seeding `resource.read` raised the first request of a short editor question from under 4,000 tokens to 4,237 tokens (measured with a fixture case that has since been removed), and `resource.patch` as well to 5,029, while a task that does edit pays one `app.tools` lookup. Evidence: the `a helper save under an unsaved editor draft overwrites neither side` tests in `tests/helper-workspace.test.ts`, the dirty-refresh case in `tests/resource-editor-session.test.ts`, and `EHELP09` and `HROLLBACK03`.
- The composer chip is removable; removal drops the focus from requests until the focus key (`editorFocusKey`) changes. Suggested requests (`web/editor-helper.ts`) only fill the composer, like the empty-conversation starters.

## Editing saved scenes

Error codes and all-or-nothing saves through the helper runtime are enforced by `tests/helper-scene-runtime.test.ts`. Caller-visible behavior lives in [Editing saved scenes](../HELPER-TOOLS.md#editing-saved-scenes).

Constraints on changing these operations:

- Saving an original runs `compileEditedSourceText` so `<a2ui>` blocks compile before storage; receipt `expectedTextHash` hashes the stored text and `storyUiFailures` reports blocks saved verbatim after compilation failure. `scene.restore` passes stored fences through unchanged and rollback never compiles.
- Regex `scene.search` runs in the isolated read-only data process and is advisory only; `scene.patch` re-verifies the live guarded text before saving.
- Scene tools add no save path: existing source and translation saves own revision checks, preservation, job invalidation, illustration placement, and shared post-commit cancellation of superseded jobs and reader notifications.
- A source edit invalidates old translation jobs while leaving saved execution inputs untouched; summary usability relies on existing source-hash checks (scene edits never author replacement summaries), and search sends neither a search index nor full scene bodies.

Outside these operations:

- Co-saving `translation` keeps that reviewed translation current without guaranteeing semantic safety for arbitrary source edits; task-pinned older text is not an editing archive; automatic retranslation, scene titles, persistent writing options, and unsaved Reader drafts stay outside ([도우미 본문 편집](../EDITING.md#도우미-본문-편집)).

## Read-only SQL

The `db.query` description lists the view columns so the model needs no schema round, and `tests/helper-data-tools.test.ts` checks that list against the live views; calling it without `sql` also returns examples and path guidance, so this document does not duplicate them. Concurrent read ordering and cancellation draining are enforced by `tests/helper-data-runtime.test.ts`.

Behavior the description leaves out:

- A query naming `sqlite_master`, `sqlite_schema`, or `PRAGMA` returns the view schema instead of an authorization error: production tasks burned whole rounds trying those before calling schema-less `db.query`, and underlying tables remain unreadable.
- `agent_messages.request` holds the scene run's stored request or edited request text, and is `NULL` when the request is disabled for that scene; it does not reflect later native-script projections.
- Row sets also cap at `MAX_RESULT_CHARS` (`truncated` can be true below the row limit); integers outside JavaScript's safe range serialize as decimal strings, and binary values return as byte counts without bytes.

Constraints on changing these operations:

- `data.search`, `data.read`, `db.query`, and regex `scene.search` each run in a short-lived read-only child process with bounded memory, a 3-second deadline, and kill-on-cancel so pathological SQL or regex never blocks the server event loop. Do not move this work into the server process or add persistent mirrors, pools, schedulers, migrations, settings, or dependencies; task-local files belong in [Linux data workspace](#linux-data-workspace).
- The server supplies the database path internally (never a tool argument), and `db.query` never writes.
- Adjacent read-only calls (`helperToolTraits(...).readOnly`) in one HTTP provider response execute concurrently up to `Math.min(4, availableParallelism())`, with results returned in call order; a write, and each read in `SEQUENTIAL_READS`, is a sequential boundary so no read passes an app mutation ([Execution boundaries](TOOL-CONTRACTS.md#execution-boundaries)). `SEQUENTIAL_READS` keeps out `data.exec` (it can apply saves), `helper.ask` (it ends the turn), `web.search` (a billed model call checked against the call budget before it runs) and the three image reads (each decodes and resizes a picture in memory). Synchronous operations gain no parallelism from the group; it lets them run while a worker-backed read waits. This cap is a small heuristic, not tuned to container memory.

Outside these operations:

- Native Codex tool callbacks stay serialized; concurrent read grouping applies only to the HTTP provider loop.

## Discovering and executing app operations

Discovery, patch atomicity and failure details, all-or-nothing saves, receipts, cloning, and compaction fidelity are enforced by `tests/helper-discovery.test.ts`, `tests/helper-resource-editing.test.ts`, `tests/helper-tool-contracts.test.ts`, `tests/resource-clone.test.ts`, and `tests/helper-compaction.test.ts`. Caller-visible behavior lives in [Discovering and executing app operations](../HELPER-TOOLS.md#discovering-and-executing-app-operations), outline tools in [도우미 도구 계약](../OUTLINE.md#도우미-도구-계약-outlineread-outlinewrite), and theme tools in [도우미 도구 호출 계약](../THEME-AUTHORING.md#도우미-도구-호출-계약).

Key semantics and deliberate design rules:

- An explicit `chatId` scopes that single call without altering the conversation's default scope; operations in `helperToolTraits`'s `writing` set prepare an on-demand writing snapshot of that chat, while calls without `chatId` keep the task's original reservation.
- A `target` is the item's indexed path at the read revision, not a persistent ID across revisions.
- `preset.validate` does not lint CBS via the pinned RisuAI evaluator because that evaluator tolerates incomplete tags, reparses dynamic expressions, and can mutate variables; toggle reconciliation retains still-valid choice indices even when reordering changed their meaning (`preset.validate` reports changes against the single retained previous save).
- `source.knownOperations` (`knownHelperOperations`, bounded by `HELPER_KNOWN_OPERATION_LIMIT` and `HELPER_KNOWN_OPERATION_MAX_TOKENS`, measured in tokens like the input budget it is capped by) carries live-build definitions first for the operations `seededHelperOperations` picks from the task's selection, editor target, outline target and `@` references (stored as `seededOperations` at admission, without write operations in plan or review mode), then for operations called in earlier tasks of the conversation (from `tool.started` events, which survive input cleanup), filtered by review allowlist and excluding looked-up-but-uncalled tools. Both inputs are fixed before the task's first request, so the request data stays identical across rounds, restarts and continuations, and the tool list and stable prefix stay unchanged (`tests/helper-round-trips.test.ts`).
- `helperContract` builds the stable contract from the conversation scope (chat or library) and whether the shell tool is offered; both are fixed for every task of a conversation on one server, so tasks of a conversation share one contract prefix. Facts that vary between tasks, such as whether a chat has notes or the original-work reference is on, stay out of it; per-task additions (continuation, outline, plan mode, persona) are appended after it as before.
- `source.writing.chat` (`helperChatOrientation`) and `source.selection.editTarget` are computed at admission and stored in the task snapshot (`orientation`, `selectionTarget`), so every round, a server restart and a resumed continuation send the same source. They hold revisions, hashes and settings but no scene titles, because task snapshots keep only pointers to scenes the user can delete ([`@` target references](#choice-question-cards-and--target-references)). A retry is a new task and computes them afresh, unlike `revertedChanges`, which is copied.
- `story.search` and `story.read` are left out of discovery outside an outline review (`APPLY_APP_TOOLS`): they number the frozen history including hidden scenes, while `chat.read` numbers only visible ones. They stay dispatchable, so a schema an earlier task saw still runs. The helper-facing wording of `knowledge.*` and `skills.*` is rewritten by `HELPER_WRITING_READ_TOOLS` because the helper receives no catalog; the writer's own descriptions in `core/read-tools.ts` are unchanged, and a stale replacement fails at module load.

Constraints on changing these operations:

- `helperToolTraits` is the single policy for read/write classification, outline-review allowlist, [plan mode](#plan-mode) refusal, and `writing` snapshot needs; metadata reads, renames, lore operations, and outline navigation stay out of `writing` so explicit `chatId` calls avoid unused snapshots.
- Each resource operation definition declares read/mutate and target resources once (stripped from the model schema) to drive draft protection, receipts, undo tracking, and update events; never add a second target list.
- Resource operations add no save path: `saveResource` owns revision checks, validation, projection regeneration, and single retained undo, and `resource.clone` shares `cloneResource` with HTTP/UI cloning ([Concurrency control and idempotency guarantees](APP-INVARIANTS.md#concurrency-control-and-idempotency-guarantees)).
- `data.search`/`data.read` `editTarget` hints and `resource.patch` validation share `server/helper-native-protected-fields.json` and `server/helper-resource-path-policy.json`; update them together, noting limits apply to full editing paths including the native-content prefix.
- Model arguments never carry mutation identity (derived by the host from task + provider call ID; new call ID = new operation). Authorization and final reply shape live once in `helperContract`, not per operation ([Mutations](TOOL-CONTRACTS.md#mutations), [Names, descriptions and parameters](TOOL-CONTRACTS.md#names-descriptions-and-parameters)), and the provider tool list stays fixed across continuations ([Provider continuation state](TOOL-CONTRACTS.md#provider-continuation-state)).
- Native tool history preserves the provider's `app.call` envelope while classification, compaction, and activity inspect the inner operation.
- `HELPER_READ_TOO_LARGE` withholds (never truncates) only reads exceeding the model's input budget; there is no fixed per-read or per-round token cap (accumulated reads go through compaction), and confirmed write results are never replaced.
- Composer recovery (`tests/helper-recovery-browser.spec.ts`, [Local recovery storage (IndexedDB)](APP-INVARIANTS.md#local-recovery-storage-indexeddb)): a read failure is not an empty store and never overwrites drafts/selections/unacknowledged requests; an accepted request clears only if the stored value still matches, and post-acceptance cleanup/refresh failures are not failed sends. Creation, copy, and project flows share pending-request handling ([Creating a new helper session](#creating-a-new-helper-session)).

Outside these operations:

- Complete models (bounded pages/receipts apply to helper calls only), arbitrary object/root `resource.patch`, multi-version resource history ([Helper partial edits and string replacement algorithm](APP-INVARIANTS.md#helper-partial-edits-and-string-replacement-algorithm)), automatic resend after reload, new device-local artifact drafts, and independent-scene generation/editing (there is deliberately no `artifact.generate` operation and no `PATCH /api/helper/artifacts/:id` route; `artifact.read` and `GET /api/helper/artifacts/:id?revision=N` are read-only, while branching uses `chat.fork` + `scene.request`).

## Creating a new helper session

Storage precedence, retry-key reuse, cross-tab isolation, and no-send after reload or storage failure across session creation, conversation copy, and project creation are enforced by `tests/helper-sessions-browser.spec.ts` and `tests/helper-workspace-browser.spec.ts`.

- Definite rejections (4xx other than 408 or 429) clear a first-sent pending request; a request re-sent after recovery is retained even on rejection and removed only on success.
- Other drafts or settings are never evicted to make room for a pending request.
- A request stored only in `sessionStorage` may not survive closing the tab.

## Helper conversations and past forks

User-facing behavior lives in [Helper and past what-if scenes](../USAGE.md#도우미와-과거-가정-장면). `helper_seed_messages` is shared by past-forked conversations and **대화 복사** (`copy` in the helper workspace).

- Seed messages store only role, text, and attachments; earlier model attempts, usage, tool executions, and change receipts are neither copied nor re-executed, and follow-up tasks read current saved resource state freshly.

## Activity and additions to a running task

Addition delivery (**현재 작업에 추가**, `steer`), call limits (`HELPER_TASK_LIMITS`, `HELPER_TOOL_CALL_LIMIT`), and bounded activity projections are enforced by `tests/helper-workspace.test.ts` and `tests/helper-flow-browser.spec.ts` (limit values summarized in [실행 한도와 주요 정책 요약](../CODEX.md#실행-한도와-주요-정책-요약)).

Recorded state semantics:

- A `delivered` addition confirms placement into execution input only—not that the model followed it.
- Call limits are observable host boundaries on model requests and tool callbacks, not money caps or native Codex internal sampling counters; activity explains execution, not answer quality.

Constraints on changing this behavior:

- Additions are text-only (preserving model, captured materials, and read-only review mode); on HTTP providers they skip unstarted calls without interrupting a running tool; pending/unconfirmed additions are never replayed automatically or on retry, while unchanged retries carry delivered additions.
- Call limits and timeout (`DEFAULT_HELPER_TASK_TIMEOUT_MINUTES`) are internal policies snapshotted at admission, with the deadline timed from execution start.
- The helper run loop retries HTTP 429 and 5xx failures using `HELPER_PROVIDER_RETRY_DELAYS_MS`: because helper tasks make many calls, one transient 429 previously killed a production task on its sixteenth call. The retry stays in the helper loop rather than shared transport so main and translation runs still fail fast; it applies only to pre-output HTTP status failures, skips native Codex turns (tools already ran) and summary calls ([CONTEXT-LIMITS](../CONTEXT-LIMITS.md)), and counts every attempt toward `totalCalls` without consuming `helperCalls`.
- Stopped tasks continue via a retry carrying `resume` (`tests/helper-workspace.test.ts`, `tests/helper-compaction.test.ts`): tool exchanges rebuild solely from existing `tool.finished` events and attempt responses (no second manuscript copy to clean up; retention/deletion cleanly ends resumability). Pre-compaction exchanges keep only non-read events and read references, while remaining exchanges pass as `completedToolHistory` reference data in a fresh request (allowing another model and subsequent compaction). `retryOf` chains preserve change counts and block start-from-scratch retries across the whole chain so earlier changes cannot repeat.
- Refused HTTP calls retry immediately up to the app-wide automatic refusal retry count ([GENERATION](../GENERATION.md#거절-뒤-자동-다시-생성)), read on arrival and reset per call; chat overrides do not apply (chat generation settings never govern helpers), no refusal judgment runs on helper output, and native Codex turns are not repeated.
- Exhausted refusals fail with `HELPER_RESPONSE_REFUSED` plus any structured provider reason code (e.g. `SAFETY`), never storing prose refusal text as a host error; deadline stops fail with `HELPER_TASK_TIMEOUT`, keeping `cancelled` strictly for user-initiated stops (`tests/helper-workspace.test.ts`).

## Original-work reference and authored notes

[Original-work reference](../STORY-GUIDE.md) owns **원작 참고** settings, the pre-writing step, and the deliberate absence of dedicated question or preview endpoints. The helper reads settings via `storyGuide:{revision,config}` in `context.read`.

- `context.read` returns settings, never a generated brief; prior briefs are not a source of story facts, and neither helper answers nor automatic briefs create a branch ledger.
- **Risu 작가 노트** is neither an event log nor proof of character knowledge ([이야기 기억과 컨텍스트·메모](../USAGE.md#이야기-기억과-컨텍스트메모)).

## Risu code checks

Findings, positions, bounds, compile-only Lua and constant-derived compatibility rules are enforced by `tests/helper-code-tools.test.ts`. Caller-visible limits live in [Risu code checks](../HELPER-TOOLS.md#risu-code-checks).

Constraints on changing these operations:

- They add no evaluation or analysis path. `code.cbs` and the cbs section use `analyzeCbs` with `nativeRisuCbsFunctionCatalog`; `code.references` uses `indexCbsReferences` over the same reference input as the editors; `code.regex` runs `processNativeRisuText` with `trace`, which records each changing step without altering processing; `code.preview` calls `nativeRisuStartPreview` or `nativeRisuDraftPreview` with `toggleValues`, which only replaces the toggle defaults the preview already passes as `globalVariables`.
- Every compatibility rule reads the constant or function that the runtime or importer enforces: `RISU_NATIVE_LUA_UNSUPPORTED_FUNCTIONS`, `RISU_NATIVE_LUA_FUNCTIONS` and `RISU_NATIVE_LUA_MODEL_FUNCTIONS` (`server/risu-native-lua.ts`; the first two are parsed from `RISU_NATIVE_LUA_PRELUDE`, the inventory `scripts/risu-lua-diff.mjs` also reads, which is why the prelude stays a static `String.raw` template), the trigger constants and `mixesNativeRisuLua` in `server/risu-native-runtime.ts`, `NATIVE_RISU_REGEX_MODES` and `nativeRisuRegexPlan` in `server/risu-native-render.ts`, `NATIVE_RISU_PRESET_BLOCKS` and `NATIVE_RISU_PRESET_SKIPPED_BLOCKS` in `core/risu-native-preset.ts`, `RISU_PRESET_IGNORED_SETTINGS` in `server/risu-preset-program.ts` and `nativeLoreDecoratorReport` shared with the lore import. A new rule is exported from its owning module and used there; `server/risu-code-diagnosis.ts` never keeps a second list.
- The Lua syntax check runs a compile-only program through `runNativeRisuLua`, so the worker's memory, time and source limits apply; each chunk is loaded with an empty environment, never called, and the host rejects every call.
- Deprecated fields are deliberately not reported: the content projection (`normalizeRisuContentSource`) and preset validation and storage (`stripDeprecatedRisuPresetFields`) remove them before a resource is stored, so such a finding could never appear.
- `CBS-REFERENCE` is a virtual guide generated from `nativeRisuCbsFunctionCatalog` rather than a committed document, so the descriptions that ship with the vendored GPL evaluator stay out of the repository's documents and only the existing adapter imports `third_party/risuai/`.

## App guides

Listing, search, paging, and virtual-guide sizing are enforced by `tests/app-guides.test.ts`.

- Guides are the Markdown files directly under `docs/`, packaged into `dist/docs` on build (read from `docs/` in source mode); they are never copied into the shell workspace (`uimori call guide.read` reads them).
- Guides mix Korean prose and English identifiers, so search matches by section with partial-word fallback and attaches guidance that empty/partial results never prove a feature is absent; there is intentionally no translation or synonym table.
- Developer documents live under `docs/dev/` and are excluded from `dist/docs` and `guide.read`; any Markdown file placed directly under `docs/` becomes a user guide.
- Virtual guide `CBS-REFERENCE` may span several pages; see [Risu code checks](#risu-code-checks).
- Virtual guide `STORY-UI-REFERENCE` (`storyUiPrompt()`) stays out of `helperContract` because it is several times larger and needed only for Story UI work; it must fit within `MAX_PAGE_CHARS` for one `guide.read` call (`tests/app-guides.test.ts`).
- `helperContract` instructs the helper to check guides before saying a feature is absent because a production helper once claimed thought summaries did not exist (UI-only behavior with no tool or setting).

## Web search and model pricing

Protocol search selection is owned by `helperWebSearchCapability`, pricing rules by [비용 계산과 단가 관리](../USAGE-REPORT.md#비용-계산과-단가-관리) and [모델 요금과 추정 비용](../MODEL-PRICING.md), and Codex search modes by [실행 한도와 주요 정책 요약](../CODEX.md#실행-한도와-주요-정책-요약).

- `source.currentDateUtc` is the UTC date the task was created, not the date of each model request. `source.usageDate` comes from `usageReportDate`, which shares its offset and time-zone name with `usageReport`, so the helper's "today" and the report's calendar cannot drift apart.
- An adapter without search support reports search as unavailable without falling back to another service.
- Gemini 4 helpers on Google AI Studio and Vertex expose `web.search` as a read-only provider-facing tool: each call executes a separately billed search-only `generateContent` request to the **same configured Gemini model and connection** while keeping `webSearch` off on the main tool-bearing helper call. This avoids the `generateContent` restriction against combining `googleSearch` with function declarations (unlike the Gemini Interactions API; Google Cloud grounding docs checked 2026-11-23: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search). Non-Gemini-4 models keep prior behavior. The call checks the task's model-call budget, records normal attempt accounting, sends only the search query (never conversation or library data), and is available during read-only review.
- Grounded `searchEntryPoint` markup is neither stored nor displayed; only verified source URLs reach the helper and the user. The Vertex pricing page (https://cloud.google.com/model-garden/pricing, read 2026-11-25) lets a customer below one million grounded prompts a day choose not to display Search Suggestions at standard pricing; the same exemption was not confirmed for Google AI Studio keys. Missing search or sources must never be presented as grounded evidence; synthetic adapter tests do not prove live model/account availability or billing.
- `vertex.location.compare` must stay on the shared connection test runner so comparisons record like response tests and replayed operations send nothing new.
- Outside these operations: search-tool fees may be absent from token-rate estimates ([Usage report and backfill](APP-INVARIANTS.md#usage-report-and-backfill)), and the original-work reference step uses its own `storyGuideWebSearchCapability` ([Original-work reference](../STORY-GUIDE.md)).

## Requesting the next scene or a translation

- `scene.request` builds its run via `composerRunSnapshot` and reserves it through `store.createRunInTransaction`, and `scene.translate` delegates to `requestTranslation`; neither adds a parallel path.
- Reservation, helper receipt, and result target commit in one transaction with the run's idempotency key derived from the receipt; execution starts strictly post-commit and only when this call created it, so a replayed receipt never executes twice.
- A chat with a queued or running run returns `SCENE_REQUEST_BUSY` before conflict checks.
- With `helperConfirmPaidGeneration` enabled, both operations require [confirmation](#confirmation-before-deletion-or-paid-generation); reference images and lore-selection reset remain composer-only.

## Next request preview, scene lore and card variables

Caller-visible paging, placeholders, and guard behavior live in [Next request preview, scene lore and card variables](../HELPER-TOOLS.md#next-request-preview-scene-lore-and-chat-variables) and [다음 요청 미리보기](../CONTEXT-LIMITS.md#다음-요청-미리보기).

- Zero duplicate computation: `chat.preview` calls `inspectNextRequest`, `scene.lore` calls `sceneRequestLore`, and `chat.variables.read` calls `chatVariableView`.
- `chat.variables.update` writes via `writeChatVariables` inside the helper operation transaction (keeping revision, source-hash, busy-chat, and journal checks with a receipt-derived journal key).
- Preparation errors stay bounded to `PREVIEW_UNAVAILABLE` so author-controlled compilation errors never leak source text.

## Fixed options, scene names, original-work reference and model parameters

Contracts for `options.fix`, `scene.title`, `chat.guide.update`, and `model.parameters.read/update` are enforced by `tests/helper-chat-settings-tools.test.ts` (user docs: [장면 이름과 목차 관리](../READING-STATE.md#장면-이름과-목차-관리), [Original-work reference](../STORY-GUIDE.md), [저장과 실행](../MODEL-PARAMETERS.md#저장과-실행)).

- Each operation delegates to the UI's existing save function without adding a parallel path: `ChatOptionsStore.fixed`, `setSceneTitle`, `storyGuide.update`, and `prepareModel`.
- `chat.guide.update` validates the merged configuration before saving so invalid values return `STORY_GUIDE_INVALID` rather than an unknown write outcome.
- `model.parameters.update` rebuilds the full saved model input from `SAVED_MODEL_KEYS` before calling `prepareModel`; any saved model field omitted from `SAVED_MODEL_KEYS` is dropped on update.
- Recorded `setting` keys (`chat.options`, `chat.storyGuide`, `model.parameters`) determine which settings view opens from the result card (`openHelperChange`).
- Connections, credentials, execution mode, service tier, and cache options stay outside `model.parameters.update`.

## Model registration, chat profile, scene context, bookmarks and chat folders

Contracts are enforced by `tests/helper-settings-tools.test.ts` and `tests/helper-chat-settings-tools.test.ts`.

- Each operation delegates to the save function the UI uses: `product.model` (`model.register`), `deleteLibraryItem` (`model.delete`), `product.updateProfile` (`chat.profile.update`), `updateSceneContext` (`scene.context.update`), `addBookmark`/`updateBookmark` (`chat.bookmark`), the `ChatOrganizationStore` methods (`chat.organize`), `selectIllustrationPreset` (`illustration-preset.select`), and `applyWorkspacePromptPreset`, `saveAutoTranslationDefaults`, `saveChatGenerationDefaults` and `updateLoreContextDefaults` for the added `settings.update` keys.
- `model.register` takes only connection, provider model id, title and maximum output. Execution mode, provider options, enablement and pricing stay in the model editor and in `model.parameters.update`/`model.pricing.update`.
- `model.delete` refuses while `managementImpact` reports a global role, an advisor or a pinned chat. `deleteLibraryItem` clears the main, translation and title choices, turns collaboration off, and deliberately leaves the helper, context and script choices pointing at the unavailable model so those calls fail instead of falling back to the main model (`tests/risu-native-model-selection.test.ts`); the helper must not cause any of that as a side effect of a delete request.
- The Risu author note, a scene request text and a bookmark's title and note are owner-written prose outside turn rollback. Their changes go through `recordHelperAction` with the previous value, and the diff is computed from the stored baseline so a second edit in the same task still shows the text before the task; a scene request change also stores its `sourceId` so `forgetHelperSceneChanges` redacts it with the scene. The result target uses kind `chat` or `scene` so `recordHelperTaskResult` does not record a second, value-less entry for the same target.
- `modelInUse` is shared by `model.delete` and the confirmation gate, so a model that would be refused is not held first and does not spend a grant.
- `chat.organize` is `direct`: its `chatId` names the chat to move, not a scope to retarget the call to.
- Workspace settings are built host-side from an enumerated key, never from a model-supplied object, so the helper cannot reach `helperConfirmPaidGeneration` or the task timeout stored in the same workspace.

## Creating and deleting chats, and option presets

Contracts are enforced by `tests/helper-chat-lifecycle-tools.test.ts`.

- `chat.create` adds no creation path: it calls `createChat` (`server/chat-creation.ts`, also behind `POST /api/chats`) and then `createPackageStart`, the same pair the risu import uses and the new chat screen reaches through its pending profile. `store.createChat` already attaches the bot and the default or chosen persona, so the helper skips the profile save the screen makes for modules; attaching modules is `chat.profile.update` afterwards. The default opening (`start-0`, or the only start) and the bot-title placeholder with automatic retitling stand in for choices the screen makes in the browser. The chat is created in the operation transaction; title enrolment (`chatCreated`) and an opening run that is queued (`story.started`) happen after commit and only when this call created the chat, so a replayed receipt neither enrols nor starts twice. The helper never navigates: the result target of kind `chat` is what lets the user open it.
- `chat.delete` calls `deleteChat`, the permanent deletion behind the chat list, and the app's `onChatDeleted` effects through `chatDeleted`. The chat list deletes without undo after a confirmation dialog, so the operation keeps the `delete` trait and its hold names the chat. Deleting the chat of the calling conversation is refused before any hold (`CURRENT_CHAT_DELETION`): `helper_conversations.chat_id` cascades, so the deletion would remove the conversation and the running task with it, and `assertChatIdleForDeletion` would refuse it anyway while the task runs.
- `prompt.combination.*` call `ProductStore.promptCombination`, `updatePromptCombination` (`PUT /api/prompt-combinations/:id`), `deleteLibraryItem` and `applyPromptCombination` (`POST /api/prompt-workspace/apply-options`). Applying a preset to one chat, as the composer does, is `options.fix` with the preset's values, so there is no second chat path. Deletion keeps the `delete` trait because the settings screen deletes without undo. Results are `settings` targets named by the operation, so they open the prompt settings.

## Settings, diagnostics and task control

- After `settings.update` commits, the helper publishes `settings.updated` on its own conversation so the browser refreshes open settings even from a library helper with no selected chat.
- Tool diagnostic timings: `elapsedMs` spans dispatch and result preparation (including worker/provider wait, excluding sibling-read wait), and `queueMs` measures native Codex pre-dispatch wait behind the previous call; overlapping calls mean summed times are not wall time.
- A no-op save can still write a receipt and appear in `committedEffects`.
- `settings.update` delegates to the existing settings services and `usage.read` delegates to the shared usage report projection ([작업실 사용량](../USAGE-REPORT.md)) without parallel paths or accounting rules.
- `helper_operations` is the sole evidence that a helper save committed, attributed strictly by host call identity—never inferred from `tool.finished`, tool name, or result body. `receiptId` identifies an existing record and is never an idempotency key for submitting another write.
- `task.cancel` and `task.retry` invoke the app's existing task-control transitions; `canCancel`, `canRetry`, and `retryBlock` are advisory and never replace service eligibility checks (including refusing retry when a helper task has committed effects).
- A task state transition and the calling helper's receipt commit in one transaction; controller aborts, event publishing, and worker startup occur strictly post-commit.
- Unsaved settings/drafts keep their conflict rules; diagnostic scope and retention live in [Execution diagnostics and retention](#execution-diagnostics-and-retention).

## Accounting and summary preparation

Exact recent-turn retention, checkpoint invalidation on retry, lazy snapshot loading, single attempt-completion counting, and paused reads in hidden views are enforced by `tests/helper-compaction.test.ts` and `tests/helper-data-runtime.test.ts`. Related specs: [재사용·실패·복원](../CONTEXT-LIMITS.md#재사용실패복원), [수동 정리와 요약 편집](../CONTEXT-LIMITS.md#수동-정리와-요약-편집), [도우미 기록과 화면 전환](../EXECUTION.md#도우미-기록과-화면-전환), [문제 확인과 실행 상세](../DIAGNOSTICS.md), [App Server communication and turn lifecycle](PROVIDERS-AND-CODEX.md#app-server-communication-and-turn-lifecycle), and [Evidence and metrics](HELPER-EVALUATION.md#evidence-and-metrics).

- Host compaction triggers only under context pressure (`HELPER_COMPACTION_INPUT_RATIO`) to preserve exact evidence as long as it fits—never earlier for model size, cost, or repeated reads, and with no claim about provider cost or cache reuse.
- Component estimates in `input.measured` are serialized separately for diagnosis and need not sum to the encoded request estimate.
- `originalResultChars` and `providedResultChars` measure serialized JSON at the helper boundary, not source resource sizes or full shell output.
- `elapsedMs` on `attempt.finished` spans the host provider request (neither first-token latency nor an internal Codex call); streaming calls record `firstByteMs` and `firstTextMs` separately on the execution diagnostic.
- Local input estimates cover what Uimori sends; a native Codex turn adds its own tool descriptions and runtime context, so provider-reported input can exceed the local estimate.
- Native Codex tool callbacks go through the exact same dispatcher (result limits, revision checks, receipts) as HTTP providers; Codex has no separate tool path.

## Goal evaluation

[Helper goal evaluation](HELPER-EVALUATION.md) owns evaluation cases, pre-fixed oracles, and what scripted provider checks do and do not establish about a real model.

### Illustration presets

`illustration-preset.list` and `illustration-preset.guide` inspect presets, while reads, saves, undo, and deletion use `resource.*` (`kind: illustration-preset`) with no separate save path; `tests/helper-tool-contracts.test.ts` checks that helper saves neither select a preset nor generate an image ([삽화 프리셋](../ILLUSTRATIONS.md#삽화-프리셋)).

### Bounded composition reads

Page budgets, view-scoped change detection, writing references, compact write receipts, and post-compaction read-metadata retention are enforced by `tests/helper-outline.test.ts` and `tests/helper-compaction.test.ts` (modes and fields in [도우미 도구 계약](../OUTLINE.md#도우미-도구-계약-outlineread-outlinewrite)).

- A writing whose scene is absent from the chat's current history returns as unavailable without a reference and is never rematched to another scene.
- When an `outline.read` result exceeds the model's input budget, `nextRead` requests the same range with a smaller `limit` rather than falling back to library search.
- Bounded pages apply to helper views only (the browser outline API keeps its full tree); `coverage.wholeField` applies to intent reads only (distinct from search `complete`) and never certifies a complete review.
- `knowledge.search` with `mode: browse` runs through `app.tools`/`app.call` including during read-only review ([Folder navigation](TOOL-CONTRACTS.md#folder-navigation)).

### Token budgets and isolated read processes

Unit rules live in [Units and model-facing budgets](TOOL-CONTRACTS.md#units-and-model-facing-budgets).

- A continuation of a limit-less page read carries no limit so one page's measured length never freezes into a character default.
- The isolated data, SQL, and regex worker enforces character pages, memory/time limits, and IPC size guards without tokenizing; the host applies token budgets to its output.
- Shell command/output byte limits and exact mutation receipts stay separate from these token budgets.

## Helper attachments

Supported formats, size caps, and image-tool sizing live in [도우미 첨부](../HELPER-ATTACHMENTS.md) and [Stored content images](../HELPER-TOOLS.md#stored-content-images).

- Only explicitly attached file references convert into transmitted bytes; strings resembling file references inside ordinary prose or tool output never grant read access.
- Image tools register only image references whose ownership the server verified, and downloads serve as attachment responses from authenticated app routes.
- Composer and helper attachment drafts share one IndexedDB store recovered with draft generation ([Local recovery storage (IndexedDB)](APP-INVARIANTS.md#local-recovery-storage-indexeddb)).

## Execution diagnostics and retention

User- and helper-facing diagnostic field explanations live in [진단 기록과 해석](../DIAGNOSTICS.md#진단-기록과-해석); this section records the persistence, timing, and cleanup invariants.

- **Execution data lifecycle**: Full request inputs and tool results exist during execution and are pruned on success to compact summaries; originals, notes, variables, Lua message changes, and current lore stay separate because later turns depend on them ([Execution input lifetime](../EXECUTION.md)).
- **`attempts` ledger**: All model roles share this ledger (including `codex-content-preflight`, input translation, and selection revision, none of which retain originals or unsaved drafts). Exception-terminated attempts close with an unknown outcome and never auto-resend. Streaming calls record `firstByteMs`, `firstTextMs`, `firstThoughtMs`, stream length, and request/response bytes without estimating unobservable paths (Codex, Anthropic Batch, non-streaming responses, Vertex search first text); inter-call gaps are never stored and are computed from timestamps by `scripts/perf-ledger.mjs`.
- **`runs.snapshot.phaseSpans`**: Written once when a main run ends (failed/cancelled runs keep reached phases). `advisorPrep` and `preflightTokenize` are measured inside `mainModel`, so spans do not sum to total elapsed time (`preflightTokenize` covers main-call request sizing only; transport budget checks belong inside `mainModel`). Judgment-only recovery overwrites only the phases it executed.
- **Tool diagnostics (`execution_tool_diagnostics` vs `helper_events`)**: Main, advisor, story-guide, translation, and illustration tool diagnostics live in `execution_tool_diagnostics` (pre-call ID/kind/bounded redacted preview via `ARGUMENT_PREVIEW_CHARS`/hash; post-call status/timing/error/size; shell exit code/timeout/bytes/truncation), while helper tool records live in `helper_events`. A start-only record means observation stopped and is never proof that no change occurred; completion receipts and diagnostics are separate.
- **Native Codex internal activity (`recordNativeActivity`)**: Caps recorded search/planning/waiting/image activities at 64 and context compactions at 16 with overflow counts; never duplicates private reasoning, queries, result bodies, or app-recorded dynamic tools. Unreported internal model calls stay unknown, and premature process exit leaves undelivered internal activity unrecoverable.
- **`task.inspect` diagnostics contract**: `includeDiagnostics: true` pages attempts and tool diagnostics via `attemptsOffset` and `toolsOffset` (page size owned by tool schema); manual context summary attempts link through `context_job_attempts` and are not a separate `task.inspect` kind; individual Codex internal activity entries remain in attempt raw usage.
- **Retention and privacy**: Diagnostics are never injected into model prompts, previews stay bounded and redacted (`ARGUMENT_PREVIEW_CHARS`) so originals cannot be reconstructed (personal snippets may still appear), and records follow parent deletion and SQLite backups. Deleting a scene calls `redactHelperArgumentPreviews` at chat scope—because pruned completed inputs cannot prove which scene a call referenced—while keeping call IDs, hashes, timestamps, outcomes, and usage numbers; missing historical fields are never fabricated retroactively.
- **Omission-evidence tests**: Synthetic bounded HTTP error reading, credential redaction, and error forwarding are enforced by `tests/provider-http-error.test.ts` and `tests/provider-rejection.test.ts`; environment troubleshooting lives in [DEVELOPMENT](DEVELOPMENT.md).
