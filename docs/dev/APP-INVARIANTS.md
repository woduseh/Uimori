# App storage, editing, outline, search, reading, PWA, I18N, themes and usage

Developer invariants not stated by code, schemas, or user guides. Entry files per feature live in [CODE-MAP](CODE-MAP.md), and verification runners live in [DEVELOPMENT](DEVELOPMENT.md).

## Personal workspace schema 15 and startup upgrades

- **Startup row normalization (`upgradeStoredShapes`)**: Runs in one transaction on every DB open (including backups restored from SQLite snapshots), never changes revision numbers, and skips rows already in the current shape. User-visible startup backfills are listed in [DATA-MIGRATIONS](../DATA-MIGRATIONS.md#서버를-열-때-정리하는-저장-형식).
- **Removed evaluation controls and legacy copy receipts**: `upgradeStoredShapes` strips `maximumToolRounds`, `terminalLateCorrections`, and `outputRecovery` from model `evaluationTools` (and save/validation reject them thereafter). Legacy chat copy records lacking a recorded copy command are left unmodified and return `CHAT_COPY_RECEIPT_UNVERIFIED` (409) on retry so the browser clears the leftover key.
- **Single head and concurrency invariants**: Each chat owns its manuscript head (`chats.head_revision`) and execution state directly; the `branches` table, `branch_id` column, and API `branchId` are removed. Task owner/generation tracking, revision CAS, post-cancel late-save blocking, and request-key deduplication remain strictly enforced.
- **`HelperLimits`**: Uses only `totalCalls` and `helperCalls`; the deprecated `artifacts` field is excluded and stripped from legacy rows on startup.
- **Schema 15 on-demand tables**:
  - `helper_seed_messages`: Cloned dialogue from past helper session forks, created on demand at startup.
  - `execution_tool_diagnostics`: Lightweight tool diagnostic metadata owned by main, translation, and illustration tasks; does not replace replay receipts in `tool_events`.
  - `image_cleanup_candidates`: Deferred orphan image hashes waiting for active tasks to finish.
  - `helper_changes`: One record per helper task and target storing full pre-edit state (`baseline`) for turn rollback, UI diffs (`entries`), final-state hash (`result`), concurrent external save flag (`foreign_edit`), and rollback timestamp (`rolled_back_at`), deleted with `helper_tasks`. Rows predating these columns have an empty `result` and cannot be rolled back.
  - `theme_assets`: Theme font and image originals by hash, retained while referenced by a saved theme, its undo copy, or a retained `helper_changes` row, and separate from user fonts (`font_assets`) and body images (`image_blobs`). Unreferenced uploads are pruned on server startup after one day.
  - `search_trigrams`: Derived trigram index created on demand without bumping schema 15; legacy `search_fts` rows migrate on idle ticks until `search_fts` is emptied ([MANUSCRIPT-SEARCH](../MANUSCRIPT-SEARCH.md)).
- **`app_metadata` key conventions**:
  - `source-title:<sourceId>`: Optional scene names.
  - `illustration-presentation:<sourceId>`: Representative/display selection and translation placement for paragraph illustrations.
  - `helper-read:v1:<conversationId>`: Last seen task-result event sequence for a helper conversation (requires no DB migration).
  - `chat-pin:<chatId>` (`CHAT_PIN_PREFIX`): ISO time the chat was pinned, returned as `Chat.pinnedAt` and deleted with the chat. It is keyed by chat ID and outside the copied chat state, so copies, backups and imports start unpinned; pinning an already pinned chat keeps its time (`tests/chat-organization.test.ts`).

## Deletion, unused-data reclamation and helper cleanup

- **Reference-based reclamation (`pruneUnusedData`)**: Deletion and save transactions follow live resource references to reclaim orphan `image_blobs` and hidden entries; Reader queries and per-chunk model streaming never scan all stored resources.
- **Deferred cleanup and worker write-invalidation (`PendingImageCleanup`)**: While model or image work is active, candidate hashes queue in `image_cleanup_candidates` and are skipped when both `image_cleanup_candidates` and `library_hidden` are empty. On task completion, `PendingImageCleanup` scans references in a read-only Worker and discards the plan if any write advanced `total_changes()` on the main connection (retrying on the next completion); startup and deletion transactions run the same check synchronously.
- **Draft-protection exceptions and diagnostic snapshots**: Images appearing only in helper conversation text and individual illustration deletions do not enqueue image cleanup candidates because an unsaved draft in another window may still reference them (direct helper attachments and other resource deletions still enqueue). References held only by historical diagnostic snapshots never block reclamation once the last live reference is gone.
- **Helper change-record cleanup**: Scene deletion calls `forgetHelperSceneChanges`, resource deletion calls `forgetHelperResourceChanges`, chat deletion calls `forgetHelperChatChanges`, and helper conversation deletion calls `forgetHelperConversationChanges` before cascading deletion. Retention bounds are enforced on task admission, record write, and DB open; every path discarding a prior state queues its images in `image_cleanup_candidates` and calls `pruneThemeAssets`, while keeping text-cleared rows so task result lists remain intact.
- **Helper call-argument cleanup**: Scene, chat, library resource, theme, and illustration preset deletion call `forgetHelperConfirmationTargets`, and scene and chat deletion call `redactHelperArgumentPreviews`, matching records across conversations via stored target scene, `chatId`, and `targets`. Shell commands such as `uimori apply` leave only the command string and are not matched.

## Automatic backups

- **Storage path and Docker volumes**: `UIMORI_BACKUP_DIR`, Docker Compose volume mounts, UID 1000 ownership, and deployment-backup separation live in [AUTOMATIC-BACKUPS](../AUTOMATIC-BACKUPS.md#저장-경로와-docker-볼륨).
- **Online snapshot and verification worker (`BackupService`)**: A separate Worker verifies `quick_check`, foreign keys, DB format, and schema version before recording size, SHA-256, and app/build version in the manifest and atomically renaming the working directory. Prior successful backups are never pruned before a new backup succeeds, and `.partial-*` directories or unrelated files are excluded from listing and pruning.
- **API security boundary (`backupRoutes`)**: Backup routes and the preserved one-off `GET /api/backup` download never accept filesystem paths as request arguments and reuse workspace auth and maintenance gates. Cross-cutting backup/restore flows are verified by `tests/personal-workspace-flow.test.ts`.

## Independent chat backups and copies

### `.chat.uimori` archive structure and BLOB deduplication

- **Archive layout and deduplication**: Uncompressed ZIP (`uimori-archive` v1) containing root `uimori-personal-chat` v1 metadata JSON and `images/<SHA-256>.bin`, deduplicating identical bytes across representative images, body attachments, and scene illustrations. Server validation converts images to WebP and registers confirmed imports atomically without base64 JSON serialization.
- **Retired JSON export and multi-chat compatibility**: Legacy JSON export `GET /api/chats/:id/backup` is removed and returns 404, while restoring existing JSON backup files remains supported (transcript JSON export is separate). Exports contain only the single selected chat while keeping the metadata `chats` array structure so legacy multi-chat backup files still restore cleanly.

### Staging file lifecycle and concurrency protection

- **Staging TTL and process lock**: Staged files clean up immediately on restore, and incomplete staged outputs expire after 24 hours (cleaned at write-enabled startup and hourly; completed identical requests remain verifiable via receipt). Staging shares the process-wide 1-at-a-time lock (`acquireImportPreparation`) with Risu imports and resource-bundle staging, and client disconnect cleans in-progress staging artifacts immediately.
- **BLOB reuse and restore side effects**: Immutable BLOB reference counting and no-external-callback guarantees live in [CHAT-BACKUP](../CHAT-BACKUP.md#이미지-보존과-복원-시-실행-범위).

### Retry and copy API (`/api/runs/:id/retry`)

- **Mode and replace target retention**: `POST /api/runs/:id/retry` accepts `mode` (`'replace'` | `'copy'`; omitting applies the existing copy rule). Retrying a failed replace reuses the last response already reserved as the replacement target.
- **Copy idempotency**: Copy-check errors preserve the previous request key to prevent duplicate copies. If the target copy was deleted or is a legacy copy record without a recorded copy command, the client notifies the user and clears the leftover key so the next attempt creates a fresh copy.
- **Related contracts**: Full workspace recovery uses [DATA-MIGRATIONS](../DATA-MIGRATIONS.md); per-device reading positions and bookmarks live in [READING-STATE](../READING-STATE.md).

## Chat transcript import/export

- **Upfront atomic validation**: Format, memo target scenes, text size limits, and linked bot existence validate upfront so failures roll back the transaction with no partial chats or records (`tests/personal-workspace-flow.test.ts` covers workspace continuation). Full workspace recovery uses [DATA-MIGRATIONS](../DATA-MIGRATIONS.md).

## Portable resource transfers

- **Retired JSON export and receipt scope**: Legacy `POST /api/native-transfers/export` is removed and returns 404; new exports use `.uimori` archives only. No separate replay or execution-history attestation receipt system is maintained—exports hold only currently saved resource state.

### Two-stage atomic apply pipeline

- **Review-to-apply reuse and streaming export**: Pre-validation checks TOC, CRCs, and image SHA-256 and stages converted images one by one; confirmed apply reuses the review summary directly without re-validating or re-converting, committing resources and receipt in one transaction. Export streams images one by one from a read-only DB snapshot so concurrent edits or cleanup cannot corrupt downloaded bytes.

### Concurrency lock and staging file lifecycle

- **Single-job lock and cancellation**: `acquireImportPreparation` serializes Risu imports and `.uimori` staging to 1 job at a time per process without building a queue (callers retry after completion). Client disconnect cancels staging immediately, cleaning temporary files and discarding any already-started image conversion without proceeding to the next image.
- **Expiration and safe root guard**: Incomplete staged files expire after 24 hours (cleaned at write-enabled startup and hourly, retrying on failure). `ownedImportStagingRoot` restricts cleanup strictly to subdirectories of the SQLite DB's actual directory, never touching symlinks/junctions and preserving active staging outputs.

### Idempotency receipt retention policy

- **256-entry rotating prune with long-term exclusions (`saveImportReceipt`)**: Retains the 256 most recent general resource import receipts. Chat backup (`chat:`), transcript (`transcript:`), Risu (`risu-result:`), resource-legacy (`resource:`), and retry (`retry:`) receipts are excluded from pruning so prior imports never duplicate after many subsequent general imports.

## Resource editing, recovery, selection revision and helper changes

- **Touch-selected reader bar (`placeDocked`)**: On mobile long-press selection, docks to the bottom edge of the reading area (moving to the top edge if covered) to stay clear of native selection menus and handles, waits until handle dragging settles, and acts on the pre-press selection if tapping clears it (`RSEL22` in `tests/reader-selection-browser.spec.ts`).

### Input state and session ownership (`ResourceEditorSession`)

- **Single owner (`ResourceEditorSession`)**: Exclusively owns form model, raw text, saved baseline, dirty state, and save progress using functional updates with no parent sync loop; switching roles or presets only selects sessions.
- **Load lifecycle and auto-save**: Starting a new draft or returning to the list cancels in-flight fetches so late responses never overwrite the active view; list opens and externally targeted preset opens share one lifecycle. Auto-save for current prompt options schedules only on fresh edits (never on recovered input or failed saves), never overwrites post-submit typing, migrates recovery keys to the real ID on new/copy save, and refreshes clean editors while flagging conflicts on dirty editors from cross-window save notifications.
- **`Esc`, scroll, and focus restoration**: `Esc` in original/translation editors prompts only when dirty (Cancel keeps draft and tab recovery), while **편집 취소** discards without prompting. Opening original/translation editing scrolls only the Reader and `data-uimori-body-scroll`, restoring reading position and trigger focus on exit; the narrow-viewport scroll-to-bottom button hides during original/translation/request editing while scene list and bookmark editing stay usable.

### Local recovery storage (IndexedDB)

- **Async persistence and transactional clear**: Typing asynchronously overwrites only the latest device-local draft in IndexedDB (never syncing whole resources to `localStorage`), showing recovery-saved status only after confirmed persistence. Saving, canceling, or reverting compares the save identifier inside one IndexedDB transaction so another tab's later unsaved edits are never wiped.
- **Partial path updates**: Regular form edits allocate new objects only along the changed path and skip unchanged subtrees during dirty checks, avoiding cloning or JSON-serializing large cards/presets on every keystroke while preserving raw JSON apply and save-boundary validation.
- **Helper pending queue**: On a helper request, a saved resource sends only its ID and revision for server-side capture at admission, while an unsaved resource sends editor input for analysis (must be saved first before helper edits, without blocking other resources). Helper input and pending requests share the IndexedDB recovery store; persistence failures retain input and allow retrying or sending without recovery storage.

### Concurrency control and idempotency guarantees

- **Single save path and CAS (`saveResource`)**: Both user and helper go through `saveResource` with `expectedRevision` CAS (concurrency control, not an agent permission gate). Existing revision-conflict warnings persist across subsequent save failures until copy-save succeeds or an explicit reload occurs.
- **Creation/clone idempotency and receipts**: Browser new-resource saves and list clones attach per-request idempotency keys backed by small permanent created-ID receipts (no DB schema change; legacy calls omitting keys stay non-idempotent). Unconfirmed new-resource requests live in a per-tab IndexedDB record separate from general unsaved input, and **이전 요청 확인** re-verifies only the frozen payload even while new edits have errors, keeping keys across auth/check errors, flagging conflicts if another window edited the created target, and preserving edits for save-as-new if the target was deleted.
- **Cloning and decoupled post-save work**: Cloning checks source revision and copies saved content only; a prompt's library display name and native internal name are independent. Post-creation folder placement checks the post-creation organization revision and skips with a notice on concurrent changes or legacy receipts; list refresh and folder placement decouple from save completion (never auto-retrying writes on follow-up failure), and resource change events refresh only dependent chats.

### Internal data structure for context control (`scene_context`)

- **Separate revisioned table**: Context toggles live in `scene_context` with a revision number separate from Run/Source rows and govern subsequent model context, compaction summaries, search, and helper chat reads. Context-compaction validity incorporates the scene-context revision because visibility toggles do not change text hashes.
- **Copies, backups, and transcript v2 fallback**: Chat copies, chat backups, and the optional `sceneContext` field in transcript v2 preserve this state; legacy transcript v2 files missing `sceneContext` default to all scenes active.

### Selection revision and in-reader refinement

- **Shared hook and displayed-translation hash**: `SelectionRevision` and `ReaderSelectionTools` share `useSelectionRevision` and `POST /api/sources/:id/selection-revision`. Translation targets send `target: 'translation'` and the displayed translation hash verified by `shownTranslationChanged` (shared with `editTranslation`) because revision alone cannot identify the visible translation while re-translation is in flight.
- **Context slicing and full-draft verification**: `surroundingDraft` slices the requested `context` scope server-side, while the client still sends the entire draft so the server verifies both the translation hash and selection range against the full text.
- **Strict matching (`uniqueTextRange`)**: Decides solely against the saved body without renderer-type gating (all bot chats use the Risu renderer) and, unlike `matchHelperText`, does not normalize trailing line whitespace so saves are blocked when visible selection diverges from saved text.
- **Overlay placement and verification**: Bar and popover mount fixed on `document.body` (outside Shadow DOM theme frames whose `transform` breaks fixed positioning), computed within visible reader and `data-uimori-body-scroll` bounds and hidden when neither above nor below fits. Verified by `RSEL01`–`RSEL06` and `RSEL15` in `tests/reader-selection-browser.spec.ts` and `tests/selection-revision-browser.spec.ts`.

### Helper change card (`HelperChangeCard`)

- **Combined list and legacy rows**: Entry semantics live in [HELPER-TOOLS](HELPER-TOOLS.md#conversation-history-and-task-results). `results` and `changes` render as one list: result lines hide for resources and scene names with a change record, settings keep their result line and hide the matching change card, and tasks predating change records display result lines as before.
- **Navigation and arrival marking**: `openHelperChange` dispatches by domain: resources pass section/item anchors to `RisuNativeFields` / `NativeRisuPresetEditor` (cleared on consume), scenes translate `ReaderTarget.changedParagraph` into a block anchor and offset ratio, and arrival marking outlines the block anchor or editor section rather than body characters.
- **Non-color diff accessibility and verification**: Additions and deletions pair `--success-bg` and `--error-bg` with underline, strikethrough, leading `+`/`−`, and screen-reader labels, capped at `--diff-max-h`. Verified by `HCHANGE01`–`HCHANGE04` in `tests/helper-task-results-browser.spec.ts`.

### Helper turn rollback

- **Shared save paths**: Helper turn rollback (contract and skip reasons in [HELPER-TOOLS](HELPER-TOOLS.md#rolling-back-a-helper-task)) calls normal save functions so revision checks, translation invalidation, cross-window refresh, and single-step `resource_undo` match user saves.
- **Client unsaved-draft guard**: Because the server cannot see unsaved editor input, the client checks `touches` via `hasUnsavedResourceEditor` and the shared unsaved-input registry (original/translation, outline, author notes); any new editor for a rollback-eligible domain must register in `unsaved-input`.
- **Partial submission, refresh, and verification**: When any unit is blocked, `HelperTaskRollback` sends remaining units individually, then refreshes open views through the `resource.updated`, theme or preset and `task.rolled-back` events the rollback writes, which reach every tab as `helper` frames, through `OUTLINE_REFRESH_EVENT` (outlines), and through server chat events (scenes/author notes). Verified by `HROLLBACK01`–`HROLLBACK03` in `tests/helper-browser.spec.ts`.

### Helper partial edits and string replacement algorithm

- **Block references and tolerant matching (`matchHelperText`)**: Block references stay bound to the previously read block across earlier deletions or moves. `resource.patch` and `scene.patch` share `matchHelperText`: exact match → CRLF/LF tolerance → trailing spaces/tabs tolerance, applying relaxed tiers only to a unique match and never normalizing quotes or dashes so prose style cannot silently change.
- **Toggles and retained undo**: Toggle definition changes prune newly invalid existing selections and report removed/reset keys while rejecting newly supplied invalid values. The single retained previous save can be read for comparison without saving; multi-step resource history and cloned-preset sync are not provided.

## Outline workspace and writing pipeline

The five outline levels use `OUTLINE_LEVELS`. Helper tool schemas and paging contracts (`outline.read`, `outline.write`) live in [OUTLINE](../OUTLINE.md#도우미-도구-계약-outlineread-outlinewrite) and [HELPER-TOOLS](HELPER-TOOLS.md#bounded-composition-reads).

### Writing context assembly and pipeline

- **Programmatic brief (`GET /api/outline-nodes/:id/brief`)**: Assembles `path`, `children`, deduplicated `related`, same-parent/level `neighbors`, and up to 40 recent current-branch `sources` (`planned`/`focus`) directly from persisted data without a model call; actual Run execution adds up to 40 lineage `written` nodes.
- **Context injection and reservation boundaries**: `RunSnapshot.outline → MainInput.outline → main-host-context` reuses the main writing budget check without replacing user requests, manuscripts, memos, or lore. `POST /api/outline-nodes/:id/scene-command` binds `additionalInstruction`, target revision, and plan hash before `POST /api/scene-commands/:id/run` schedules prose generation; there is no separate outline writer executor, no helper-to-story auto-promotion, and no standalone scene-reservation API detached from an outline.

### Reservation cancellation, idempotency and change detection

- **Cancellation on substantive plan edits**: Editing an unexecuted reservation's ancestor path, direct children, or related plans cancels it in the same save transaction (sibling-only edits, revision-only bumps, and rolled-back changes do not; admitted Runs keep their frozen input).
- **Focus freezing and source linking**: `GET/PUT /api/chats/:id/outline/focus` overwrites focus idempotently; normal Run admission (`run`, `preview-main`) calls `freezeOutlineFocus`, and manuscript commit calls `linkFocusSource` to record a `focus` link.
- **Client idempotency keys**: Outline-save and writing payloads and keys persist locally before send; **요청 결과 확인** verifies the exact request instead of duplicating it, and reusing a key with a different target or payload conflicts.

### Review technical contract

- **Read-only boundary and no persistent review store**: **원문과 점검** restricts app tools to `outline.read` and manuscript/lore reads (rejecting writes) with no separate review agent, approval flow, or persistent review table—outputs stay in helper history and task records. Initial excerpt budgets live in [OUTLINE](../OUTLINE.md#원문-점검과-복사백업-범위).

### Database schema and data preservation

- **Tables and preserved legacy data**: Active tables are `outline_nodes`, `outline_batches`, `outline_links`, `outline_writings` (`origin`: `planned` | `focus`), and `outline_focus`; existing `outline_reviews` and internal scene-command records remain preserved ([DATA-MIGRATIONS](../DATA-MIGRATIONS.md)).
- **Single source of truth**: Only one copy of each outline and manuscript is stored; succeeded execution payloads prune down to revision, hash, and source references. Copy and backup behavior lives in [OUTLINE](../OUTLINE.md#원문-점검과-복사백업-범위).

### Outline verification and scope

- **Single mounted instance (`OutlinePanel`)**: The right-panel outline tab (`sidecar`) and full-screen view (`workspace`) are one `OutlinePanel` instance toggled by visibility only so selection and unsaved edits survive switches; no second narrow implementation is built.
- **Cross-cutting tests and scope**: Verified by `tests/helper-outline.test.ts`, `tests/helper-workspace.test.ts`, and `tests/side-panel-browser.spec.ts` (including constant SQL query count as outline size grows and immutability of preserved review data; runner commands in [DEVELOPMENT](DEVELOPMENT.md)). Automatic replanning, multi-chapter automatic writing, shared templates, graph editors, and new memory-extraction systems are out of scope.

## Original-work reference (Story Guide)

### Execution pipeline and cache policy

- **Context composition**: Receives conversation, current summary, character card, persona, lorebook, card example dialogue (tone reference only, never factual events), author memos/notes, turn outline, and user request; regeneration excludes the replaced response.
- **Strict cache reuse**: A stored reference is reused only when input context, settings, model, and reference prompt match identically; references created after executing additional read tools are never reused.
- **Record ownership**: **마지막 집필 참고문** reflects only the reference actually included in the final main writing call (not the generation cache), so canceling before the main call or excluding it on request edit preserves the prior turn's record. Call structure, summarization budget, and copy/backup scope live in [STORY-GUIDE](../STORY-GUIDE.md#사용량실패-처리와-복사백업-범위).

### Schema and verification

- **Database contract**: Uses schema 15 lightweight chat metadata with no separate task-queue table, long-term memory store, or full-text search index.
- **Verification**: `tests/story-guide-*.test.ts` (settings/copy/conflicts, no model calls on retired manual APIs, helper parity, budget/caching, synthetic delivery/failure/cancellation) and `CSUI10` in `tests/chat-settings-browser.spec.ts`.

## Story UI scanning, compilation and pins

- **Dynamic-import bundle split (`scanStoryUi`)**: Detects `<a2ui>` tags without zod or the A2UI catalog so the Story UI parser renders tag-free prose directly and dynamically imports `core/story-ui.ts` only when tags appear (showing a placeholder meanwhile). Web code must never statically import `core/story-ui.ts`; range-only callers call `scanStoryUi`, while the server validates synchronously via `core/story-ui.ts`.
- **Edit compilation (`compileEditedSourceText`)**: Direct and helper scene edits compile before save, whereas helper rollback skips compilation to restore the previously saved source verbatim (`tests/story-ui-lifecycle.test.ts`; edited-block image bindings in `tests/story-ui-asset-run.test.ts`).
- **Derived status-board pins (`latestStoryUiPins`)**: Recomputes pins from the scene chain on demand (`/api/chats/:id/story-ui/pins` → `StoryBoardPanel`, `tests/story-ui-pins.test.ts`) with no separate pin state across edits, regenerations, forks, or backups. Tab visibility comes from this response (not the reader's partial slice), and the current scene resolves via `readerLocation`.
- **Failed-block placement**: `compileReadingMarkdown` compiles prose before and after a failed block separately.

## Manuscript search (FTS5 trigram)

### Index structure and change tracking (FTS5 trigram)

- **Derived tables and dirty queue**: `search_documents`, `search_trigrams`, and migrating legacy `search_fts` are derived data not rebuilt in full on restart. Edit transactions enqueue only `(source_id, revision)` in `search_dirty_sources`; a read Worker normalizes small batches and the main server checks revisions before applying index updates.
- **Write bounds**: Each index write caps at roughly 256KiB of combined old and new text or up to 8 scenes; a single very large scene indexes alone so responsiveness of other operations beats total index completion time.
- **Index storage format**: `search_documents.text` stores a single plain-text copy for snippets (no persisted lowercased copy) feeding the positionless trigram index `search_trigrams` (`detail=none`, `contentless_delete=1`); phrase queries narrow candidates via trigram AND and verify against stored plain text.
- **Legacy migration (`moveLegacySearchIndex`)**: Migrates non-empty `search_text` rows from `search_fts` at ~128KiB per 1-second idle tick when no dirty indexing is pending, clears `search_text`, and empties `search_fts` once done (thereafter the 1s tick is read-only). Mid-migration searches consult both indexes and resume across restarts; columns and tables stay intact to preserve schema 15.
- **Latest-body overlay**: Search overlays dirty documents with their latest text inside the same SQLite read transaction so saves and deletions appear immediately even when indexing lags.

### Search queries and segment scanning

- **Trigram vs sequential scan**: Terms of 3+ characters narrow via `search_trigrams` before text verification, whereas shorter-only queries (including 2-character Hangul/Hanja/Kana auto-queries) scan sequentially in 200-scene segments because a trigram index cannot narrow terms under 3 characters. Cursor stability, snapshot scope, and **남은 원고 검색** live in [MANUSCRIPT-SEARCH](../MANUSCRIPT-SEARCH.md#검색-범위유지보수-모드와-제한-시간).

### API contract and ReaderTarget contract

- **Read-only security boundary (`manuscriptSearchRoutes`)**: Executes read-only (`PRAGMA query_only=ON`, active in maintenance mode) against only the server-chosen DB—never accepting raw SQL or file paths—under an 8-second Worker timeout and max-4 concurrency limit (`ManuscriptSearchQuery` / `ManuscriptSearchResult`).
- **`ReaderTarget`**: Shared navigation contract carrying chat, scene, representation, hash, and paragraph; falls back to scene start if body hash changed, and never places search queries or manuscript excerpts in URLs.
- **Browser coverage and scope**: Live search, navigation, and small-viewport layout are covered by `tests/personal-features-browser.spec.ts`. Dynamic script output and morphological/semantic search are out of scope.

## Reader navigation, streaming, renderer and helper sessions

- **Unused default helper conversation filtering (`listedHelperSessions`)**: Opening the helper creates a chat's default conversation; `HelperWorkspace.list` returns all conversations flagged `unused`, and `listedHelperSessions` hides unmodified empty default conversations from other chats' lists and the global list. They always remain visible in their own chat and—once opened—in the current tab until reload so browser-only drafts keep a path back without deleting the conversation; explicitly created **새 대화** conversations always appear.

### Reader navigation state and SSE synchronization

- **One live connection per tab (`createLiveHub`, `liveStream`)**:
  - `web/live-stream.ts` owns the tab's only `EventSource`. It opens `/api/events` even when no chat is selected; selecting or switching a chat reopens that same connection with `chat=` and `streamAfter`, so a tab never holds two. Local development and the bundled nginx profile speak HTTP/1.1, where the 6-connection-per-origin limit makes a second per-tab connection stall other requests across two tabs; production behind Tailscale Serve negotiates HTTP/2 but keeps the same rule. `/api/chats/:id/events` stays chat-only for tabs loaded before an upgrade (`LIVE01` in `tests/live-events-browser.spec.ts`).
  - Global frames (`live`, `chats`, `helper`, `invalidate`) carry metadata only and never an `id:` line, so the composite `Last-Event-ID` below stays owned by the chat stream (`tests/live-events.test.ts`). The hub never replays: consumers re-read through the existing cursor endpoints, and a client whose socket buffer is full skips frames and receives a fresh `live` frame on drain. The `live` frame carries the hub's tails (`chatsSeq`, `helperSeq`, the `invalidations` count and `instanceId`), and the client signals `resync` only when they differ from what it has already received: on the first connection, after a restart, after skipped frames, or when something changed while it reconnected. Selecting a chat reopens the connection, and an unconditional `resync` made every subscriber re-read on each chat switch. `invalidate` frames carry their count so a reconnect also notices a missed volatile change. A return to a visible tab signals `visible`, and `createLiveRefresh` reads then only if it dropped a matching signal while hidden or the stream is not open.
  - `Store.event` and `HelperWorkspace.event` report through `Store.changed`; the hub coalesces those reports with `setImmediate` and reads afterwards. Transactions are synchronous, so the read sees only committed rows and a rolled-back write sends nothing. The same pump publishes each reported chat's stream, which is how replicated `helper.*` events reach an open chat without a manual `publish`. Writers that insert events without `Store.event` (`recordContentProfileEvents`, `recordPromptWorkspaceUpdate`) reach the hub through the app's `publish`/`publishAll`, which also notify it; the remaining manual calls are harmless because every pump reads from a cursor.
  - The hub's heartbeat is a named `keepalive` event because SSE comments are invisible to scripts. The client reports `down` when the connection stays closed or when nothing, keepalive included, arrives for longer than a heartbeat interval allows (`liveDelay`); the silence rule is what catches a buffering proxy. `useLiveRefresh` polls only while `down`, so polling remains the degraded mode rather than a parallel path. A connection closed by a non-200 response is reopened with backoff, because the browser does not retry it on its own. Event-stream responses leave the `Connection` header to Node: an explicit `keep-alive` on a request that a proxy sent with `Connection: close` made Node answer the next request on the reused upstream socket with 400, which surfaced once the library-screen stream began ending on logout (`SHUI01`). Test mode accepts `POST /api/test/live-frame` to inject a frame for mocked browser harnesses.
  - The helper panel's readers (`useHelperConversation`, `useHelperSessions`, `useHelperActivity`, `useHelperTaskResults`) refresh only on matching frames and `resync`, through `createLiveRefresh`; an open, idle panel therefore makes no requests (`HELPLIVE01` in `tests/helper-live-browser.spec.ts`). A frame carries the event kind and task ID, so the conversation and list readers apply the diagnostic classification to the frame itself and skip diagnostic frames without a read, while task activity and results read on every frame of their task. The exception is a task the open conversation still shows as queued: `HelperWorkspace.start` writes no event, so the first event after the claim, often a diagnostic one, is the only sign that the task began running. The list and task readers space their reads by `helperRefreshSpacing` because tool-heavy tasks emit events in bursts and the conversation list is the most expensive helper read. Degraded intervals live in `helperPollDelay`; task activity and results poll only while their task is active. The all-conversations list also follows `chat.title.*` frames of the chats it lists, because it shows their titles.
  - Views of server data that other code can change subscribe to frames themselves (`web/live-frames.ts`) instead of window events: the library, the prompt workspace, the request preview, resource editors, package features, chat options and rollback views on finished tasks, saved artifacts, settings and resource writes; themes, illustration presets and fonts on their helper events; prompt-workspace views on `prompt-workspace.updated`. The window events were sent only by the open conversation's reader, so a task finished with the panel closed, in another conversation or on another device refreshed nothing. Theme, preset and font changes made outside the helper write no event and still arrive through focus and cross-tab storage. `ContextPanel` reads on its chat's `context.*` frames, so it follows a change even while the reader is paused (`CTXUI05` in `tests/context-browser.spec.ts`), and polls at `contextJobPollDelay` only while a compaction job is pending, because the move from queued to running writes no event.
  - A local save whose server write produces a frame (`announceLocalChange` with `echoed`) is announced inside the tab only while the stream is not open, so an open tab reads once, from the frame; a save that writes no event (provider settings, resource-editor saves) is announced every time. The one-time read that every subscriber makes on the first `live` frame is the price of not missing a change between its initial read and the connection opening.
  - List changes that write no helper event (creating, copying or deleting a conversation, creating, renaming or deleting a group, raising a read mark) call `Store.invalidated('helper-list')` after their transaction, and a replayed creation request sends nothing. `acknowledgeActivities` sends `activity` only when it stored a new acknowledgement, and deleting a chat sends both, because the deletion writes no event the hub could read. Invalidations are not replayed; a tab that misses one catches up on its next `resync`.
- **Single navigation state machine**: Repeated navigation to the same URL (`A→B→A`) or scene re-selection counts as a new intent so late fetches or retries cannot overwrite the active view or bounce chats.
- **SSE cursor and backoff**: Retries transient errors with exponential backoff up to 5s, marks full resync complete only after applying to screen, and cancels retry timers on chat leave. An initial non-disconnect `snapshot` skips a second full fetch (fetching incrementally only if behind), while new events arriving during the initial fetch trigger immediately; post-disconnect or failed-initial snapshots perform a full resync.
- **Global prompt-setting events (`recordPromptWorkspaceUpdate`)**: Writes one latest-change record in `app_metadata` reserving a sequence from `events`'s `AUTOINCREMENT` so `Store.events()` and `latestEventSequence()` merge `prompt-workspace.updated` into every chat's SSE stream, Reader cursor, and display revision; legacy per-chat rows remain delivered (`tests/response-transport.test.ts`).
- **`/reader` block text**: Slices `text` from original or translation on receipt when the server sends range-only blocks while continuing to accept legacy responses containing `text`.
- **Idle-tab power saving**: Library view and background tabs pause Reader polling and retries while retaining cursor and notifications; card input prompts check only on SSE events, reconnects, and view return, coalescing overlapping checks and preserving next-prompt drafts across late acknowledgements.
- **Live response streaming**:
  - Multiplexes the selected chat's response text and library-scope helper text (`chatId` null, `subscribeChat(null)`) onto the tab's live connection as `event: stream` frames, with or without a selected chat, instead of per-response connections to avoid HTTP/1.1's 6-connection-per-origin limit (separate chat, main, and helper connections would stall other requests across two busy tabs).
  - `ResponseStreamStore` delivery and persistence batching is owned by [Execution input lifetime, Batch recovery and response streams](PROVIDERS-AND-CODEX.md#execution-input-lifetime-batch-recovery-and-response-streams); cursor polling reads text not yet persisted so push and poll share sequence numbers, and `StreamingResponse` merges push and poll pages through one per-task cursor.
  - Every frame `id` carries composite `<채팅 순번>;<종류>:<작업 ID>:<글 순번>,...` (`<chatSeq>;<kind>:<taskId>:<textSeq>,...`) so browser reconnects resume both independent sequences via `Last-Event-ID` alone; fresh connections pass `streamAfter`, and a gap in frame `after` falls back to cursor polling.
  - Cursor polling fallback (helpers of other chats in the all-conversations view, partial views, disconnects, mount, re-visibility) runs at `responseStreamPollDelay`, once after push silence to avoid stalls behind buffering proxies (`HELPLIVE03` in `tests/helper-live-browser.spec.ts`); per-task `/api/response-streams/:taskKind/:taskId/events` remains unused by the app, and hidden tabs discard push pages and stop polling (`tests/response-stream-browser.spec.ts`).
- **Streaming during translation**: `SourceReader` renders translation streams via `StreamingResponse` with `quietUntilText` (preserving the preparing indicator until `onText`), shows only the latest attempt without Story UI, keeps the existing translation while re-translating, and swaps to the saved translation on completion. Structured output, submit tools, Codex, and Story UI placeholder tags suppress raw streaming via `publicProgressAllowed`; verified by `tests/translation-stream.test.ts` and `STREAMTRANSLATION` in `tests/response-stream-browser.spec.ts`.
- **Side-panel width and reading position**: Opening, closing, or resizing the right panel holds the reading paragraph steady via browser scroll anchoring (`overflow-anchor: auto`, `web/style.css`). Dragging updates only `--panel-w` on `.app-shell` outside React, bypassing `changeLayout` in `useReadingPreferences`; verified by `tests/side-panel-browser.spec.ts`.
- **Bottom follow (`useBottomFollow`)**: Shared by main reader and helper; the main reader follows only from request send until chat completion (never on chat switch or page load). Scrolling up stops immediately, returning within 80px resumes, shrinking content does not count as scrolling up, and in-progress responses scroll the reader container rather than `data-uimori-body-scroll` because they sit outside scene theme frames.
- **Auto-translation switching and interaction guard (`SourceReader`)**: Tracks wheel, touch move, scroll keys, scrollbar clicks, text selection (including Shadow DOM via `readerContains`), and open editors per scene; clears on entering queued/running translation except when a selection or editor stays open at completion. Off-screen scenes switch unconditionally; manual choice persists in `sessionStorage` under `reader-mode:<장면 ID>` (`reader-mode:<sceneId>`), aligning switches on visible block anchor (or matching positional block when block counts match), verified by `RSEL07`–`RSEL09` and `RSEL12`–`RSEL14` in `tests/reader-selection-browser.spec.ts`.
- **Request recovery keys**: While verifying uncertain acceptance, the submit button stays `'이전 요청 확인'` so it never flips to cancel; verification records survive 404/conflict until explicitly cleared.

### Renderer architecture and DOM contract

- **Streaming paragraph rendering (`splitCompletedParagraphs`)**: Compiles completed blank-line-delimited leading paragraphs with the finished-prose compiler (`Prose` / `HelperMessageProse`) while rendering only the in-progress last paragraph as plain text in the same font, ignoring blank lines inside unclosed code fences or `<a2ui>` blocks. Finished bot scenes render via the server Risu renderer inside a scene theme frame (`tests/response-stream-browser.spec.ts`).
- **Safe Markdown subset**: Only attributeless `ruby`, `rb`, `rt`, `rp`, `u`, `sup`, `sub`, `mark`, `small`, `b`, `i`, `s`, and `br` render as HTML; all other tags or attributes are escaped. Illustrations insert only after closed Markdown containers, placing legacy/unsafe-boundary images below the body.
- **Geometry markers, protected tokens, and immutability**: Temporary coordinate-mapping markers stay out of selection, clicks, accessibility tree, and layout and recompute on resize/font change; `{{…}}` scans for its closing delimiter first to avoid slowdowns on repeated unclosed tokens. Reading preferences modify presentation CSS/React only and never alter stored text, hashes, offsets, anchors, prompts, or backups.

### Helper sessions

- **Session ownership and transcript edits**: Each chat owns independent helper sessions whose background tasks continue across panel close or session switch; chat copies never share mutable defaults. Editing or deleting helper messages preserves original execution evidence separately, applies immediately to views and future context (including seed messages and retry groups), immediately detaches any active helper summary so stale text cannot re-enter via compaction, and never rewrites past task snapshots or committed edits.
- **Model selection, limits, and retries**: Changing helper model updates only the helper role for future requests without touching main writing or other roles, and the latest committed revision beats late responses. Call limits, 429/5xx retries, refusal repeats, and **이어서 하기** continuation rules live in [READING](../READING.md#도우미-모델-선택재시도와-이어서-하기) and [HELPER-TOOLS](HELPER-TOOLS.md#activity-and-additions-to-a-running-task).
- **Monotonic read state (`markHelperConversationRead`)**: Stored under `helper-read:v1:<대화 ID>` (`helper-read:v1:<conversationId>`) in `app_metadata`, moving strictly forward without exceeding the conversation's latest result sequence, returned inline on conversation lists, and deleted with the conversation or chat. The browser keeps only ahead unpersisted values in `uimori:helper-seen:<대화 ID>` (`uimori:helper-seen:<conversationId>`), uploads once on first list load, and retains failed writes for the next acknowledgement without retry loops (`tests/helper-navigation.test.ts`, `HREAD01` in `tests/helper-task-results-browser.spec.ts`).
- **Live display context**: Opening Reader or helper fetches the current view and event cursor without replaying old notifications; completed Risu presentation assembles live message history once without reconstructing discarded histories, sharing outer block anchors with general Prose.
- **Presentation cache and revalidation**:
  - Route key hashes source/translation hashes, actually-used snapshot (excluding post-completion `phaseSpans` timings), image jobs/assets, viewport, and renderer version; message key is per-language and content-hashed (not revision-keyed) so non-event settings changes invalidate. `ETag` combines this key with the process startup ID (`Cache-Control: private, no-cache`, after auth hook) so restarts recompute.
  - `trackNativeRisuEntropy` / `recordNativeRisuEntropy` flags CBS `{{random}}`/`{{roll}}` or Lua `math.random` across the worker boundary to skip caching and `ETag`; clocks pin to `executionClock` and Lua has no `os`.
  - Multiple scene requests share history and logical history per `(채팅, head, 이벤트 순번)` (`(chat, head, eventSequence)`) for 5 seconds; `precomputePackagePresentation` precomputes recently viewed scenes one by one at the last viewport, yielding whenever a live screen request is in flight.
  - Reader `presentationRevisions` (`readerPresentationRevisions`) are per-scene and bump every scene only in chats reading live head and variables (`tests/package-presentation-cache.test.ts`).
- **Original and translation retention**: Preserves the immutable initial original, latest 2 edited versions, and versions pinned by unfinished tasks; translation history preserves current and immediately previous successful translations plus active image targets.

### Reader and renderer verification tests

- **Browser and cross-cutting specs**: `tests/reader-navigation-browser.spec.ts`, `tests/reading-browser.spec.ts`, `tests/reading-markdown-browser.spec.ts`, `tests/risu-message-surface-browser.spec.ts` and `tests/risu-native-frame-browser.spec.ts` (`RSURFACE`), and `tests/risu-reading-markdown.test.ts`. Integrated UI runner (`verify:ui`) lives in [DEVELOPMENT](DEVELOPMENT.md#verification-runners).

## Reading state and bookmarks

### Reading position data schema and storage layers

- **Storage split**: `reading_positions` keeps exactly 1 latest position per browser and chat (`chatId`, `sourceId`, `representation`, `contentHash`, `blockAnchor`, `offsetRatio`; no pixel coordinates or scroll logs go to the server). `localStorage` holds the device scroll cache (migrating legacy `sessionStorage` positions on read), `sessionStorage` holds composer cursor/tab transient state, and the browser's random `clientId` is not an auth credential.

### Concurrency and CAS (`expectedRevision`) conflict control

- **Multi-tab CAS and sequential handoff**: Concurrent tab writes use `expectedRevision` CAS; stale positions are not force-retried (re-checked on next entry/return), and new scroll activity during an in-flight save chains sequentially after completion when leaving or closing a tab.

### Bookmark data model and atomic management

- **Ownership and persistence boundary (`readingStateRoutes`)**: Bookmarks have no TTL and are never auto-deleted on anchor drift; reading positions and bookmarks delete only with their chat. Server routes always verify scene ownership in the current chat path, and position saves never trigger tokenization or body reparsing. End-to-end verification (`verify:personal-features`) lives in [DEVELOPMENT](DEVELOPMENT.md#personal-workspace-verification-scope).

## Turn activity

- **Phase derivation (`runPhase`)**: Derives **컨텍스트 정리** → **로어 선별** → **원작 참고** → **본문 작성** from the saved execution snapshot under the same conditions as the run executor, exposed on `reader.runs[].phase` and updated via existing `run.context.updated` (no new event type). Retries with a saved original-work reference may display **본문 작성** while re-checking.
- **Scoped activity split**: `reader.activity` keeps its active/last-30 contract unchanged while historical page tasks use `reader.responseActivity` metadata so viewing older scenes never re-emits stale failure notifications.
- **Context bar marker (`CONTEXT_COMPACTION_TRIGGER_RATIO`)**: The scene inspector's context bar marks the main-chat compaction ratio from `core/context-compaction.ts`, the same constant the server compares before summarizing earlier scenes. The helper's `HELPER_COMPACTION_INPUT_RATIO` is a separate policy and never drives this marker.
- **Context parts (`RequestContext.parts`, `mainContextParts`)**: Each main attempt stores its per-category split next to `estimatedInputTokens` in the attempt's `requestContext`, so the reader returns it without a schema change; attempts recorded before the split have no `parts` and the inspector keeps the single-colour bar for them. Categories follow the compiled prompt's provenance (the template block type behind `risu-block-N`, history/current origin, the `context-summary` message and the spliced lore messages), never message text. Each category is counted with the request's own estimator, and `other` takes the rest of the measured wire total (the host contract, the host-context reference message apart from the story-guide brief, tool exchanges and the protocol envelope), so the parts always sum to `estimatedInputTokens`; when separately counted parts exceed that total they are scaled down rather than letting `other` go negative. Example dialogue the chat block emits before history counts as `botDescription` because it is fixed card content, while the authored first message counts as `history`. A request continued through provider state (`opaqueState`) does not carry its full prompt, so it records no parts. `ContextBreakdown.tsx` draws this split and the helper's `latestInputParts` with one palette in which identical meanings share a colour.
- **Verification**: `tests/turn-activity-browser.spec.ts` uses the shared viewports in [browser-viewports.json](../../fixtures/browser-viewports.json); runner commands live in [DEVELOPMENT](DEVELOPMENT.md#verification).

## PWA, activity feed, Web Push and auto-translation language detection

- **Auto-translation language detection (`isWrittenIn`)**: Classifies text by character composition without a judgment model, stripping markup, code blocks, and template expressions and still translating mixed or short ambiguous text. Supports Korean, English, Japanese, and Chinese only (`WRITTEN_LANGUAGES`); **번역 결과 언어** is stored on the server separately from the UI language.

### PWA manifest, icon generation and service worker specification

- **Manifest and non-caching service worker**: App ID, start URL, and scope fix to `/` (never private chat paths or tokens), served as per-language static manifests ([I18N](../I18N.md)). `sw.js` updates bypassing HTTP cache, never mirrors manuscripts or API responses into CacheStorage, and stores UI language at `settings/ui-language` in the `uimori-presentation` IndexedDB database.
- **Icon asset sources**: Sidebar logo [halo-mark.svg](../../web/public/icons/halo-mark.svg), simplified motifs [halo-tiny.svg](../../web/public/icons/halo-tiny.svg) (16px), [halo-small.svg](../../web/public/icons/halo-small.svg) (32px), [halo.svg](../../web/public/icons/halo.svg) (48/64/180/192/512px), and responsive [favicon.svg](../../web/public/favicon.svg); derived SVG/PNG icons regenerate via `node scripts/generate-app-icons.mjs`, with maskable icons carrying safe-zone padding and the dark-navy install background.

### Activity feed and acknowledgement API

- **Feed query (`activityFeed`)**: `GET /api/activity-feed` reads the latest 500 tasks excluding manuscript text and images, and never replays tasks completed before the first updated server startup (`activity-feed:baseline:v1`) as newly unread.
- **Acknowledgements (`acknowledgeActivities`)**: `GET/POST /api/chats/:id/activity-acknowledgements` stores per-run acknowledgements in `app_metadata`, merges browser-local records, and cleans up on chat deletion.
- **Refresh (`useActivityFeed`)**: The feed reads on status frames of runs, jobs, illustrations and helper tasks and on `invalidate:activity` (`activityFrame`), spaced by `activityRefreshSpacing`, and polls only while the stream is down (`activityPollDelay`), so an acknowledgement on another device clears this tab's entry at once (`ACTLIVE01` in `tests/activity-browser.spec.ts`). Helper read state lives under [Helper sessions](#helper-sessions).

### Web Push delivery queue and VAPID architecture

- **Atomic enqueue and transport security (`pushRoutes`)**: Enqueues one delivery record per subscription inside the task-completion transaction. Encryption/signing delegate to the Web Push library while standard fetch enforces HTTPS-only relay URLs and disallows redirects; subscription mutations verify revision, and `GET /api/push` and subscription responses never return the private VAPID key or subscription capability.
- **Operational bounds and verification**: Queue concurrency/timeout/retries, TTL/pruning, session-bound revocation, VAPID backup confidentiality, the Android Chrome `'구독 취소'` native UI caveat, and Codex auto-translation pre-check live in [PWA](../PWA.md#푸시-재시도보안과-자동-번역-사전-검사). Transport encryption, HTTPS relay checks, and worker focus are covered by `tests/push-transport.test.ts`; browser suites live in [DEVELOPMENT](DEVELOPMENT.md#personal-workspace-verification-scope).

## Browser storage keys

- **One registry (`storageKeys` in `web/storage-keys.ts`)**: Every `localStorage` and `sessionStorage` key or key family is declared there with its storage area, the owner of its lifetime and whether it holds unsent work or a recovery receipt (`work`). Code takes keys from `storageKeys`; existing key names never change, because browsers hold values under them. `tests/storage-keys.test.ts` scans `web/` and fails on a key built inline at a storage call or on a literal in the app namespaces that no family covers. A key that reaches storage only through a variable built from a new namespace is outside that scan.
- **Startup sweep (`sweepUnregisteredStorage`)**: Before the first render, `localStorage` keys in the app namespaces (the leading segment of each registered local key: `uimori:`, `uimori.`, `uimori-`, `reading:`) that no family covers are removed. Nothing outside those namespaces, no `sessionStorage` key and no IndexedDB record is touched. It exists because retired families such as `uimori:editor-buffer:*` once filled a 10 MB quota and every later write was refused. Work families are registered, so the sweep never removes them. The `uimori:helper-{input,outbox,selection,outline,artifact-draft}:*` keys that predate the IndexedDB helper recovery store are deliberately not registered: the app no longer reads them, so the sweep removes them.
- **Deletion and caps**: Deleting a chat or bot in this browser (a successful `DELETE /chats/:id` or `/content/:id` through `api()`) and its absence from the complete `/chats` or library list remove its reading position, activity acknowledgements, helper selection keys and chat folder state (`forgetChatStorage`, `forgetMissingChats`, `forgetBotStorage`, `forgetMissingBots`). Families without such an owner signal take a `cap` and are written through `writeRecentStorage`, which keeps the most recently written keys in `uimori:storage-recency:v1`: 500 illustration collapse choices, 200 prompt option groups, 200 helper confirmation declines. Activity acknowledgements the server already returned are dropped locally beyond the newest 100 per chat (`forgetConfirmedAcknowledgements`), which still covers every activity the chat view can show. A collapse or folder state equal to its default is removed instead of written.
- **Refused writes**: Presentation settings report a refused write once (`watchPresentationWriteFailure`). A refused `sessionStorage` write of a draft (request and helper message edits, source text edits, the retry request, story UI fields, the input translation original, a parked queued request) shows `chatsettings.m159` where the user is editing; IndexedDB drafts, the helper outbox and pending helper requests keep their own error paths. Cosmetic state (collapse, sort, view, folder state) stays silent.

## UI language (I18N)

### Message representation and ICU formatting contract

- **Per-language catalog chunks (`uimori-locale-catalogs` in `vite.config.ts`)**: Four-language sources in `web/locales/*.ts` compile via `web/locales/{ko,en,ja,zh}.ts` into single-language JSON so only `web/locales/ko.ts` ships in the startup bundle (required synchronously for fallback and `legacyMessage()` reverse mapping), while `en`/`ja`/`zh` load on demand. Startup-bundle modules (`web/api-errors.ts`, `web/request-file-errors.ts`) must import `web/locales/ko.ts`, never multi-language sources such as `web/locales/errors.ts`.
- **Startup loading and switching**: Startup awaits `loadInitialLocale()` before first render so wrong-language strings or raw keys never flash (falling back to Korean for the session if chunk load fails); overlapping switches resolve to the latest choice, and synchronous callers/tests preload via `loadLocale()`.
- **ICU runtime and render subscriptions**: Uses `intl-messageformat` as the sole runtime dependency (no custom plural parser or HTML interpolation). Components subscribe via `useI18n()` without caching translations in module-level constants; missing keys fall back to Korean while undefined keys render literally and fail static checks.
- **Deferred, nested, and legacy messages**: Persistent notices hold `message(key, values)` descriptors resolved at render via `translateMessage()` (UI-state only, never sent to server/models), and `onError` preserves raw messages/descriptors so language switches update displayed text without resending. Only nested app messages wrap with `messageRef()` (user text renders verbatim); `legacyMessage()` preserves Korean `Error.message` on validators, and `registerMessage()` maps legacy wire error strings.
- **Locale formatting**: `formatNumber` and `formatDate` reuse `Intl` formatters per locale and option set while keeping USD currency, KST usage rollups, backup time zones, ISO query ranges, raw numeric values, and Korean K/M abbreviations unchanged; invalid timestamps omit dates cleanly.

### API errors and external boundary handling

- **Wire contract and raw-data boundaries**: `ApiError.message` and `code` keep a fixed wire contract; Korean wire matching runs on raw strings before UI localization via `displayMessage`, and internal logic inspects codes, statuses, and numbers rather than localized copy. Provider diagnostic logs, server DELETE conflict reasons (may contain user names), and unknown import findings render verbatim; changing an existing import finding's code or sentence requires updating its display mapping and tests together.
- **Service worker and manifest**: SW persists the locale at `settings/ui-language` in `uimori-presentation` IndexedDB and reads it per push event (defaulting to Korean) without adding caching, automatic resends, or forced reloads. Per-language static manifests keep app ID, name, start URL, and `/` scope fixed; browser/OS controls permission prompts, install menu language, manifest refresh, and SW activation.
- **Catalog keys stay reachable (`findUnusedMessages` in `scripts/check-i18n.mjs`, run by `npm run quality`)**: A key is used when it appears as a string literal in `web`, `core`, `server`, `scripts` or `tests`; when a template literal or `'prefix.' +` concatenation that starts with a key segment can produce it (`t(\`palettes.color.${key}\`)`); or when its Korean value has no placeholder and appears verbatim as a string in `web`, `core` or `server`, because `translateMessage()` reverse-looks up placeholder-free Korean text. Any other key fails the check and is removed from all four languages. A derivation the scan cannot see goes in `retainedMessagePrefixes` with its reason; today that is only `errors.auxiliary.`, whose `.details` keys `web/auxiliary-error.ts` builds by replacing `.message`. So does a key whose Korean text only older servers stored and the client still reverse-translates: before removing a placeholder-free key, search the `core` and `server` history for its Korean value. New keys take semantic names (`common.languageNotSaved`), not numbered ones such as `chatsettings.m67`; existing numbered keys keep their names.
- **Verification**: Legacy error compatibility is covered by `tests/api-errors.test.ts`. `check:i18n -- --candidates` includes model inputs, persisted defaults, and legacy errors, so blind bulk replacement is prohibited; runner commands live in [DEVELOPMENT](DEVELOPMENT.md#verification-runners).

### Automatic chat title generation contract

- **Scheduled language**: Automatic titles generate in the app's UI language at schedule time using an English prompt instruction; legacy tasks lacking a language field generate in Korean.

## Themes, built-in assets and verification

- **Built-in assets and color keys**: Built-in asset files live in `third_party/theme-assets` with hashes pinned in `BUILTIN_THEME_ASSET_FILES` (sample theme fixtures live in `fixtures/themes/`); cloning and saving copies them into user themes for self-contained export. Custom decorative art regenerates from SVG via `scripts/theme-art/<레이아웃>.mjs` (`scripts/theme-art/<layout>.mjs`), after which its hash in `BUILTIN_THEME_ASSET_FILES` must be updated. Color names omit the leading `--`; the canonical list is `THEME_COLOR_KEYS`.

### Built-in layouts and palette sources of truth

- **Sources of truth and user-theme preservation**: Built-in layouts and `BUILTIN_PALETTES` are the canonical sources of truth; cloned or imported user themes and their colors are never deleted or overwritten. `verify:liquid-gallery` verifies shared gallery compatibility through a user-theme copy fixture at [liquid-gallery.ts](../../tests/fixtures/liquid-gallery.ts).
- **Backup boundary and scope**: Theme JSON stores layout original colors and excludes separate palettes and scope bindings (preserved in workspace SQLite backups), and theme edits/deletions never alter manuscripts or model inputs. Expression panels, BGM, TTS, and input translation are out of scope; verification commands and `UIMORI_NARRATIVE_DEMO_DIR` live in [DEVELOPMENT](DEVELOPMENT.md#builds-and-evidence) and [DEVELOPMENT](DEVELOPMENT.md#verification-runners).

## Usage report and backfill

- **Lightweight `attempts` ledger**: Stores only call timestamps, purposes, test flags, and compact numeric estimate columns; usage queries never read manuscripts or prompt JSON, and deletion cleanup leaves numeric columns intact without loading or parsing request/response bodies in JS.
- **Deferred settlement and classification ownership**: Minimal frozen pricing metadata is kept only while an in-flight call awaits late settlement. Collaborative `agentId` and helper `purpose` are classified by the host; model output never alters billing classification.
- **Backfill (`backfillUnpricedCalls`)**: Estimates only unpriced historical calls lacking provider-reported cost so recorded prices are never rewritten retroactively; usage totals recompute from call records immediately while saved task totals stay unchanged. Pricing tool schemas live in `HELPER_PRICING_TOOLS`, and operational pricing/reporting rules (`시각 미확인`, search fees) live in [USAGE-REPORT](../USAGE-REPORT.md#추가-집계-규칙과-단가-소급-적용) and [HELPER-TOOLS](HELPER-TOOLS.md#web-search-and-model-pricing).
- **Read-only query boundary (`usageRoutes`)**: Auth-gated read-only queries never trigger model calls, price re-fetches, or scheduled jobs. Cross-cutting pricing and UI layout regressions are verified by `tests/pricing-store.test.ts` and `SPUI` in `tests/settings-polish-browser.spec.ts`.

## HTTP compression, private ETag and maintenance mode

- **Compression (`registerResponseCompression`)**: Hashed `/assets/*` serve 1-year `immutable` with prebuilt `.br`/`.gz` copies (`vite.config.ts`), while `index.html`, service worker, and manifests retain existing headers without precompressed copies. JSON and text API responses of at least `COMPRESSION_THRESHOLD_BYTES` (1 KiB) compress with Brotli (`BROTLI_QUALITY = 4`) or gzip; SSE, images, fonts, and archives stay uncompressed.
- **Private ETag (`revalidatePrivateJson`)**: Attaches `ETag` and `Cache-Control: private, no-cache` on authenticated `GET` responses for `REVALIDATED_ROUTES` only, returning `304` when unchanged.
- **Maintenance boot boundary (`maintenanceRoutes`)**: `UIMORI_MAINTENANCE=1` permits DB entry and reads without task recovery or workers and cannot be opened via API (`409 MAINTENANCE_BOOT`). Because SQLite is not opened read-only, always verify against a DB copy rather than the sole production DB; operational procedures live in [SELF-HOST](../SELF-HOST.md#유지보수-모드), [UPDATES](../UPDATES.md#유지보수-모드), and [ORACLE-RELEASE](ORACLE-RELEASE.md).
