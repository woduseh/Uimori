# App storage, editing, outline, search, reading, PWA, I18N, themes and usage

Developer-only technical sections extracted from `docs/DATA-MIGRATIONS.md`, `docs/DELETION.md`, `docs/AUTOMATIC-BACKUPS.md`, `docs/CHAT-BACKUP.md`, `docs/CHAT-TRANSCRIPT.md`, `docs/NATIVE-TRANSFER.md`, `docs/EDITING.md`, `docs/OUTLINE.md`, `docs/STORY-GUIDE.md`, `docs/STORY-UI.md`, `docs/MANUSCRIPT-SEARCH.md`, `docs/READING.md`, `docs/READING-STATE.md`, `docs/TURN-ACTIVITY.md`, `docs/PWA.md`, `docs/I18N.md`, `docs/THEME-AUTHORING.md`, `docs/USAGE-REPORT.md`, `docs/SELF-HOST.md`, and `docs/UPDATES.md`.

## Personal workspace schema 15 and startup upgrades

Every time the server opens the DB, it upgrades only rows still in a legacy shape to the current shape in a single transaction (`server/stored-shape-upgrades.ts`). It does not change revision numbers, and it does not rewrite rows that are already in the current shape. A DB restored from a full backup goes through the same normalization the first time it is opened.

- **Auto-title registration language**: `chat.title.eligible` records that stored a chat ID instead of a language are converted to Korean (`ko`).
- **Helper confirmation arguments**: Call arguments are cleared from pending calls that can no longer be confirmed and from confirmation calls received by finished or retried tasks ([Helper tools](HELPER-TOOLS.md#confirmation-before-destructive-or-bulk-operations)).
- **Helper limits and input measurements**: Removes `artifacts` from conversation limits and task-snapshot limits, and copies the model limit from the task snapshot into input measurement records that lack `inputTokenLimit` when available.
- **Illustration settings, presets, reference images and task inputs**: Backfilled as described in [Illustration presets](../DATA-MIGRATIONS.md#삽화-프리셋) and [Paragraph illustrations](../DATA-MIGRATIONS.md#문단-삽화).
- **Removed evaluation tool settings**: Strips `maximumToolRounds`, `terminalLateCorrections`, and `outputRecovery` from model preset `evaluationTools`. Thereafter, evaluation configs containing these fields are rejected on both save and validation.
- **Legacy chat copy records**: Older copy records without a recorded copy command are left unmodified and are no longer used for recovery. Retrying a copy with that record's request key returns `CHAT_COPY_RECEIPT_UNVERIFIED` (409) and clears the leftover request key in the browser so the next attempt creates a new copy.

- **Single head and removal of branch tables**:
  - Each chat is the sole owner of its manuscript head and execution state; the `branches` table, `branch_id` column, and API `branchId` have been completely removed.
  - The current head revision number is stored in a single place: `chats.head_revision`.
- **Concurrency and idempotency guarantees**:
  - Strictly maintains task owner/generation tracking, revision-number CAS conflict prevention, blocking of late saves after cancellation, and request-key deduplication.
- **Schema 15 on-demand tables**:
  - `helper_seed_messages`: Created automatically on demand at server startup to preserve dialogue cloned from past helper session forks.
  - `execution_tool_diagnostics`: Created on demand to store lightweight diagnostic metadata linked by ownership to main writing, translation, and illustration tasks (does not replace replay receipts in `tool_events`).
  - `image_cleanup_candidates`: Deferred cleanup queue table holding hashes of orphan images that cannot be deleted immediately due to active tasks.
  - `helper_changes`: One change record per helper task and target, storing the pre-edit state (`baseline`) and UI change items (`entries`), deleted alongside `helper_tasks`. Because turn rollback restores from `baseline`, it stores the full target state. `result` is the hash of the final state left by the task, `foreign_edit` records whether another party saved the same target during the task, and `rolled_back_at` is the rollback timestamp. Rows created before these columns existed have an empty `result` and are not eligible for rollback.
  - `theme_assets`: Stores theme font and image originals by hash. Retained while referenced by a saved theme, its undo copy, or a retained helper change record; uploads unused by any save are cleaned up on server startup after one day. Kept separate from user fonts (`font_assets`) and body images (`image_blobs`).
  - `search_trigrams`: Trigram index for manuscript search. Because it is derived data rebuildable from manuscripts, it is created on demand on server startup without bumping the schema version. Remaining rows in the legacy index (`search_fts`) are migrated in small chunks on idle ticks when no indexing work is pending, and `search_fts` is emptied once all rows are migrated. Search behavior during and after migration is owned by [MANUSCRIPT-SEARCH](../MANUSCRIPT-SEARCH.md).
- **Metadata key conventions (`app_metadata`)**:
  - `source-title:<sourceId>`: Stores optional scene names.
  - `illustration-presentation:<sourceId>`: Stores representative/display selection and translation placement for paragraph illustrations.
  - `helper-read:v1:<conversationId>`: Last seen task-result event sequence number for a helper conversation. Because it is a new key, it requires no existing DB migration.
- **Helper call-limit interface**: `HelperLimits` uses only `totalCalls` and `helperCalls`; the deprecated `artifacts` field is excluded.

## Deletion, unused-data reclamation and helper cleanup

- **Orphan image reclamation queue**: Inside deletion and save transactions, `server/unused-data.ts` follows real resource references to clean up reclaim-candidate orphan image BLOBs and unused hidden entries. Neither Reader queries nor per-chunk model output scans all stored resources.
- **Deferred physical reclamation and DB candidate hashes**: While a model or image task is in flight, physical reclamation is deferred while candidate hashes are persisted in `image_cleanup_candidates`. Candidates are reprocessed on task completion and server restart; when there are no candidates and no hidden entries, full manuscripts are not scanned. Task-completion cleanup (`PendingImageCleanup`) runs the reference scan in a read-only Worker (`server/unused-data-scan.ts`); if even one write occurred on the main connection during the scan, the result is discarded and re-scanned on the next task completion. Cleanup inside deletion transactions and on server startup runs the same check synchronously.
- **Draft protection and image-reclamation exceptions**: Normal deletion adds cleanup candidates only for images referenced by the deleted resource. Images that appeared only in helper conversation text and individual illustration deletions do not add separate image cleanup candidates, because an unsaved draft in another editor window may still reference the same image. Cleanup for images directly attached by the helper and existing deletion cleanup for other resources remain in place, and images marked as cleanup candidates by another operation can still be reclaimed after the reference scan.
- **Snapshot reference handling**: References held only by historical diagnostic snapshots are not grounds for permanent retention; once the last live reference is removed and a resource is marked for reclamation, deletion/save cleanup reclaims it.
- **Helper change records**: In `server/helper-changes.ts`, scene deletion calls `forgetHelperSceneChanges`, resource deletion calls `forgetHelperResourceChanges`, chat deletion calls `forgetHelperChatChanges`, and helper conversation deletion calls `forgetHelperConversationChanges` before cascading deletion. Retention bounds are enforced on task admission, on record write, and when the server opens the DB. Every path that discards a prior state (retention pruning, and scene, resource, chat, or helper conversation deletion) inserts images referenced by that prior state into `image_cleanup_candidates` and prunes theme assets via `pruneThemeAssets`. Records whose text was cleared are not deleted as whole rows so the task result list still shows what changed.
- **Helper call arguments**: In `server/helper-argument-retention.ts`, scene, chat, library resource, theme, and illustration preset deletion call `forgetHelperConfirmationTargets`, and scene and chat deletion call `redactHelperArgumentPreviews`. Records in other conversations are located via the target scene and `chatId` stored on tool-call records and via `chatId` and `targets` on confirmation records. Calls that touched a chat via a shell command such as `uimori apply` leave only the command string and are not matched by this method.
- **Related files**: `server/scene-deletion.ts`, `server/orphan-memory.ts`, `server/unused-data.ts`.

## Automatic backups

- **Storage path and Docker volume setup**:
  - The `UIMORI_BACKUP_DIR` environment variable sets the server backup directory. When unset in a local install, it defaults to the `backups` subdirectory under the DB directory.
  - Both provided Docker Compose examples mount `UIMORI_BACKUP_VOLUME` (default `uimori_backups`) separately at `/backups`. Keep the same backup volume even if switching the data volume.
  - New container images automatically prepare UID 1000 ownership on the initial backup directory. When directly bind-mounting a pre-existing host directory, the operator must provide container write permissions.
  - Deployment-pipeline-specific backups are managed independently of this feature's retention policy.
- **SQLite online snapshot and verification worker**:
  - After creating a SQLite online snapshot, a separate Worker thread verifies `quick_check`, foreign keys, DB format, and schema version.
  - File size, SHA-256 hash, and app/build version are recorded in the manifest, and the working directory is atomically switched to the completed directory before marking success.
  - Older successful backups are never pruned before a new backup succeeds. On disk-space or permission failures, existing successful backups are preserved and the failure is surfaced.
  - Incomplete `.partial-*` temporary directories and unrelated operational files are excluded from the valid backup list and automatic pruning.
- **Backup API endpoints**:
  - `GET /api/backups`: List backups.
  - `PUT /api/backups/settings`: Save backup settings (requires `expectedRevision`).
  - `POST /api/backups`: Trigger an immediate backup (returns 202 Accepted).
  - `GET /api/backups/:id/download`: Download a specific backup file.
  - The existing one-off download endpoint `GET /api/backup` is preserved. None of the endpoints accept filesystem paths as request arguments, and all reuse existing workspace auth and maintenance gates.
- **Test suite**:
  - `npm test -- tests/backup-service.test.ts tests/database-schema.test.ts tests/personal-workspace-flow.test.ts`
  - Verifies reopening temporary SQLite copies, preservation of images/manuscripts/settings, retention of existing backups after a backup failure, scheduling, revision CAS, duplicate-request prevention, API auth, and maintenance gates (actual Docker volume switches and physical disk failures are separate operational verification items).

## Independent chat backups and copies

### `.chat.uimori` archive structure and BLOB deduplication
- **File format**: Uncompressed ZIP container using `uimori-archive` version 1.
- **Internal layout**:
  - Root `uimori-personal-chat` v1 metadata JSON.
  - Image binaries at `images/<SHA-256>.bin`.
- **BLOB deduplication**: Resource avatars/representative images, body-attached images, and scene-displayed illustrations are keyed by byte hash (SHA-256), storing identical bytes only once inside the ZIP.
- **Atomic registration**: After uploading the file to the server, validating images, and converting to WebP, a review summary is returned and confirmed imports are registered atomically. Large images are never serialized as base64 JSON strings.
- **API contract**: New chat backups are generated only in archive format. The legacy JSON export API `GET /api/chats/:id/backup` has been removed and returns 404 (restoring existing JSON backup files remains supported). Transcript JSON export for manuscript exchange remains a separate feature.
- **Multi-chat compatibility**: Exports contain only the single selected chat, while preserving the metadata `chats` array structure so legacy multi-chat independent backup files still restore cleanly.

### Staging file lifecycle and concurrency protection
- **Staging cleanup**: Temporary files created during staging are cleaned up immediately upon successful restore.
- **Expiration policy**: Incomplete staged results expire after 24 hours and are cleaned up automatically at write-enabled server startup and hourly while running (a completed identical request remains verifiable via its receipt even after temporary files are gone).
- **Concurrency lock**: Backup staging does not run concurrently with Risu file imports or resource-bundle backup staging; staging runs sequentially, 1 job at a time per process. If the client disconnects, in-progress staging artifacts are cleaned up immediately.
- **Image reference counting**: Independent copies and restores reuse immutable BLOBs without depending directly on the source chat's image rows. Deleting the source chat preserves images referenced by copies, and BLOBs are reclaimed through the existing image-cleanup path once the last owning reference is removed.

### Retry and copy API (`/api/runs/:id/retry`)
- **API endpoint**: `POST /api/runs/:id/retry`.
- **Parameters**: `mode` is `'replace'` or `'copy'` (omitting it applies the existing copy-creation rule). Retrying a failed replace request reuses the last response already reserved as the replacement target.
- **Idempotency guarantees**: If an error occurs while checking a copy result, the previous request key is preserved to prevent duplicate copies. If the target copy has already been deleted or the record is a legacy copy record without a recorded copy command, the client notifies the user and clears the leftover request key so the next attempt starts a fresh copy.
- **No external side effects**: Restoring never re-executes external model calls or Risu card callbacks.
- **Related implementation**: `server/chat-backup.ts`, `server/chat-copy.ts`, `server/chat-fork.ts`, `server/run-retry.ts`, `server/chat-media.ts`.
- **Full workspace restore**: Use [DB snapshots](../DATA-MIGRATIONS.md) for full workspace recovery including API keys and providers, and see [Reading position and bookmarks](../READING-STATE.md) for per-device reading position and bookmark integration.

## Chat transcript import/export

### Internal modules and transaction guarantees
- **Implementation files**: Format definition and validation live in `core/chat-transcript.ts`; database storage and persistence live in `server/chat-transcript.ts`.
- **Atomic failure handling**: File format, target scenes referenced by memos, text size limits, and existence of the linked bot are validated upfront. On validation failure, the transaction rolls back immediately without leaving partial chats or records behind.
- **Full workspace restore**: Use [SQLite backups](../DATA-MIGRATIONS.md) rather than this format to restore an entire workspace.

### Transcript test and verification commands
```sh
npm test -- tests/chat-transcript.test.ts tests/personal-workspace-flow.test.ts
```

- `tests/chat-transcript.test.ts`: Verifies originals, translations, memos, duplicate resend requests, and rejection of malformed files.
- `tests/personal-workspace-flow.test.ts`: Verifies continuing conversations linked with independent backups and overall workspace chat flows.

## Portable resource transfers

- **Retirement of legacy export API**: New backups are generated only as `.uimori` archives; the legacy JSON export API `POST /api/native-transfers/export` has been removed and returns 404.

### Internal modules and separation of responsibilities
- **Resource bundle handling**: `server/resource-bundle.ts` owns serialization and workspace application of user resource bundles.
- **Image conversion**: `server/transfer-images.ts` is solely responsible for WebP conversion and SHA-256 reference substitution for images inside bundles.
- **Receipts and history**: No separate receipt system is maintained for arbitrary replay or attestation of full execution history; exports contain only the currently saved resource state.

### Two-stage atomic apply pipeline
1. **Pre-validation and staging**: Checks the uploaded `.uimori` file's table of contents, CRCs, and image SHA-256 integrity, converts and stages images one by one, and returns a review summary to the user.
2. **Atomic registration**: Upon user approval, registers the staged binary files sequentially. Validation results and summaries from the review step are reused directly without re-validating the archive or re-converting images at apply time.
3. **Transactional save**: New resource records and duplicate-request prevention receipts are saved atomically in a single transaction.
4. **Streaming export**: Export streams images directly one by one from a read-only DB snapshot, so concurrent resource edits or image cleanup in other sessions cannot corrupt the downloaded bytes.

### Concurrency lock and staging file lifecycle
- **Sequential lock**: Risu file imports and `.uimori` backup staging run sequentially, 1 job at a time across the server process. If another staging job is in progress, no queue is built up and the caller is instructed to retry once it finishes.
- **Client disconnect handling**: If the client network connection drops, staging cancels immediately and cleans up temporary artifacts (any image conversion already started discards its result upon completion and does not proceed to the next image).
- **Expiration and periodic cleanup**:
  - Staging files are cleaned up immediately upon successful import.
  - Incomplete staged results expire automatically after 24 hours.
  - Expired staging files are cleaned up at write-enabled server startup and in an hourly periodic job (cleanup failures retry on the next cycle).
- **Safe directory isolation**: Cleanup of uploads and staging outputs is restricted strictly to subdirectories of the directory where the SQLite DB file actually resides. Symlinks and junctions are never touched, and active in-progress staging outputs are preserved.

### Idempotency receipt retention policy
- **General resource receipts**: Retains the most recent 256 general resource import receipts to prevent duplicate processing.
- **Long-term retention**: Chat backup, transcript, and Risu import completion receipts as well as retry receipts are excluded from this 256-entry rotating prune, preventing prior import requests from creating duplicate chats or generations even after many subsequent general resource imports.

## Resource editing, recovery, selection revision and helper changes

- **Touch-selected text**: The action bar also appears for text selected via long-press on mobile. Because the browser's selection menu and handles appear directly above and below the selection, the bar docks to the bottom edge of the reading area rather than beside the selection, moving to the top edge if the selection covers that area (`placeDocked` in `web/reader-selection.ts`). While handles are being dragged, the bar waits until the selection settles. Even if the browser clears the selection the moment a button is tapped, the action runs against the selection captured immediately before the press. `RSEL22` in `tests/reader-selection-browser.spec.ts` verifies this with synthetic touch input.

### Input state and session ownership (`ResourceEditorSession`)
- **Single owner**: Each resource editor has a single `ResourceEditorSession` instance (`web/resource-editor-session.ts`) that exclusively owns the form model, raw text input, saved baseline, dirty state, and save progress. The UI reads the session model directly and updates state via functional updates, with no sync loop copying a restored model into parent state and back into the session.
- **Role and preset switching**: Switching prompt roles or presets only holds and selects sessions without duplicating the model or dirty flags separately.
- **Load lifecycle protection**: Starting a new prompt draft or returning to the list while a prompt is loading cancels the prior fetch. Late responses cannot overwrite a new draft or the current screen; opening from the list and opening an externally specified preset share the same fetch lifecycle.
- **Auto-save scheduling**: Auto-save for current prompt options is scheduled only on fresh edits. Recovered input and failed saves must be saved explicitly again, and a save response never overwrites edits typed after submission. Saving a new resource or copy migrates the recovery entry key to the actual resource ID. Recovery save ordering, revision checks, ignoring stale load responses, and capturing input at helper request time are preserved for data safety. Save notifications from another window refresh a clean editor, while preserving unsaved input and reporting a conflict if dirty.
- **`Esc` in original/translation editors**: If the draft differs from the saved copy, prompts before discarding; choosing Cancel keeps the draft and this tab's stored recovery copy and returns to the editor. Closes immediately if unchanged. The **편집 취소** (Cancel edit) button discards the draft without prompting.
- **Scroll and focus restoration**:
  - Opening original/translation editing scrolls only the Reader and the designated theme body. After saving or canceling, it restores the reading position and focus on the trigger button without scrolling the app header or composer.
  - On narrow viewports, the scroll-to-bottom button lives in the composer toolbar. It hides while editing an original, translation, or request, and reappears when editing ends according to navigator visibility settings and current reading position. The scene list in the top title and bookmark editing remain usable throughout.

### Local recovery storage (IndexedDB)
- **Async isolated persistence**: Typing does not synchronously write the entire resource to `localStorage`. Only the latest unsaved input on this device is asynchronously overwritten in IndexedDB. Recovery-saved status is shown only when persistence actually succeeded; failures are never displayed as success.
- **Transactional conflict avoidance**: Saving, canceling, and reverting to the saved baseline clear only recovery entries that this editing session read or successfully wrote. Comparing each save's identifier inside a single IndexedDB transaction prevents wiping unsaved input written later by another tab.
- **Partial path updates**: Regular form edits allocate new objects only along the changed field's path and skip unchanged subtrees during dirty checks, avoiding cloning or JSON-serializing large cards or presets on every keystroke. Reverting card edits back to match the saved copy does not block navigating back to the list, while raw JSON display/apply and save-boundary validation remain intact.
- **Helper and generation pending queue**: On a helper request, a saved resource sends only its ID and revision number so the server captures that saved version at admission time; an unsaved resource sends the editor input at send time for analysis. For the helper to edit that same resource, it must first be saved in the editor (without blocking operations on other resources). Helper input and pending requests share the existing IndexedDB recovery store. If recovery persistence fails, the input is preserved and the user can retry or send without recovery storage (requests sent without recovery storage may not be recoverable after a reload).

### Concurrency control and idempotency guarantees
- **CAS revision number (`expectedRevision`)**: Both the user and the helper agent go through the same `saveResource`. Comparing a single current resource revision prevents overwriting concurrent changes, forcing re-fetch and re-apply on conflict. Even if a subsequent save fails, an existing revision-conflict warning stays active and clears only after an actual copy-save succeeds or an explicit reload occurs. This is not an agent permission-approval mechanism.
- **Idempotency keys and receipts**:
  - Browser new-resource saves and list clones record per-request idempotency keys and reuse the original payload and key when re-running an uncertain request so duplicate copies are not created.
  - The server permanently retains only small created-ID receipts with no DB schema change. Unconfirmed requests from a new-resource editor live in a per-tab IndexedDB record separate from general unsaved input. Even if new edits contain errors, the original creation request is re-verified using only its already-frozen payload, leaving the new edits intact afterward.
  - Requests explicitly rejected by the server can be edited and sent as new requests. Legacy API clients or manual creation requests that omit the key keep the existing non-idempotent behavior. Cloning checks the source revision number and copies the entire saved content to a new ID without including unsaved edits, leaving the original and its active bindings unchanged. The helper can apply display name, body, and block additions, deletions, and moves to the returned copy ID in one call. A prompt's library display name and native internal name are independent. Structural edits also use revision checks and single-previous-version undo.
  - After a creation or clone outcome becomes uncertain, the original request key is kept even if a verification retry hits an error such as expired auth. Even while new edits in the editor are incomplete, **이전 요청 확인** (Check previous request) checks the frozen creation request while keeping the new edits intact. If another window edited the created resource before verification, subsequent edits stay in a conflict state awaiting inspection of the saved copy or an explicit reload. If the server confirms the creation receipt's target has already been deleted, the edits are kept and the user can save as a new resource.
- **Folder placement and decoupling follow-up work**:
  - Folder placement for a newly created resource checks the library-organization revision from right after creation. If another window changed organization before verification, or if a legacy receipt lacks a revision, automatic moving is skipped with a notice so it never overwrites a folder or uncategorized placement made in another window.
  - List refresh and post-save folder placement are decoupled from save completion. If follow-up work fails after a preset, provider, or model is saved, the saved copy is preserved and post-save navigation finishes with a separate warning. Actual save failures or revision conflicts retain the input and block navigation, and follow-up failures never auto-retry the write. Resource change events refresh only chats depending on that resource or its linked modules. Input state is owned by `web/resource-editor-session.ts`; the shared save path for API and agent lives in `server/resource-service.ts`.

### Internal data structure for context control (`scene_context`)
- **Separate table storage**: Context toggles are stored with a revision number in `scene_context`, separate from the original Run/Source rows. Subsequent general model context, compaction summaries, search, and helper reads of the current chat reflect this state.
- **Context validity checks**: Because editing input visibility does not alter the original text hash, context-compaction validity also incorporates the scene-context revision number.
- **Copies and backups**: Chat copies, chat backups, and the optional `sceneContext` field in transcript v2 preserve this state. Legacy transcript v2 files without the field are read with all scenes active. Editing or inspecting original execution records or explicitly requested preserved scenes is a separate concern.

### Selection revision and in-reader refinement
- Proposal requests, cancellation, and changed-proposal detection are shared between editor `web/SelectionRevision.tsx` and reader `web/ReaderSelectionTools.tsx` through a single hook, `web/useSelectionRevision.ts`. Both use the same server route `POST /api/sources/:id/selection-revision` (`server/selection-revision.ts`); translation targets send `target: 'translation'` and the hash of the displayed translation text. That check is shared with translation saving (`editTranslation`) via `shownTranslationChanged` in `server/source-editing.ts`, because the shown translation may still be the prior result while re-translation is in progress, making revision number alone insufficient to identify the displayed text.
- Context scope is passed in the request's `context` field and sliced by `surroundingDraft` in `core/selection-revision.ts`. The client still sends the entire draft regardless of chosen scope because the server verifies both the translation hash and the selection range against the full draft.
- Match detection uses `uniqueTextRange` in `web/reader-selection.ts` and decides solely by comparing against the saved body. It does not gate on renderer type because every chat with a bot renders through the Risu renderer. Unlike the helper's `matchHelperText`, it does not normalize trailing line whitespace, preventing saves when the visible selection diverges from the saved body.
- The bar and popover are app UI rendered at a fixed position on `document.body`. Because scene theme frames use Shadow DOM and themes may apply `transform`, placing them inside would break positioning. Coordinates are computed within the visible region of the reader scroll area and the theme's internal scroll body (`data-uimori-body-scroll`), placed above or below without overlapping the selected line; the bar hides if neither has room.
- Verification: `tests/reader-selection.test.ts` (matching rules), `tests/selection-revision.test.ts` (translation targets and conflict checks), `RSEL01`–`RSEL06` and `RSEL15` (context scope) in `tests/reader-selection-browser.spec.ts`, and `tests/selection-revision-browser.spec.ts` for the editor side.

### Helper change card (`HelperChangeCard`)
- Cards are rendered by `web/HelperChangeCard.tsx`, the list and read timestamp are managed by `web/HelperTaskResults.tsx`, and entry semantics are documented in [HELPER-TOOLS](HELPER-TOOLS.md#conversation-history-and-task-results). `HCHANGE01` and `HCHANGE02` in `tests/helper-task-results-browser.spec.ts` verify rendering and read timing, and `HCHANGE04` verifies location labels following the UI language.
- Result lines (`results`) and change cards (`changes`) form a single list. Result lines are hidden for resources and scene names that have a change record; settings keep their result line showing old and new values and hide the matching change card. Tasks predating change records have only result lines and continue displaying as before.
- Navigation is dispatched by domain in `openHelperChange` (`web/main.tsx`). Resources pass section and item via the context in `web/resource-anchor.ts` to the opened editor (`RisuNativeFields`, `NativeRisuPresetEditor`), which clears it once consumed. Scenes translate `ReaderTarget.changedParagraph` in `web/useStory.ts` into a block anchor and offset ratio and jump through the existing reading-position restoration path. Highlighting is owned by `web/arrival-mark.ts`, outlining the block anchor element or editor section rather than body text characters. Verified by `HCHANGE03`.
- Diff additions and deletions use semantic color tokens (`--success-bg`, `--error-bg`), paired with underline, strikethrough, leading `+` and `−`, and screen-reader labels so color is never the sole indicator. Maximum height is `--diff-max-h`.

### Helper turn rollback
- `server/helper-rollback.ts` is the single path for reverting library resources, scene originals and translations, outline items, and author notes changed by a single helper task back to their pre-task state. Contract and skip reasons are in [HELPER-TOOLS](HELPER-TOOLS.md#rolling-back-a-helper-task).
- Rollback passes through the same save functions as normal saves, so revision checks, translation-job invalidation, and cross-window refresh notifications match user saves, and a reverted resource can be undone again via the editor's single-step undo (`resource_undo`).
- Targets edited afterward by the user or another task are skipped with a reason returned. Because the server cannot see unsaved edits in open editors, the client inspects `touches` and blocks those units. Resource editors check via `hasUnsavedResourceEditor` in `web/resource-editor.tsx`; original/translation editors, outline item editors, and author-note editors register unsaved edits in `web/unsaved-input.ts`. Any new editor holding input for a rollback-eligible domain must register there.
- UI lives in `web/HelperTaskRollback.tsx`. When any unit is blocked, it sends remaining units individually instead of a whole-task rollback request. After rollback, open views refresh via `uimori-helper-updated` for resources, `OUTLINE_REFRESH_EVENT` for outlines, and server-emitted chat events for scenes and author notes. Verified by `HROLLBACK01`–`HROLLBACK03` in `tests/helper-browser.spec.ts`.

### Helper partial edits and string replacement algorithm
- **Block reference tracking**: Helper partial edits reference previously read blocks so they still target the same block even after earlier items are deleted or moved.
- **Line-ending and trailing-whitespace tolerant matching**: String replacement in resources (`resource.patch`) and scenes (`scene.patch`) tries exact match first; only when none is found does it tolerate CRLF/LF differences, and only if still unmatched does it tolerate trailing spaces and tabs. Relaxed tiers apply only when matching a single unique location; on zero or multiple matches, it returns the mismatch location and reason without saving anything. Punctuation such as quotes and dashes is never normalized because doing so would silently alter prose style. Both tools share a single matcher, `matchHelperText` in `server/helper-resource-editing.ts`, verified by `tests/helper-resource-editing.test.ts` and `tests/helper-scene-tools.test.ts`.
- **Toggle definition integrity**: When toggle definitions change, newly invalid existing selections are cleaned up and the removed or reset keys are reported. Newly supplied invalid values are rejected rather than silently coerced.
- **Previous-save comparison**: The single retained previous save can also be read for comparison without saving. Multi-step resource history and continuous synchronization between cloned presets are not provided.

## Outline workspace and writing pipeline

The five outline levels use `OUTLINE_LEVELS` in `core/outline.ts`.

### Writing context assembly and pipeline

- **Brief assembly API**: `GET /api/outline-nodes/:id/brief` assembles context programmatically directly from persisted data (no model call).
  - `path`: Ancestor path from the existing root down to the current node.
  - `children`: Direct child outline items of the current node.
  - `related`: Explicitly linked related outline items (deduplicated).
  - `neighbors`: Immediate previous and next siblings under the same parent at the same level.
  - `sources`: Up to the 40 most recent current-branch manuscript entries linked to this node or its descendants, with ID, current hash, owning node, and link kind (`planned`/`focus`).
  - During an actual Run execution, up to 40 other nodes that have manuscripts in the Run lineage are also included as `written`.
- **Context injection path**: `RunSnapshot.outline → MainInput.outline → main-host-context`. Reuses the existing main-writing input path; this context does not replace the current user request, actual manuscript, memos, or lore, and must pass the final input token budget check. It neither dumps the entire outline unconditionally nor silently drops critical constraints that exceed the budget.
- **Scene reservation and admission**:
  1. `POST /api/outline-nodes/:id/scene-command` creates an outline-linked scene request, passing separate `additionalInstruction`, target revision number, and plan hash so stale requests cannot bind to a modified plan.
  2. `POST /api/scene-commands/:id/run` schedules the actual prose generation. There is no separate outline-only writer executor, and helper outputs are never auto-promoted into the main story.
  3. The current outline and additional instructions are frozen together at Run admission, preserving the single writer, cancellation handling, and manuscript save boundaries.
  - No API or separate queue UI is provided for creating, canceling, or deleting standalone scene reservations detached from an outline.

### Reservation cancellation, idempotency and change detection

- **Canceling unexecuted reservations**: If an unexecuted reservation's ancestor path, direct children, or explicitly related plans change substantively, that reservation is immediately canceled in the same save transaction (sibling-only edits, revision-only bumps, and rolled-back changes do not cancel it; already-admitted Runs retain the input captured at admission).
- **In-progress focus API**: `GET /api/chats/:id/outline/focus` returns the active focus node, and `PUT` with `{ "nodeId": "..." }` or `{ "nodeId": null }` sets or clears it. Because it overwrites the value directly, repeating the same request is idempotent. On normal Run admission (`run`, `preview-main`) outside a scene reservation, `freezeOutlineFocus` freezes the active focus node, and `linkFocusSource` records a `focus` link inside the manuscript commit transaction.
- **Idempotency keys and recovery**: The browser persists outline-save and writing request bodies and keys locally before sending. If the response is lost in transit, **요청 결과 확인** (Check request result) checks the processing status of that exact request rather than issuing a duplicate execution. An original key is valid only for its original outline or scene request; reusing a key with a different target or payload is treated as a conflict.

### Helper tool contracts (`outline.read`, `outline.write`)

- **`outline.read`**:
  - **Modes**: Default `overview`, `subtree` for a specific `nodeId`, and `detail` for a single item. `overview` also returns `focusId` for the active in-progress item.
  - **Subtree depth**: `depth` (`0` = selected item, `1` = direct children, omitted = all descendants).
  - **Detail sections**: `detail` `section` is `intent`, `related`, or `writings` (actual manuscript references for the selected node and its descendants).
  - **Units and limits**: All modes use `offset/limit`. For `intent` reads, omitting `limit` returns an estimated 3,000 local tokens, while an explicit `limit` is interpreted as up to 10,000 UTF-16 code units. Body offsets and returned coordinates are always in UTF-16 units; `intentCodePoints` in overview counts SQLite Unicode code points.
  - **Consistency validation**: Every page returns the `version` of the queried scope, exact returned range, and `nextRead` for continuation. Continuation reads pass `expectedVersion`; if the outline changed, the tool returns `OUTLINE_CHANGED` along with a re-read path.
  - **Coverage indicators**: `coverage.wholeField` indicates only whether this single response contains the entire field (e.g., the final 600–841 slice of an 841-character field returns `wholeField: false`, `nextOffset: null`). `coverage.excludedByDepth` indicates items omitted by the depth cap.
  - **Response size ceiling**: Assembled within a local estimate of 12,000 tokens including JSON metadata.
- **`outline.write`**:
  - Atomically applies up to 200 `create`, `update`, `move`, and `remove` operations in a single call. `update` can also change `level`. New items can build a hierarchy in one call using `ref`/`parentRef`.
  - Model return payload: Returns `operationId`, `applied`, `atomic`, `created`, `changes`, and `revisionAfterOperation` rather than full detail objects.
  - Commit verification: Confirmed receipt ID, timestamp, and tool/call ID can be verified in `committedEffects` of `task.inspect(kind:"helper")`.

### Review technical contract

- **Read-only restriction**: On **원문과 점검** (Review against manuscript) requests, app tools are restricted to `outline.read` and existing manuscript/lore reads; write tool calls are strictly rejected. No separate approval system or dedicated review agent is introduced.
- **Initial context budget**: Consists of a compact overview of the selected outline, continuation read paths, and short excerpts from up to the 3 most recently linked manuscripts in the current branch. Review does not start if the current branch has no linked manuscripts. Initial manuscript excerpts use at most 1/8 of the input budget and no more than 1,500 estimated tokens, setting the `partial` flag when truncated.
- **Data retention**: No separate persistent review table is maintained; review outputs and evidence remain in helper conversation history and task records.

### Database schema and data preservation

- **Table layout**: Outline nodes and edit receipts live in `outline_nodes` and `outline_batches`; related outline links and manuscript links live in `outline_links` and `outline_writings`; per-chat active focus lives in `outline_focus`. `outline_writings.origin` distinguishes planned writing (`planned`) from normal requests under active focus (`focus`). Existing `outline_reviews` and internal scene-command data are preserved ([Data policy](../DATA-MIGRATIONS.md)).
- **Single source of truth**: Only a single copy of each outline and manuscript is stored. Large input payloads from succeeded executions are pruned per retention policy, leaving only essential metadata (revision number, hash, source references).
- **Copies and backups**: Independent copies and portable chat backups recreate outline content, hierarchy, order, invariants, related links, and active focus under new IDs. Only actual manuscript links created prior to the copy are remapped to new source IDs while preserving link kind and order; completed Runs, reservations, receipts, and helper review tasks are not cloned.

### Outline verification and scope

- **Test files**: `tests/outline.test.ts`, `tests/helper-outline.test.ts`, `tests/helper-workspace.test.ts`, `tests/database-schema.test.ts`, and `tests/side-panel-browser.spec.ts` for the right-panel outline tab.
- **One component, two layouts**: The outline tab and full-screen view are the same `OutlinePanel` instance (`layout` is `sidecar` or `workspace`). `web/main.tsx` renders it in one place and toggles visibility only so selection and in-progress edits survive tab switches or expanding to full view; no second narrow implementation is built.
- **Verification command**: `npm run verify:outline` (checks outline editing, writing, helper handoff, and review flows at 390px and 1440px viewports against a synthetic provider).
- **Regression checks**: Verifies constant SQL query count for browser list/detail queries as outline size grows, consistency of manuscript/order/progress state, and immutability of preserved review data.
- **Out of scope**: Automatic replanning, multi-chapter automatic writing, shared outline templates, graph editors, and new memory-extraction systems are outside the scope of this workspace.

## Original-work reference (Story Guide)

### Execution pipeline and cache policy

- **Context composition**: Automatic reference generation receives the user/model conversation, current summary, character card, persona, lorebook, card example dialogue, author memos and author notes, the hierarchical outline for this turn, and the user request. Card example dialogue is used strictly as tone reference and never treated as events that actually happened. On regeneration, the response being replaced is excluded from the input.
- **Call structure**: Normally completes in 1 model call. Only when additional manuscript verification is required does it execute 1 batch of existing read tools before producing the final answer. Execution call budgets required for main writing and refusal detection are guaranteed. Reference-generation calls are logged under original-work reference in the usage screen.
- **Cache reuse conditions**: A stored reference is reused only when the input context, settings, model, and reference prompt match identically. Results written after reading additional manuscripts are never reused and are re-evaluated fresh each time.
- **Input budget and summarization**: If conversation history requires context summarization, summarization runs once while accounting for the token budget needed by the reference. If sufficient input headroom already exists, no unnecessary extra summary is triggered just for the reference. If reference generation fails or input budget is insufficient, main writing proceeds without a reference rather than injecting a stale one. Cancellation propagates immediately to the model call.
- **Record ownership**: **마지막 집필 참고문** (Last writing reference) reflects the record actually included in the final input to the main writing model call, not merely the generation cache. Canceling after reference generation before the main call, or excluding the reference when editing a request, preserves the prior turn's reference record.

### Code structure and DB schema

- **Code mapping**:
  - `core/story-guide.ts`: Data interfaces and validation.
  - `server/story-guide-store.ts`: Per-chat settings and last-reference persistence.
  - `server/story-guide-runtime.ts`: Prompt assembly, execution, caching, and usage recording.
  - `server/story-guide-routes.ts`: APIs for reading/saving settings and fetching the last reference.
  - `web/StoryGuidePanel.tsx`: Original-work reference settings, historical reference display, and memo/correction UI.
  - `server/helper-context.ts`: Exposes original-work reference settings to the chat helper.
- **Database contract**:
  - Uses tables in SQLite schema version 15.
  - Introduces no separate task-queue table, long-term memory store, or full-text search index; managed as lightweight metadata attached to the chat record.
- **Copies and backups**:
  - Independent chat copies and portable chat backups copy **only** the original-work reference settings; the copied chat generates its own fresh references from its own context.
  - Full SQLite database backups include all previously generated references and history.

### Story Guide verification tests

- `tests/story-guide-*.test.ts`: Verifies saving and copying settings, concurrent-save conflicts, prevention of model calls on retired manual APIs, helper reading of identical settings, input token budgets and caching, and synthetic HTTP writing delivery/failure/cancellation contracts.
- `tests/chat-settings-browser.spec.ts` (`CSUI10`): Verifies settings changes, historical reference rendering, and memo/correction UI flows in the browser.
- Synthetic tests verify overall pipeline behavior.

## Story UI scanning, compilation and pins

- `core/story-ui-scan.ts` checks tag presence without zod or the A2UI catalog.
- Views using `web/story-ui-parser.ts` (`web/StreamingResponse.tsx`, `web/SourceReader.tsx`) render tag-free prose directly as paragraphs, loading the validator (`core/story-ui.ts`) dynamically only when tags are present while showing a result placeholder in the interim.
- Web code must not statically import `core/story-ui.ts`, preventing the startup bundle from pulling the validator back in.
- Code needing only block ranges—such as `core/image-placement.ts` hiding image tags—calls `scanStoryUi` from `core/story-ui-scan.ts` without validation.
- The server continues running the same validation synchronously via `core/story-ui.ts`.
- Direct edits and helper scene edits run through `compileEditedSourceText` in `server/story-ui-assets.ts` before saving. Helper rollback skips this compilation because it must restore the previously saved source verbatim. Edit round-trips are verified by `tests/story-ui-lifecycle.test.ts`.
- The status-board tab selects pins from the scene chain via `latestStoryUiPins` in `core/story-ui.ts` (`tests/story-ui-pins.test.ts`), served by `/api/chats/:id/story-ui/pins` in `server/story-ui-routes.ts` and displayed by `web/StoryBoardPanel.tsx`. Because pinned blocks are recomputed from scenes rather than stored separately, edits, regenerations, forks, and backups carry no separate pin state. Tab visibility is decided from this response, as scenes loaded in the reader are only a slice of the chain and cannot serve as the source of truth. The current scene is chosen by `web/useStory.ts` using the same basis (`readerLocation`) as reading position.
- Placement of failed blocks is determined by `compileReadingMarkdown` in `core/reading-markdown.ts`, which compiles prose before and after the block separately (`tests/reading-markdown.test.ts`).
- Image bindings for edited blocks are verified by `tests/story-ui-asset-run.test.ts`.

## Manuscript search (FTS5 trigram)

### Index structure and change tracking (FTS5 trigram)
- **Derived data**: The `search_documents` table and SQLite FTS5 trigram virtual table (`search_trigrams`, plus the legacy index `search_fts` while migrating) are derived from source data and are not rebuilt in full on app restart.
- **Change tracking and normalization**: Original/translation edit transactions record only dirty entries (scene ID and revision) in `search_dirty_sources`.
- **Worker batching**: A read Worker normalizes small batches, and the main server compares revision numbers before applying updates to the index.
- **Write bounds**: Each index write is capped at roughly 256KiB of combined old and new text or up to 8 scenes. A single very large scene is indexed alone without batching it with other large scenes, prioritizing responsiveness of other operations over total index completion time.
- **Index storage format**: `search_documents.text` stores a single copy of plain text for result snippets; no normalized/lowercased copy is persisted, feeding only the positionless trigram index (`search_trigrams`, `detail=none`, `contentless_delete=1`). Because the index casts a wide candidate net and actual matches are verified against the stored plain text, contiguous phrase queries also find candidates via trigram AND conditions.
- **Legacy index migration**: Legacy rows (non-empty `search_text` present in `search_fts`) are migrated into the new index at roughly 128KiB per second during idle ticks when no indexing work is pending, clearing `search_text` to an empty string (`moveLegacySearchIndex`). During migration, search consults both indexes. Once no text remains to migrate, `search_fts` is emptied completely—including empty or already-deleted residuals—after which the 1-second tick performs only a read check without opening a write transaction. If the server stops mid-migration, the next startup resumes from remaining rows. Columns and tables are kept intact to preserve schema 15. `tests/manuscript-search.test.ts` verifies search, deletion, and index integrity during and after migration.
- **Latest-body overlay**: **Search overlays dirty documents with their latest text inside the same SQLite read transaction**, so newly saved edits and deletions appear immediately even if indexing lags.

### Search queries and segment scanning
- **Candidate extraction and verification**: Terms of 3+ characters narrow candidates via the index before re-checking the text, while queries containing only shorter terms scan sequentially in segments of up to 200 scenes. Auto-querying Hangul, Hanja, and Kana terms starting at 2 characters takes this sequential path because a trigram index cannot narrow terms shorter than 3 characters.
- **Search remaining manuscript**: Searches that do not finish within one segment continue into the next segment via **남은 원고 검색** (Search remaining manuscript) at the bottom of the results.
- **Status reporting**: Incomplete searches are never shown as "no results", and background indexing displays a status notice (`coverage: 'building'`).
- **Cursor stability**: Cursors store only the search criteria and the sequence number of the last scanned scene, so edits in other chats or already-passed results do not invalidate next-page fetches.
- **Snapshot scope**: The current page searches the latest manuscript; new matches in already-passed ranges require restarting the search from the beginning. Search does not maintain a single point-in-time workspace snapshot across multiple pages.

### API contract and ReaderTarget contract
- **API contract**:
  - `POST /api/search`
  - Request payload: `{ query, scope, chatId?, botId?, kinds, cursor?, limit? }` (default 20, max 50 results).
  - Response payload: `{ items, nextCursor, coverage }`.
  - Requests run read-only (`PRAGMA query_only=ON`) and work even in maintenance mode. The Worker reads only the server-chosen DB; the API never accepts raw SQL or file paths.
  - Enforces an overall Worker timeout (8 seconds) and concurrency limit (max 4). Exceeding the timeout advises narrowing the search scope without blocking manuscript writes.
- **Navigation target contract (`ReaderTarget`)**:
  - `ReaderTarget` is the shared contract for navigating with chat, scene, original/translation, hash, and target paragraph together.
  - If the body hash has changed, navigation falls back to the start of the scene rather than an inaccurate paragraph.
  - Search queries and manuscript excerpts are never placed in URLs.
- **Verification tests**:
  - `tests/manuscript-search.test.ts`: Short Korean/Japanese queries, FTS, phrases/punctuation, immediate reflection of edits/translations/deletions, scope isolation, pagination, search cancellation, and maintenance mode.
  - `tests/personal-features-browser.spec.ts`: Live search, scene navigation, and small-viewport layout.
  - Dynamic script output and morphological/semantic search are out of scope.

## Reader navigation, streaming, renderer and helper sessions

- Simply opening the helper creates that chat's default conversation. A default conversation that has never sent a request and has not changed its name, tone, or project is hidden from other chats' lists and the global list so merely opening a chat does not fill lists with empty conversations. It always appears in its own chat's list, and any conversation opened once in the current tab remains visible until the tab reloads—because composer drafts exist only in the browser and are unknown to the server, these two rules keep a path back to an active draft without deleting the conversation. Conversations explicitly created via **새 대화** (New conversation) always appear even when empty. The server list (`HelperWorkspace.list`) returns all conversations flagged with `unused`, and `listedHelperSessions` in `web/helper-navigation-model.ts` owns the filtering.

### Reader navigation state and SSE synchronization

- **Single navigation state machine**: Chat, manuscript, and view state are controlled by a single state machine in `web/reader-navigation.ts`. Repeated navigation to the same URL (`A→B→A`) or re-selecting the same scene counts as a new user intent, preventing prior fetches or delayed retry completions from overwriting the new view or bouncing to another chat.
- **SSE cursor and backoff**: The Reader keeps fetching up to the SSE target cursor and retries transient network errors with exponential backoff up to 5 seconds even without new events. Full resync is marked complete only after its response has been applied to the screen, and leaving the chat immediately cancels retry timers. A first SSE `snapshot` arriving without a disconnect after the initial chat load has applied does not trigger a second full fetch; it fetches incrementally only if the initial load's cursor lags behind the snapshot sequence. Only that snapshot waits for the initial fetch; new events arriving during the initial fetch trigger fetches immediately so a slow first response cannot hide newly committed scenes. Snapshots after a disconnect or after a failed/invalidated initial fetch perform a full resync as before (`web/reader-sync.ts`, `tests/reader-sync.test.ts`).
- **Global prompt-setting change events**: Saving the prompt/model workspace writes a single latest-change record in `app_metadata` instead of one event row per chat. Its sequence number is reserved from `events`'s AUTOINCREMENT sequence so it sits in the same ordering as chat events, and `Store.events()` and `latestEventSequence()` merge it as `prompt-workspace.updated` into every chat's SSE stream, Reader cursor, and display revision. Legacy per-chat rows remain delivered as-is (`server/prompt-workspace-events.ts`, `tests/response-transport.test.ts`).
- **`/reader` block text**: Even when the server sends `sources[].blocks[]` and translation layout blocks as ranges without `text`, `web/reader-blocks.ts` slices `text` from the original or translation immediately upon receipt so downstream components see the same block contract. Legacy responses containing `text` are also accepted unchanged.
- **Idle-tab power saving**: When viewing the library or when the browser tab is hidden in the background, Reader polling and retry timers pause while retaining only the latest cursor and essential notifications; returning to the manuscript reads accumulated changes in one pass. Card input prompts likewise avoid idle polling, checking only on existing SSE input-request, response/cancel, and task-end events, reconnects, and view return. Inputs answered on another device close even before the task finishes, and a late acknowledgement of a previous answer preserves any draft being written for the next prompt. Overlapping checks coalesce sequentially and only failed fetches retry, never re-executing a card's waiting operation.
- **Live response streaming**:
  - Active chat response text rides on the already-open chat event connection (`/api/chats/:id/events`) as `event: stream` frames rather than opening per-response connections, avoiding standard HTTP/1.1's 6-connection-per-origin limit (separate connections for chat events, main writing, and helper responses would stall other requests with just two busy tabs).
  - Frame formatting and backpressure live in `server/chat-event-stream.ts`, browser routing in `web/response-stream-bridge.ts`, and `web/StreamingResponse.tsx` merges pushed pages and cursor-poll responses (`/api/response-streams/:taskKind/:taskId?after=`) through a single per-task sequence cursor so chunks are never duplicated.
  - `ResponseStreamStore` (`server/response-stream.ts`) flushes received text from memory every 50ms or every 1,024 characters, and persists to the DB every 750ms, when unwritten text reaches 4,096 characters, on attempt or segment change, or on task completion. Cursor polling includes unwritten in-memory text so both paths observe identical sequence numbers.
  - Because chat event sequences and per-task text sequences are independent, every frame `id` carries both as `<채팅 순번>;<종류>:<작업 ID>:<글 순번>,...` (`<chatSeq>;<kind>:<taskId>:<textSeq>,...`), allowing browser auto-reconnects to resume both via `Last-Event-ID` alone. When opening a fresh connection, the app passes its cursors in the `streamAfter` query parameter. The server attaches the starting read sequence (`after`) to each frame; if `after` is ahead of the client's cursor, the client detects a gap and fills it via cursor polling.
  - Cursor polling remains as the fallback path for out-of-chat helper tasks, partial response views after failure or cancellation, tasks in other chats, event-stream disconnects, initial mount, and tab/response re-visibility. It polls again after 120ms when the previous poll returned text, or after 300ms on an empty page (awaiting first token or tool phases). While push frames arrive, it polls once only if 2 seconds pass with no new text, preventing stalls behind buffering proxies.
  - The per-task SSE route (`/api/response-streams/:taskKind/:taskId/events`) remains on the server but is unused by the app. When a tab is hidden or a response is not visible, pushed pages are discarded and polling stops, resuming from the last received sequence number on return.
  - `tests/chat-event-stream.test.ts` verifies composite cursor resume, backpressure, and termination on session revocation; `tests/response-stream-browser.spec.ts` verifies live server push delivery, disconnect fallback to polling, and poll pause/resume.
- **Streaming during translation**: While a translation task is running and the scene is set to translation view, `web/SourceReader.tsx` displays the task ID's `translation` stream via the same `StreamingResponse`. Before text arrives and while the stream is unavailable, `quietUntilText` renders nothing and preserves the existing translation-preparing indicator, clearing it once `onText` signals the first text. Only the latest attempt's text is shown so refused attempts and retries never overlap, rendered through the same reader prose path as main streams without Story UI processing. Re-translating an already-translated scene continues showing the existing translation. Streamed text is raw pre-judgment attempt output for display only and swaps to the saved translation upon completion. Translations using structured output, submit tools, Codex connections, or Story UI placeholder tags do not stream raw output because it would look garbled (`publicProgressAllowed` in `core/provider-progress.ts`, `server/product-auxiliary.ts`). `tests/translation-stream.test.ts` verifies no pre-judgment persistence and attempt isolation, and `STREAMTRANSLATION` in `tests/response-stream-browser.spec.ts` verifies translation-view streaming and post-completion replacement.
- **Side-panel width and reading position**: Opening, closing, or resizing the right panel reflows manuscript lines; the paragraph being read is held steady by browser scroll anchoring (`overflow-anchor: auto`, `web/style.css`). Dragging updates only `--panel-w` on `.app-shell` without going through React, so reading-preference layout restoration (`changeLayout` in `useReadingPreferences`) is not used on this path. Width is owned by a single state in `web/main.tsx`, bounds and persistence by `web/side-panel.ts`, drag and keyboard handling by `web/SidePanelResizer.tsx`, and tabs by `web/SidePanelTabs.tsx`. `tests/side-panel-browser.spec.ts` verifies tab-switch preservation, width adjustment/persistence, and reading position.
- **Bottom follow**: Both the main reader and helper conversation follow new output through one hook, `web/useBottomFollow.ts`. The reader follows only from the moment a request is sent until that chat's execution finishes, never on chat switch or fresh page load so it does not fight reading-position restoration. Scrolling up stops following immediately, and returning near the bottom (80px) resumes it; scroll retraction caused by shrinking content does not count as scrolling up. Because an in-progress response sits outside the scene theme frame, it scrolls the reader scroll container rather than the internal scroll body (`data-uimori-body-scroll`).
- **Auto-translation switching and user interaction**: `web/SourceReader.tsx` tracks per-scene interaction. Wheel, touch move, scroll keys, or scrollbar clicks while the scene is visible, selecting text inside the scene, and opening original/translation/request editors count as interaction. Entering a queued or running translation state clears the flag so only post-request interactions count—except when a selection or editor is still open inside the scene at completion time, which still counts even if started before the request. Selections inside Risu-rendered Shadow DOM scenes are detected via `readerContains` in `web/reader-dom.ts`. Off-screen scenes switch regardless of interaction. A manually chosen representation persists in tab session storage under `reader-mode:<장면 ID>` (`reader-mode:<sceneId>`) and overrides subsequent auto-switching. Switching between original and translation aligns on the visible block's anchor, falling back to the matching positional block when anchors differ but both representations have the same block count. Verified by `RSEL07`–`RSEL09` and `RSEL12`–`RSEL14` in `tests/reader-selection-browser.spec.ts`.
- **Request recovery keys and idempotency**: Generation requests with uncertain acceptance are verified via local request keys; during verification, the submit button stays `'이전 요청 확인'` (Check previous request) so it cannot accidentally flip into a cancel action. Verification records persist even across 404 or conflict responses and can be explicitly cleared once the user acknowledges the risk.

### Renderer architecture and DOM contract

- **Code layout**:
  - `web/reading-preferences.ts`: Defaults and localStorage validation.
  - `web/useReadingPreferences.ts`: Setting persistence, cross-tab sync, and scroll-position restoration.
  - `web/ReadabilitySettings.tsx`: Reading-settings dialog UI.
  - `web/Prose.tsx`: Helper prose, safe general Markdown, and settings-sample renderer.
  - `web/RisuMessageSurface.tsx`: Dedicated Risu message renderer (open Shadow DOM).
  - `core/reading-markdown.ts`: Shared markdown-it parser.
  - `web/reading-quotes.ts`: Punctuation pairing and role analysis.
  - `web/reading-dom.ts`: Completed-prose DOM decoration and quotation styling.
  - `web/reading-prose.css`: Shared quotation and typography styles.
  - `web/PlainProse.tsx`: Protected-token and literal-text handling for the final paragraph still streaming.
  - `web/reader-dom.ts`: Selection ranges inside Shadow DOM and reading-coordinate mapping.
- **Streaming paragraph rendering**: Streaming prose renders completed leading paragraphs ending in a blank line with the same compiler as finished prose (`Prose` for main writing, `HelperMessageProse` for helper replies) while keeping only the in-progress last paragraph as plain text in the same font. Blank lines inside unclosed code fences or `<a2ui>` blocks are not treated as paragraph breaks (`splitCompletedParagraphs`, `tests/prose.test.ts`). Finished prose in bot chats is rendered by the server's Risu renderer inside a scene theme frame; font and line width match (`tests/response-stream-browser.spec.ts`), though vertical position can shift slightly on completion by the difference in frame and Risu paragraph margins.
- **Safe Markdown subset**: Among attributeless HTML tags, only ruby annotations (`ruby`, `rb`, `rt`, `rp`), underline (`u`), superscript/subscript (`sup`, `sub`), highlight (`mark`), small text (`small`), basic styling (`b`, `i`, `s`), and line break (`br`) are rendered. All other arbitrary HTML tags or tags with attributes are escaped and displayed literally. Illustrations are inserted only after closed Markdown containers; legacy images and illustrations without a safe boundary (such as inside lists or tables) render below the body.
- **Geometry markers and scroll restoration**: Temporary geometry markers map coordinates between display-transformed prose and rendered DOM elements. Markers never participate in user text selection, clicks, the accessibility tree, or layout, and are recomputed when window size or fonts change.
- **Protected-token optimization**: `{{…}}` syntax checks for the closing delimiter position first so repeated unclosed tokens in long paragraphs skip quickly without performance degradation.
- **Original-text immutability**: Reading preferences apply solely to presentation-layer CSS and React components and never modify stored originals, translations, SHA hashes, character offsets, or block anchors. Reading styles are excluded from model prompts and backups. Drag-select copy may follow the browser's visual line-break behavior.

### Helper sessions

- **Session ownership and independence**: Each independent chat can own multiple helper sessions. Each session owns its own conversation history, composer draft, and active context; closing the helper panel or switching sessions never cancels running background tasks. Tools may target another chat when explicitly requested by the user. Copying a chat creates an independent new chat that does not share mutable defaults.
- **Transcript edits and context isolation**:
  - Editing or deleting helper messages preserves original execution evidence separately.
  - Edits and deletions take effect immediately in conversation views and future helper context (including copied seed messages and retry groups).
  - Any message edit immediately detaches an active helper summary so stale text cannot re-enter subsequent requests through context compaction.
  - Existing task snapshots and already-committed resource edits are never retroactively rewritten or undone.
- **Header, model selection and CAS revisions**:
  - The helper header owns session switching, creation, and management; tone settings live in the management menu.
  - A searchable model picker opens directly from the composer toolbar.
  - Changing the model updates the helper role in per-role models for subsequent requests without changing the current chat's main writing model or other roles.
  - The latest committed revision takes precedence over late-arriving responses.
- **Concurrency and call limits**:
  - Per-conversation call limits are not manually editable.
  - Newly admitted helper tasks apply internal policy limits of **64 helper reasoning calls**, **128 total model calls**, **256 host tool calls**, and the configured **도우미 작업 제한 시간** (Helper task time limit, default 60 minutes).
  - Already-admitted tasks keep the call limits saved at admission time.
  - On provider rate limits (429) or transient server errors (5xx), the helper waits 5s, 20s, then 60s in sequence and retries the same call up to three times, continuing with everything read and saved so far. If the same error persists after three retries, the task ends in failure. Tasks can still be stopped while waiting, and retried calls count toward the total model call limit.
  - On provider response refusal, the helper immediately retries the same call without waiting, following **앱 설정 → 새 채팅 기본값** (App Settings → New chat defaults) → **거절되면 자동으로 다시 생성** (Auto-regenerate on refusal, default on, max 2 retries); per-chat overrides do not apply to the helper. The counter resets per refused call, and retried calls count toward the total model call limit. Exhausting retries fails the task and waits for **다시 시도** (Retry) or **이어서 하기** (Continue).
  - If a failed or stopped task had already read resources or saved changes, **이어서 하기** (Continue) is offered. Clicking it starts a new task for the same request while passing along the record of prior reads and saved changes so completed changes are not redone and only remaining work continues. A task that failed after saving changes cannot use **다시 시도** (Retry from scratch) and offers only **이어서 하기** (Continue). Continuation tasks receive fresh call limits and timeout and use the currently configured helper model. Even when multi-minute rate limiting exhausts automatic retries, work can resume shortly afterward via **이어서 하기** (Continue). Continuation is unavailable if prior task records were pruned, if the task touched a deleted scene, or if it ran on the native Codex runner.
- **Read state**: The server stores the last seen task-result event sequence per conversation under `helper-read:v1:<대화 ID>` (`helper-read:v1:<conversationId>`) in `app_metadata` (`server/helper-read-state.ts`). Because values move strictly forward and never exceed that conversation's latest result sequence, late or duplicate writes from another device cannot mark a seen conversation unread again. Conversation list responses carry this value directly with no separate fetch. The browser keeps only values not yet persisted to the server in `uimori:helper-seen:<대화 ID>` (`uimori:helper-seen:<conversationId>`) (`web/useHelperSessions.ts`) and uploads any value ahead of the server once on the first list load after page open. On write failure it retains the value to retry on the next acknowledgement rather than looping retries. Deleting a conversation or chat removes the record. Verified by `tests/helper-navigation.test.ts` and `HREAD01` in `tests/helper-task-results-browser.spec.ts`.
- **Live display context and event cursors**:
  - Opening the Reader or helper fetches the current view and event cursor and tracks only subsequent changes, never replaying historical notifications from the beginning to rebuild the screen.
  - Message updates preserve reading scroll position, and Risu native HTML and general Prose share the same outer block anchors.
- **Completed Risu message presentation**: Restores the current package/profile projection and assembles live message history once without reconstructing discarded generation histories or story context. Original/translation rendering, CBS/Lua message ordering, current variable state, and action-revision checks all use this live display context.
- **Presentation cache and revalidation**:
  - Because identical inputs produce identical HTML, the server caches results in memory.
  - The route-level key (`server/package-presentation-routes.ts`) hashes the scene source hash, translation text hash, the full actually-used snapshot (including card, variables, and logical history, excluding post-completion `phaseSpans` timings unused by rendering), image tasks and assets, exact viewport, and renderer version.
  - The message-level key (`server/package-presentation.ts`) covers a single per-language render so updating a translation does not re-render the original. Keys hash content rather than revision numbers because changes emitting no chat events (such as model settings) still affect rendering.
  - `ETag` combines this key with the process startup ID to reply `304` without recomputing the body (after the auth hook, with `Cache-Control: private, no-cache`); everything recomputes after a restart.
  - Runs where CBS `{{random}}`/`{{roll}}`-style macros or Lua `math.random` draw randomness are flagged across the worker boundary by `server/risu-native-entropy.ts`, and their outputs are neither cached nor given an `ETag`. Clocks are pinned to execution time (`executionClock`) and Lua has no `os`, so time does not prevent caching.
  - Multiple scene requests on a page share history and logical history for the same `(채팅, head, 이벤트 순번)` (`(chat, head, eventSequence)`) for 5 seconds.
  - When a scene or translation finishes, `precomputePackagePresentation` precomputes recently viewed scenes in that chat one by one at the last viewport, waiting whenever a live screen request is in flight.
  - Reader `presentationRevisions` are per-scene; only in chats reading current head and variables (such as native Risu cards) does adding another scene bump every scene's revision (`server/reader-data.ts`, `tests/reader-data.test.ts`, `tests/package-presentation-cache.test.ts`).
- **Original and translation history retention**: Direct original editing preserves the immutable initial original, the latest 2 edited versions, and any versions still referenced by unfinished tasks. Translation history preserves the current and immediately previous successful translation texts plus active image targets.

### Reader and renderer verification tests

- **Navigation and session tests**:
  - `tests/reader-navigation.test.ts`, `tests/reader-navigation-browser.spec.ts`: View navigation state machine, `A→B→A` return, cache consistency.
- **Rendering and reading typography tests**:
  - `tests/prose.test.ts`: Shared Prose renderer and quotation-style parsing.
  - `tests/reading-markdown.test.ts`: markdown-it safe HTML filtering and syntax handling.
  - `tests/reading-quotes.test.ts`: Per-punctuation role dispatch, quotation line breaks, exception patterns.
  - `tests/reading-preferences.test.ts`: Reading-preference defaults, persistence, preset switching.
  - `tests/reading-browser.spec.ts`, `tests/reading-markdown-browser.spec.ts`: Live browser reading flow, ruby annotations, illustration slots, scroll-position preservation.
- **Risu native Shadow DOM verification**:
  - `tests/risu-message-surface-browser.spec.ts`, `tests/risu-native-frame-browser.spec.ts` (`RSURFACE`): Reading styles inside Shadow DOM, input state preservation, `Selection.getComposedRanges` selection bounds, action-revision locking.
  - `tests/risu-reading-markdown.test.ts`: Message marker provenance and rendering consistency.
- **Integrated UI verification**: `npm run verify:ui`.

## Reading state and bookmarks

Developer and agent contract covering the storage layers, CAS concurrency control, API specification, and verification rules for reading positions and bookmarks.

### Reading position data schema and storage layers
- **Server storage unit**: Keeps **exactly 1** latest position per browser and chat in the dedicated `reading_positions` table.
  - Stored fields: `chatId`, `sourceId` (scene), `representation` (`original | translation`), `contentHash` (body hash), `blockAnchor` (paragraph anchor), `offsetRatio` (relative offset within the paragraph).
  - Screen pixel coordinates and full scroll-history logs are never sent to the server.
- **Client storage split**:
  - `localStorage`: Stores this device's high-precision scroll reading-position cache.
  - `sessionStorage`: Stores composer cursor positions and per-tab transient state (legacy sessionStorage reading positions migrate to localStorage on read).
  - The browser's random client identifier (`clientId`) is not an auth credential; existing session login is always required.

### Concurrency and CAS (`expectedRevision`) conflict control
- Races across multiple tabs or windows on the same device are controlled via CAS (Compare-And-Swap) using `expectedRevision`.
- Stale positions whose revision no longer matches the server are not force-retried; the latest server revision is re-checked on the next chat entry or view return.
- If a new scroll position occurs while a save request is already in flight and the user closes or leaves the tab, the new position is saved sequentially right after the in-flight save completes.

### Bookmark data model and atomic management
- Bookmarks are classified as user-authored creative assets and have no automatic expiration or TTL.
- Even if edits to manuscript text cause a paragraph anchor to drift, user-authored names, memos, and excerpts are never automatically deleted.
- Reading positions and bookmarks belonging to a chat are cleaned up only when that chat is permanently deleted.

### Related API endpoints
- `GET /api/chats/:id/reading-position`: Reads the current browser's latest reading position and server revision.
- `PUT /api/chats/:id/reading-position`: Atomically updates reading position using `clientId`, `expectedRevision`, and a `ReaderTarget` object; never triggers long-text tokenization or body reparsing.
- `GET /api/chats/:id/bookmarks`: Lists bookmarks for the chat.
- `POST /api/chats/:id/bookmarks`: Creates a new bookmark on the current scene.
- `PATCH /api/bookmarks/:id`: Updates a bookmark's name and memo (with CAS).
- `DELETE /api/bookmarks/:id`: Deletes a bookmark matching the verified revision.
- The server always verifies ID ownership to ensure the requested scene actually belongs to the current chat path.

### Reading state verification tools and test commands

```sh
# Unit tests for reading position, bookmark CRUD, CAS conflicts, and backup restore
npx vitest run tests/reading-state.test.ts

# End-to-end browser verification for personal features (cross-device resume, confirmation dialogs, draft protection)
npm run verify:personal-features
```

- `tests/reading-state.test.ts`: Verifies per-device state isolation, saving backward reading positions, concurrent-tab conflict handling, duplicate-bookmark prevention, paragraph-anchor relinking on copy, and legacy backup compatibility.
- `npm run verify:personal-features`: End-to-end browser verification of navigating the scene list and receiving a resume prompt in another browser, instant manuscript loading under delayed networks, and cancel/delete/conflict protection in mobile and desktop confirmation dialogs (does not imply that mobile OSes guarantee socket delivery at power-off).

## Turn activity

- While main prose generation is running, the status label shows the current phase in order: **컨텍스트 정리** (Context preparation), **로어 선별** (Lore selection), **원작 참고** (Original-work reference), and **본문 작성** (Writing). Phases are derived by `server/run-phase.ts` from the saved execution snapshot using the same conditions as the executor (`server/run-executor.ts`), exposed on `reader.runs[].phase`, and updated via the existing `run.context.updated` event emitted as each preparation stage finishes (with no new event type). Thus the next phase appears the moment the prior phase finishes. On retries where an original-work reference result is already saved, the phase may show **본문 작성** (Writing) even while re-checking the reference.
- Sidebar task activity and app-wide progress notifications remain unchanged. The existing active/last-30 contract on `reader.activity` is untouched, while historical tasks belonging to the current page provide metadata only under a separate `reader.responseActivity` field. Viewing older responses never re-creates stale failure notifications.
- Implementation spans `web/TurnActivity.tsx` (activity panel content), `web/TurnStatus.tsx` (header row and expanded-state storage), `web/SourceReader.tsx` (scene number, badge, and view-toggle slots), `web/RunTaskDetails.tsx` (shared execution details), and `server/reader.ts` (query scope). Source-link metadata is inspected in the collapsible entry on the scene's bottom toolbar.

### Turn activity verification

Per [verification selection](DEVELOPMENT.md#verification), `npm run verify:turn-activity` checks per-response expand/collapse, preserving selection across reconnects, diagnostic fetches, and completion transitions. Viewports come from the shared [browser viewport config](../../fixtures/browser-viewports.json), writing summaries to `output/playwright/turn-activity-ui-*/summary.json`.

Existing app-wide notification and request-retry regressions are verified with `node scripts/verify-activity.mjs` and `node scripts/verify-run-retry.mjs`.

## PWA, activity feed, Web Push and auto-translation language detection

- Language detection uses character composition in `core/written-language.ts` without invoking a judgment model. Markup, code blocks, and template expressions are stripped before counting; mixed-language or very short ambiguous text still triggers translation. Only Korean, English, Japanese, and Chinese are detected, and the translation output language (**번역 결과 언어**) is stored on the server separately from the UI language. Verified by `tests/written-language.test.ts` and `tests/chat-settings.test.ts`.

Developer and agent contract covering PWA manifest assets, the activity-feed schema, the Web Push queue, and VAPID encryption rules.

### PWA manifest, icon generation and service worker specification
- **Manifest contract**: App ID, start URL, and scope are fixed to `/` and never include private chat paths or session tokens. Static manifest files are served per [UI language](../I18N.md).
- **Icon asset layout**:
  - Sidebar logo: Background-free [transparent SVG](../../web/public/icons/halo-mark.svg).
  - Tab icon and app-info logo: Responsive SVG with cream circular motif on an indigo background.
  - [Tiny SVG source](../../web/public/icons/halo-tiny.svg): 16px viewport (2 circles).
  - [Small SVG source](../../web/public/icons/halo-small.svg): 32px viewport (3 circles).
  - [Detailed SVG source](../../web/public/icons/halo.svg): 48/64px and 180/192/512px (detailed concentric circles and dividers).
  - [Responsive SVG](../../web/public/favicon.svg): Switches to simplified motifs at 16px and 32px.
  - Derived SVG/PNG regeneration script: `node scripts/generate-app-icons.mjs`.
  - Maskable icons include safe-zone padding and use the dark-navy theme color for the install background.
- **No service-worker caching**: `sw.js` updates bypassing HTTP cache and never mirrors manuscript data or API responses into CacheStorage. UI language is persisted under `settings/ui-language` in the `uimori-presentation` IndexedDB database.

### Activity feed and acknowledgement API
- **Activity feed query**: `GET /api/activity-feed` queries the latest 500 tasks, excluding manuscript text and image files. Tasks completed before the first updated server startup are not replayed as newly unread.
- **Acknowledgement persistence**: `GET/POST /api/chats/:id/activity-acknowledgements` persists per-run acknowledgement state in the schema 15 `app_metadata` table and merges browser-local records. Deleting a chat cleans up its acknowledgement records.
- **Helper read state**: Helper conversation read state is also stored per conversation in `app_metadata`; see [Helper sessions](#helper-sessions) for storage details and boundaries.

### Web Push delivery queue and VAPID architecture
- **Atomic delivery queue**: Enqueues one delivery record per subscription inside the same transaction that records the task-completion event.
- **Concurrency and timeout**: Processes up to 4 deliveries sequentially at a time per process with a 10-second send timeout. Transient network errors or 429/5xx responses retry up to 3 total attempts (including the initial attempt).
- **Expiration and pruning**: Normal queued notifications expire after 2 hours and test notifications after 2 minutes. Relay responses of 404/410 delete the expired subscription from the DB, and finalized delivery records (succeeded, failed, expired, canceled) are pruned automatically after 7 days.
- **Session binding and security**: Subscriptions are bound to individual access sessions; logging out or rotating the access token immediately revokes linked push subscriptions and queues. Because DB backups contain the VAPID private key and subscription capabilities, keep backups private. Restoring to a different HTTPS origin removes subscriptions belonging to the old origin on normal server startup.
- **Android Chrome caveat**: The `'구독 취소'` (Unsubscribe) menu item rendered by Android Chrome on notification cards is native browser UI and cannot be removed by the app.
- **Codex auto-translation pre-check**: Auto-translation via Codex proceeds only after passing the judgment model's pre-content check; on failure, auto-translation is deferred so the user can request it manually.
- **Transport layer and endpoints**: Encryption and signing are delegated to the Web Push library; DNS, TLS, sockets, and cancellation use standard fetch while enforcing HTTPS-only relay URLs and disallowing redirects. Endpoints: `GET /api/push?clientId=...`, `POST /api/push/prepare`, `POST/PUT/DELETE /api/push/subscription`, `POST /api/push/test`. Subscription mutations verify the existing revision, and GET/subscription responses return only the public VAPID key and device status—never private keys or encryption capabilities.

### PWA and push verification tools and test commands

```sh
# Verify PWA manifest, service-worker cache non-intervention, and static assets
npx vitest run tests/pwa.test.ts

# Verify push-service DB queue, deduplication, session revocation, and restore
npx vitest run tests/push-service.test.ts

# Verify Web Push VAPID encryption, HTTPS relay URL checks, and worker focus
npx vitest run tests/push-transport.test.ts

# End-to-end browser verification for personal features (SW registration, explicit install UI, no CacheStorage)
npm run verify:personal-features

# Browser verification for Web Push notification UI scenarios
npm run verify:push
```

- **Official references**: [MDN PWA installability criteria](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [Explicit install UI guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt), [Web Push encryption library](https://github.com/web-push-libs/web-push), [Mozilla Push Service specification](https://mozilla-push-service.readthedocs.io/en/latest/http.html).

## UI language (I18N)

Developer and agent contract covering multilingual message formatting, API error translation, service-worker integration, and test automation.

### Message representation and ICU formatting contract
- `web/i18n.ts` and `web/locales/` own message representation.
- **Per-language catalog loading**: Source files in `web/locales/*.ts` colocate all four languages per key, and `web/locales/{ko,en,ja,zh}.ts` export single-language catalogs. At build time, the `uimori-locale-catalogs` plugin in `vite.config.ts` compiles these four modules into single-language JSON objects so only Korean ships in the startup bundle while English, Japanese, and Chinese load on demand as separate chunks. Korean must remain synchronous for fallback and `legacyMessage()` reverse mapping. `web/main.tsx` awaits `loadInitialLocale()` before first render so wrong-language strings or raw keys never flash, falling back to Korean for the current session only if the chunk fails to load. Switching languages applies after the chunk loads, with the latest selection winning if multiple switches overlap. Callers needing synchronous switching (such as tests) preload via `loadLocale()`. Startup-bundle modules (`web/api-errors.ts`, `web/request-file-errors.ts`) read `web/locales/ko.ts` instead of four-language sources like `web/locales/errors.ts`, because importing the multi-language source directly would pull all four languages into the startup bundle.
- Uses `intl-messageformat` as the sole runtime dependency for ICU variables, `plural`, `select`, numbers, and dates (no custom plural parser, and no HTML interpolation). Syntax follows the [official ICU Message Syntax](https://formatjs.github.io/docs/core-concepts/icu-syntax/).
- **Render subscriptions**: Components subscribe via `useI18n()` and render complete sentences with `t(key, values)`. Translated strings are never cached in module-level global constants at initialization.
- **Long-lived message descriptors**: Persistent notices such as alerts or status toasts store a `message(key, values)` descriptor and resolve it at render time via `translateMessage()` (translated strings themselves are never used as identifiers). Descriptors are UI-state-only and are never sent to the server or model requests.
- **Error propagation and translation timing**: Errors passed upward via `onError` preserve the raw message or descriptor and translate only when rendered. Switching UI language after an error updates the displayed copy without re-sending requests.
- **Nested references**: Only nested app messages are wrapped with `messageRef()`. User titles and manuscript text render verbatim with no recursive translation.
- **Legacy compatibility**: Existing validation helpers preserve Korean `Error.message` via `legacyMessage()` and register only the display contract. `registerMessage()` maps legacy wire API error strings to localized display strings.
- **Fallback policy**: Missing translations fall back to the Korean message. Undefined keys render the key name literally and fail static checks.
- **Number and date formatting**: `formatNumber` and `formatDate` follow the selected UI locale and reuse `Intl` formatters per locale and option set. Currency remains USD, and KST usage rollups, backup time zones, ISO query ranges, and raw numeric values remain unchanged. Korean usage K/M abbreviations are preserved. Records lacking a valid timestamp (such as legacy pending requests) omit the date display while keeping the rest of the UI usable.

### API errors and external boundary handling
- `ApiError.message` and `code` keep a fixed contract. Compatibility matching against Korean wire errors runs on the raw string first, and localization happens strictly in the UI layer via `displayMessage` and registered expressions.
- Model-settings shortcuts, reading-position sources, helper phases, and 0-second checks inspect codes, statuses, and numbers rather than localized display strings.
- External provider diagnostic logs, server DELETE conflict reasons that may include user names, and unknown new import findings are preserved verbatim. If an existing import finding's code or full-sentence format changes, its display mapping and tests must be updated together.
- **Service worker and push notifications**: The service worker persists the UI locale at `settings/ui-language` in the `uimori-presentation` IndexedDB database and reads it on each push event, recovering the selected language even after worker termination and defaulting to Korean if storage is missing or unavailable. Notification targets, user chat titles, tags, and server payloads remain unchanged, without adding manuscript caching, automatic resends, or forced reloads.
- **Web App Manifest**: Selects and serves a per-language static manifest while keeping app ID, name, start URL, and scope (`/`) fixed. OS notification permission prompts, install menu language, refresh timing for already-installed manifests, and activation timing for updated service workers are controlled by the browser and OS; existing windows are never force-reloaded.

### Automatic chat title generation contract
- Automatic titles for new chats are generated in the app's UI language at the time title generation is scheduled.
- The generation prompt instruction sent to the model is in English; legacy tasks scheduled in older versions without a language field generate titles in Korean.

### I18N verification tools and test commands

```sh
# Check message keys, arguments, ICU syntax, and missing entries across all 4 languages
npm run check:i18n

# Review Korean string candidates in JSX text and accessibility attributes
npm run check:i18n -- --candidates

# Run unit tests
npm test -- tests/i18n.test.ts tests/api-errors.test.ts

# Build and run end-to-end verification with synthetic fixtures
npm run verify:i18n
```

- `npm run check:i18n`: Detects empty translations, duplicate keys, ICU syntax errors, and argument mismatches across languages. `-- --candidates` lists Korean candidates in JSX text, accessibility attributes, templates, and module constants along with dynamic calls (candidates include model inputs, persisted defaults, and legacy errors, so blind bulk replacement is prohibited).
- `npm test -- tests/i18n.test.ts tests/api-errors.test.ts`: Verifies language-selection precedence, storage-failure handling, missing-key fallback, re-rendering stored messages on language switch, user-input preservation, and legacy error compatibility.
- `npm run verify:i18n`: Uses browser fixtures and screenshots to verify live selection/reconnect, preservation of drafts/reading position/saved resources across body-load failure and retry, mobile viewport layouts in all 4 languages, persistence of completion-notification timers, and push-language recovery after service-worker restart (see [development verification](DEVELOPMENT.md)). Review translations for both context and meaning.

## Themes, built-in assets and verification

- **Built-in theme assets**: Built-in theme asset files live in `third_party/theme-assets`, with hashes pinned in `core/builtin-theme-assets.ts`. Cloning and saving a built-in theme copies those files into the user theme so user themes can be exported and imported without app files. Custom-drawn decorative art is regenerated from SVG by `scripts/theme-art/<레이아웃>.mjs` (`scripts/theme-art/<layout>.mjs`). Whenever art is edited and regenerated, update its hash in `core/builtin-theme-assets.ts` as well.
- Color names omit the leading `--`; the canonical key list is `THEME_COLOR_KEYS` in `core/themes.ts`.

### Built-in layouts and palette sources of truth
- Layout source of truth: `core/narrative-themes.ts` is the single source of truth for layouts.
- Palette source of truth: `core/theme-palettes.ts` defines the palette list.
- User theme preservation and compatibility:
  - Cloned or imported user themes and their colors are never deleted or overwritten.
  - `verify:liquid-gallery` verifies shared gallery compatibility through a **user theme copy** rather than the built-in list; this compatibility fixture lives in [test fixture](../../tests/fixtures/liquid-gallery.ts).
- Data backup: Theme JSON includes the original colors stored in the layout and excludes separately chosen palettes and scope bindings. Separate palette resources and selections are preserved in workspace SQLite backups. Deleting or editing themes never alters manuscripts or model inputs. Expression panels, BGM, TTS, and input translation are out of scope for this feature.

### Theme test and verification commands
```sh
npm run check
npm test -- tests/themes.test.ts
npm run build
npm run verify:themes
npm run verify:narrative-themes
```

- `verify:themes`: Runs theme UI and existing Risu message-surface regression checks against an isolated synthetic server, writing results and screenshots to `output/playwright/themes-*/`. Open and visually inspect captured images.
- `verify:narrative-themes`: Tests each layout with synthetic images and long Korean manuscripts, cycling across 1440/412px and light/dark combinations to verify palette independence, zoom, editing, copying, translation, reading preferences, and recovery.
- Visual demo folder: For personal visual review, set `UIMORI_NARRATIVE_DEMO_DIR` to a directory containing `bot.webp` (2:3) and `persona.webp` (1:1). These inputs are stored only in the isolated synthetic server with outputs written to the gitignored `output/` directory; default runs use deterministic synthetic images, and demo image files are never committed to the repository.

## Usage report and backfill

- **`attempts` table and lightweight aggregation**: The `attempts` table stores only call timestamps, purposes, test flags, and compact numeric estimate columns. Usage aggregation never reads full manuscripts or prompt JSON, and deletion cleanup leaves numeric columns intact without loading or parsing completed request/response bodies in JS.
- **Deferred settlement and classification ownership**: Minimal frozen pricing metadata is retained only while an in-flight call awaits late settlement. Collaborative `agentId` and helper `purpose` are classified by the host; model output never alters billing classification.
- **Input translation and connection tests**: Input translations and connection tests are also logged at the actual transmission boundary, without storing request or response bodies in this ledger.
- **Unknown-time records**: Historical records lacking an actual call timestamp are aggregated separately under `시각 미확인` (Unknown time) rather than arbitrarily placed into a selected date range. Previously deleted runs, unrecorded collaboration categories, and missing timestamps cannot be recovered, and the UI displays the cutoff date when detailed tracking began.
- **Helper pricing tool contract (`model.pricing.read/update`)**:
  - The helper can modify pricing only for saved models via `model.pricing.read/update`.
  - Historical calls logged without pricing can be backfilled with estimated costs from current saved rates via `model.pricing.backfill` (`server/usage-backfill.ts`). Calls that already had pricing at call time or a provider-reported cost are never overwritten so recorded prices are not rewritten retroactively. Backfilled estimates carry a marker noting late calculation, and calls whose service tier differs from current pricing remain unknown. Usage-screen totals recompute from call records and reflect backfills immediately, while cost totals already saved on tasks do not change. Verified by `tests/helper-pricing-tools.test.ts`.
  - Validates the latest `expectedRevision` and requires an unauthenticated HTTPS `sourceUrl` plus verification date `checkedAt`.
  - Rate units are USD per million tokens (`USD/100만 토큰`).
  - `null` means unknown; `0` means confirmed free. Flex, Batch, cache TTL, and long-context rates are specified separately according to the source and are never guessed with arbitrary discounts.
  - Helper web-search availability depends on the selected provider adapter, model, and account; separate search-tool fees may not be included in token-rate estimates.
- **Query API endpoints**:
  - `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`
  - `GET /api/usage/export?...&group=day|model|kind`
  - Read-only and gated by existing workspace authentication. Queries never trigger model calls, price re-fetches, or scheduled jobs.
- **Test suite**:
  - Unit and functional tests: `tests/usage-report.test.ts`, `tests/usage-display.test.ts`, `tests/pricing-store.test.ts` (reported/estimated/partial/unknown distinction, KST date boundaries, duplicate-call prevention, PII removal after deletion, unknown-time records, and CSV export; input-translation tests confirm all DB tables other than usage numbers stay unchanged and drafts are not stored).
  - End-to-end verification: `npm run verify:personal-features` (verifies two receipts sent to a loopback synthetic provider across HTTP/API, desktop/mobile UI, and CSV without calling external paid models).
  - Browser verification: `npm run verify:browser -- --grep SPUI` (checks dark/light themes, desktop/mobile layouts, unknown amounts in charts, invalid date ranges, post-error refetch, and unsaved settings state with synthetic data).

## HTTP compression, private ETag and maintenance mode

The app server serves hashed `/assets/*` files with a 1-year `immutable` cache header, sending prebuilt Brotli or gzip copies when supported by the browser. `index.html`, the service worker, and manifests retain their existing headers without precompressed copies. JSON and text API responses of 1 KiB or larger are compressed by the app server with Brotli (quality 4) or gzip, while SSE, images, fonts, and archive files are left uncompressed (`server/response-compression.ts`). Library, chat list, activity, prompt settings, font list, Reader responses, and connection model lists attach `ETag` and `Cache-Control: private, no-cache` only on authenticated requests, replying `304` when unchanged (`server/private-etag.ts`).

Starting with `UIMORI_MAINTENANCE=1` allows only DB entry and reads without starting task recovery or workers. Because this is not a read-only SQLite open, never verify directly against the sole production DB—always verify against a copy. This boot mode cannot be enabled via the API. Implementation lives in [maintenance.ts](../../server/maintenance.ts) and [app.ts](../../server/app.ts).

The Oracle runner uses these entry controls and boot boundaries to wait for in-flight tasks, verify a candidate database copy, and reopen writes after deployment. App entry control is covered in [maintenance mode tests](../../tests/maintenance.test.ts), and separate image, backup, and recovery checks are documented in [Oracle release guide](ORACLE-RELEASE.md).
