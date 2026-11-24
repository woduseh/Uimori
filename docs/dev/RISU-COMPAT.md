# Risu compatibility, prompts, lore and translation guides

Developer-only technical sections extracted from `docs/RISU-IMPORT.md`, `docs/RISU-EXPORT.md`, `docs/PROMPT-RUNTIME.md`, `docs/LORE-CONTEXT.md`, `docs/TRANSLATION-GUIDES.md`, and `docs/BUILTIN-PROMPTS.md`.

## Risu native import and execution

This path is implemented in [native importer](../../server/risu-native-import.ts), [source contract](../../core/risu-native.ts), and [character card file reader](../../server/character-card-file.ts).

### Source preservation and projection policy

- **Source data**:
  - `nativeRisu.card` is the card `data` object, and `nativeRisu.module` is the embedded or standalone module object.
  - After applying the deprecated-field policy, unknown active extension fields, disabled lore entries, and original asset roles are preserved.
  - `sourceHash` is the SHA-256 of the input file, and `assets` maps asset names and URIs to stored image IDs.
- **Stored projections**:
  - The body text, first messages, and lore read by the existing library and chat storage are projected fields derived from the source document.
  - Original CBS is kept verbatim without also creating new `bodyTemplate`, `compat.risuCbs`, `transforms`, or `behavior` programs.
  - The body is the card description, while dialogue examples and global notes are consumed at the conversation and block positions defined by the native preset.
  - Importing does not change the app's current prompt or model connections.
- **Source and first-message size budgets**:
  - Card and module source documents share a combined 8 MiB JSON budget.
  - Individual first messages, body text, and lore entries (including HTML/CSS selection screens) are accepted up to 2,000,000 characters, matching the stored-message limit.
  - No separate cap is placed on first-message count or combined list size, and display copies are not double-counted to reject source documents.
  - Source documents are never arbitrarily truncated on import; if a stored-message limit is exceeded, the UI reports it.
- **Lore handling**:
  - Always-active entries are handled as pinned context, while the remaining active entries default to selection by the Uimori judgment model (default: JEV).
  - Original keys, secondary keys, regexes, and lorebook settings are preserved in the source document, while relevance judgment is handled by the judgment model.
  - Position and insertion directives that are not reflected in the current model context are surfaced during import review.
  - Disabled entries remain in the source document but are excluded from model-input projections. Preservation itself does not imply execution support for every Risu lore directive.
- **Progress memory**:
  - Lore entries are neither moved into chat notes nor disabled because of import. No `memoryIds` selection API or separate screen is provided.
  - Previously stored `imported-memory` notes, provenance records, and backups remain readable, and existing content or chats are never automatically deleted or reclassified.
- **Image conversion**:
  - PNG, JPEG, WebP, AVIF, and GIF files are decoded/inspected from actual bytes and stored as high-quality WebP through the shared image-processing boundary.
  - Original resolution, transparency, and supported animation are preserved, and files that are already WebP are not recompressed.
  - WebP files kept verbatim only validate RIFF container structure without decoding every frame; truncated files are rejected, whereas pixel corruption inside a structurally intact frame is stored as received.
  - A 64 MiB per-file limit and pixel/frame processing limits apply, and original files are not stored twice.
  - Names and descriptions are used in the UI and for judgment-model image selection, while original asset reference names are used by Risu scripts. Files at external URLs are not downloaded automatically.
- **Original file retention policy**:
  - The current card, module, and preset source documents and converted images are stored. Full input containers are not permanently stored as separate `sourceFiles` receipts.
  - If byte-exact original files are needed, retain the pre-import files separately; export creates a new file from the current stored content.
- **Retries and idempotency**:
  - If the review digest changes, the import must be reviewed again. When a save outcome is uncertain, verification checks with the same file, selections, and request key.
  - Even after temporary uploads are deleted, recently succeeded requests check a small processing receipt first so bots, chats, and first messages are not created in duplicate.
  - Original files and full converted payloads are not permanently stored for retries, and existing content and operational data are not overwritten by this import.
- **API and editing lifecycle**:
  - Import and save APIs rebuild body text, first messages, lore, instructions, and default variables from the source document.
  - Content editing uses standard save/cancel semantics, and source JSON is parsed together on save.
  - Unfinished input remains in this device's recovery buffer and is not synced as server drafts or history.
  - Invalid syntax is reported without clearing the input. Unsaved changes must be saved first before exporting. See [Content editing](../EDITING.md).

### Precedence of embedded CharX data

`module.risum` is read as serialized data belonging to the same card rather than as a separately attached module. Both the card and module source documents are retained, and the following precedence rules apply at runtime:

- If an embedded module is present, its `regex ?? []` and `trigger ?? []` replace the card's inline scripts.
- An embedded `lorebook` replaces the card's lore even when it is an empty array. The card's lore is used only when `lorebook` is missing or `null`; the two lists are never merged.
- The card owns the name, description, and first messages. Image bytes from the embedded module are also read in metadata order and stored alongside the card's images without overwriting the source document.
- A corrupted embedded module is never silently ignored or replaced with inline data. Validation continues to enforce RPack, container version, UTF-8, CRC, asset count, ZIP paths, and expanded-size limits, without extracting to the filesystem.

### Native content editing and new chats

- **Source field editing**:
  - The library's Risu editor saves name, settings/description, default first message, dialogue examples, and creator's notes directly to source fields.
  - Global notes, background HTML/CSS, and default variables are edited directly, while alternate greetings, lore, regexes, and triggers/Lua are applied via JSON editing.
  - Full card or module JSON can also be edited, and unknown active extension fields remain untouched. This single source document is the source of truth for content editing and execution.
- **Edits and revisions**:
  - Saving and importing use the same source projection function. Edits to current content increment the revision without permanently archiving every past save or deprecated field.
  - In-flight requests retain the inputs they started with, while new runs apply the current source document and policies.
- **Translation and rewrite**:
  - New translation and auxiliary jobs construct their inputs from current settings and the required source data and memory; running jobs are not mutated for later setting changes.
  - Rewrites run fresh with current settings: intermediate scenes use an independent chat copy, and the final response may optionally be replaced after success. Candidate replay that replicates an old execution environment verbatim is not provided.
- **Lore selection consistency**:
  - Lore selection uses pre-selection by the judgment model or on-demand reading.
  - Starting a new chat from the bot can use the same active lore, and import does not create separate memories exclusive to the initial chat.
- **New chats and preview**:
  - A new chat selects the default first message when a native default `first_mes` is present.
  - The selector preview applies one-shot Lua `editDisplay`, CBS, and regexes at the exact stored content revision and renders into the same Shadow DOM message surface as the reader.
  - Previews do not persist chats or variables, do not call models, and disable selection buttons. The persona name is reflected, whereas separately attached modules and in-chat variables are excluded from this preview.
- **Replacing the first message**:
  - Opening **첫 메시지 바꾸기** (Replace first message) from the first message's overflow menu lets you select a different first message in the same chat.
  - It is offered when the original bot revision with alternate greetings is still available and no generation request or card button action has been executed in the chat.
  - Switching is allowed even after manually editing or translating the source text; previous source text, edits, and completed translations remain preserved in storage.
  - Only the newly selected first message is included in the current conversation, and any in-flight translation or image jobs for the previous first message are cancelled.
  - Manually set chat variables are preserved, no model is called, and clicking a card-authored first message does not open the generation info panel.
- **Chat backups and independent copies**:
  - Chat backups and independent copies preserve authored messages, card variables, and message mutations left by Lua.
  - Identifiers are rebound to the new chat without duplicating full model request payloads or call receipts, and neither scripts nor models are re-executed during import.
  - Responses written directly by card buttons are not treated as targets for writing-model re-requests.

### Lua lookup APIs and model options

- **Isolated workers and state lifecycle**:
  - Native Lua executes its initial script once per chat and content revision inside an isolated worker and keeps the same local/global values across subsequent callbacks.
  - Stored variables and conversation state are refreshed to the latest pinned snapshot on every call.
  - Chat history is hydrated inside the VM only when a script first calls a chat read/write API, and only calls that modify the chat return the updated conversation; callbacks that do not read the chat have execution time independent of conversation length.
  - Worker restarts, timeouts, runtime failures, or content changes discard that VM; persistent state must be kept via `getState` or chat variables.
  - Each authored script runs in an environment that cannot access internal RPCs or other scripts' permissions. Functions, `listenEdit` callbacks, and dynamic `load` retain their originating script's permissions and never merge permissions across calls.
  - `LLM`, `axLLM`, and `simpleLLM` forward only permitted originating calls to the Uimori host, and display callbacks disallow model calls. Unsupported APIs fail with explicit errors.
- **Tracking upstream API changes**:
  - New Risu Lua APIs or events are not supported automatically. Card code composed of already-supported APIs uses the existing execution path, whereas new UI behaviors, storage, or model capabilities must be wired and verified in Uimori.
  - The developer [Lua change comparison tool](DEVELOPMENT.md#risu-lua-upstream-changes) reports upstream API, wrapper, and callback changes along with whether each name is exposed by the current bridge. Name exposure does not guarantee identical behavior to Risu, and the tool does not update the runtime.
- **Message roles and generation control**:
  - For `LLM` and `axLLM` message roles, Risu's `sys` is mapped to `system` and `bot`/`char` to `assistant`, preserving content and ordering.
  - Trigger `v2StopPromptSending` is recognized as the generation-stop effect; legacy `v2StopPrompt` and `stop` in existing content are read as the same stop behavior.
- **`editDisplay` callback chain**:
  - `editDisplay` callbacks run in sequence and forward only string return values to the next callback.
  - `nil`, numbers, booleans, and other non-string values retain the previous string. Return-value validation for other edit callbacks remains unchanged.
- **Lookup API details**:
  - `hash(id, text):await()` returns the lowercase hex SHA-256 of a UTF-8 string.
  - `getTokens(id, text):await()` uses the tokenizer of the writing model pinned at run start, falling back to the existing default tokenizer if no model is present. As in Risu, it returns `nil` instead of a token count inside display callbacks or for an invalid ID.
  - `getAuthorsNote(id)` returns the raw chat author's note without mixing in preset defaults; CBS's effective author's note may still use the preset default.
  - `getPersonaDescription(id)` evaluates CBS on the persona description pinned for the run and returns the result.
  - `getLoreBooks(id, search)` reads lore entries whose `comment` matches `search` exactly, in bot-then-attached-content order, and applies CBS to each body. Card lore is read and returned in Risu DB format without saving source edits or changing lore selection state. Uimori notes are not treated as Risu chat-local lore. Active-lore assembly (`loadLoreBooks`) and lore mutations are unsupported.
- **`axLLM` options and modes**:
  - `options.mode` selects from the settings pinned for the run: `otherAx` (default: writing model if no script model is selected), `memory` (context compaction model), or `translate` (translation model).
  - If the selected script or context-compaction model or connection has been deleted, that call fails explicitly while keeping reservations for other writing or local card actions intact.
  - `emotion` and `submodel` return a failure because they have no corresponding roles, and an unconfigured role is never silently substituted with another model.
  - Invalid modes return a failure as in Risu, and the chosen mode is also reflected in model validation for call logs.
- **Streaming calls**:
  - `LLM` and `axLLM` collect the stream to completion on either the default transport path or `options.streaming=true` and return `{success, result}`.
  - On failure, `result` returns `Error:` with the error code and status, while any partial response and usage received before failure are recorded in the call log.
  - Because the current transport is streaming-based, an explicit `streaming=false` returns an unsupported failure. Generation parameters, connections, and authentication remain owned by Uimori model settings.
- **Multimodal inlays (`useMultimodal=true`)**:
  - In user messages, `{{inlay::이름}}`, `{{inlayed::이름}}`, and `{{inlayeddata::이름}}` resolve against the name/URI of card images attached to the current run or `request-image:<sha256>` references included in the run.
  - Only local image bytes are sent; Risu's separate UUID inlay store and external URLs are not queried.
  - As in original Risu, `inlay` and `inlayed` markers in assistant messages are stripped.
  - Image transmission on system or assistant roles and unresolvable references return a failure. Model image-input capability checks and existing input image limits also apply.
- **Lookup and safety boundaries**:
  - These lookup APIs add no network access, model calls, or mutations to source content, and display-path CBS and variable mutations continue applying only to display copies.
  - Character setters, image generation, external requests, embeddings, lore mutations, and arbitrary JavaScript execution are not included in this compatibility path.
- **CBS isolation and persistent VMs**:
  - CBS invoked by triggers and Lua reuses an isolated worker only within a single native run. Each CBS call executes sequentially with a fresh evaluator and the latest variables and conversation input, without caching results.
  - Inputs failing due to evaluation errors or timeouts are not retried, and the worker is discarded. If Lua catches the error and continues with another CBS call, it runs in a fresh worker without committing variable mutations from the failed evaluation.
  - After a run ends or is cancelled, the worker is not restarted, and per-call time and memory limits remain enforced.
- **Persistent VM lifecycle**:
  - Persistent VMs are used for chat runs and button actions. VM state from a cancelled run never carries into the next run, and delayed cleanup of a prior run never terminates the VM of a newly started run in the same chat.
  - Reader `editDisplay` and first-message previews run in a one-shot VM copied from saved state, so opening or refreshing a view never persists card state or invokes models; cards whose display callbacks depend on prior-run Lua local/global values must be checked for this difference.
  - HTML rendering in reader display transformation must finish within 10 seconds per call, including starting the request's first render worker. On failure, the stored body is displayed as-is, and Risu stage failures report their error code.
  - Prompt previews, helpers, and manual context compaction likewise do not re-run state-mutating input callbacks and instead use pinned CBS and regex copies.
- **Shadow DOM message surface**:
  - Each message renders inside a single open Shadow Root, preserving HTML structure and ID relationships.
  - CSS selectors inside a message do not apply as ordinary selectors to other messages or the app's library/settings views.
  - `html` and `body` selectors are not reinterpreted as separate document elements inside the Shadow Root; `rem`, viewport units, and media queries resolve against the app document. No separate iframe or cross-message communication bridge is used.
- **Content height and positioning**:
  - Content height is determined by document flow. Card `position: fixed` buttons and panels are positioned relative to the viewport as in RisuAI without reserving extra body height, while `position: absolute` backgrounds stay relative to the message area.
  - No dedicated fixed-element observer or height compensation is used. Fixed-width or fixed-position bot layouts are not automatically redesigned for mobile, so verification on actual cards is required.
- **Viewport size detection and re-rendering**:
  - Reader and first-message previews pass the actual browser viewport width and height to display requests. Display CBS and `cbs()` inside display Lua support `{{screenwidth}}`, `{{screen_width}}`, `{{screenheight}}`, and `{{screen_height}}`, and CSS and regexes receive the same values.
  - Active display views share a single resize listener and re-render with the current width and height once width changes settle briefly. Height-only changes (such as an on-screen keyboard or browser address bar toggling) do not trigger re-rendering and retain the last rendered height.
  - During re-rendering, the existing body stays visible and card actions are blocked until the new result is confirmed.
  - On re-renders with the same source and card-variable revision: if only CSS changes, the message DOM is kept; if HTML also changes, input/selection/disclosure states and input focus are preserved for elements uniquely identified by `id`, `risu-id`, or `name`. If the card changes its defaults or the source/card-variable revision changes, the new output takes precedence.
  - Viewport dimensions are not stored in source documents, chat variables, or run records; server-side evaluations lacking browser dimensions report those CBS macros as unsupported. Existing cards pick this up on the display path without re-importing.
- **Security assumptions**:
  - This surface assumes personal card content trusted by the user. DOMPurify continues stripping authored script elements, event handler attributes, iframes, and similar constructs, and the app document's CSP (`script-src 'self'`) further blocks inline and external scripts outside the app bundle.
  - Style, image, and font origins are not restricted, and there is no CSS network blocker. External resource requests send `Referrer-Policy: no-referrer` so the app URL is not exposed.
  - External resource references follow document and browser policies, while local import/resolution rules for Risu asset tags remain unchanged. Arbitrary JavaScript execution is not newly added, and existing trigger/Lua checks and server revision/run validations remain in place.
- **Trigger and button actions**:
  - Reading preferences apply to ordinary prose identified from display Markdown without restructuring authored UI or DOM relationships.
  - `risu-trigger` and `risu-btn` bind directly to the app's action handler and prevent duplicate execution after success until the next server revision.
  - A non-empty `risu-id` on a `risu-trigger` element is passed to CBS `{{trigger_id}}` for that manual run. On separate display requests it is `null`; Risu's lifecycle where the global identifier briefly lingers into subsequent displays is not replicated.
  - Failures can be retried, and stale failures never mutate the execution state of newer messages.
- **Inline forms (`risu-form`)**:
  - `<form risu-form="이름">` handles submission in-app and calls `onFormSubmit(id, 이름, JSON문자열)`.
  - The JSON payload has the shape `{data: {...}}`, representing multiple fields with the same name as a string array and including the submit button's name and value in the form data.
  - Native browser form validation (such as required inputs) and keyboard submission are preserved. Selected files are not transmitted (the UI notifies the user instead), and forms are never sent to external URLs.
  - Explicit `risu-trigger` and `risu-btn` clicks take precedence over surrounding form submission, and previews do not execute submissions. Form data and trigger IDs are included in retry request equivalence checks, while receipts in the prior request format remain readable.
- **Action reconfirmation and idempotency**:
  - When a choice response is not received, retries for the same scene, program, and payload reuse the original request key, data, and revision until the app is refreshed.
  - A scene replaced by an action inherits the original scene's identity, while choices on independent scenes are never merged even when their bodies match.
  - When multiple display views confirm the same request, they share the in-flight transport and release the lock only after all views finish reading.
  - Reconfirming an already-succeeded choice releases the lock without requiring a new revision; if only the post-success view read failed, only the view fetch is retried.
  - Once the server confirms failure, cancellation, or abort, that confirmation ends in failure and the next manual click starts a new attempt. Automatic retries are never performed, and this temporary reconfirmation state is never saved to durable drafts or backups.
- **Messages appended by output scripts**:
  - When an output script appends messages to a single response, display callbacks and regexes run on each message using its conversation index and render them together without repeating an already-displayed user request.
  - Source anchors for translation and auto-image placement remain linked to the stored body, and script-appended messages stay in original text even in translation view.
- **Display asset matching**:
  - Display asset matching checks exact name, URI, and extension aliases first. If none matches, it applies Risu's default rule: lowercase, strip known media extensions and separators, and pick the closest match within Levenshtein distance 4, preserving original asset order on ties.
  - Only stored local assets are eligible candidates; external URLs are not used. Automatic image placement also verifies that applying these display rules resolves to the exact chosen image.
  - Automatic image placement reconstructs a card's dedicated image-tag rule when present, and falls back to native `{{img::...}}` asset-insertion syntax for Risu assets without a dedicated rule. Even when an older import stored an unquoted `src={asset}` template, compatible quoted forms are also checked if the actual `editdisplay` rule requires quotes.
- **Manual context operations**:
  - Manual context operations evaluate CBS, regexes, and RISUP fields on a copy of the pinned input without using the main run's persistent Lua VM, input/request/output callbacks, or extra model calls, and without mutating chat variables or main responses.
  - Omitted callbacks are recorded in the run receipt, and model calls required for context compaction use existing job budgets and transport receipts.
- **Trigger permissions**:
  - Trigger permissions for a card and its embedded module follow the card's `extensions.risuai.lowLevelAccess`, defaulting to off when omitted.
  - Standalone `.risum` modules follow the module's own `lowLevelAccess`, and attached items retain their respective source's permission level when executed together. Individual fields on source triggers are preserved but cannot bypass this top-level permission gate.

### Native lore positioning

For new native cards, `@@depth`, `@@end`, `@@reverse_depth`, and `@@role` are preserved as the role and position of active lore entries:

- `@@depth 0` and `@@end` are placed in final instructions.
- Positive `@@depth` inserts at a forward index of the actual transmitted conversation.
- `@@reverse_depth` inserts relative to the end of the transmitted conversation.
- Insertion follows Risu's calculation rather than flipping direction based on depth conventions from other apps. Original insertion order is preserved, and conditional entries are placed only when present in the pinned lore selection for the run.

`@@depth 0` and `@@end` still use the final-instruction position even if the preset relocated the `postEverything` slot to the middle; reproducing that special slot relocation or applying the slot's wrapper across all lore messages is not replicated identically.

Positioned entries are excluded from generic lore/reference slots and automatic background reference messages to avoid duplicate delivery. Pinned lore token budgets and the source/reference scope of search and read tools remain unchanged, and app memories or user notes are never turned into synthetic chat turns. Unsupported directives such as `@@position`, `@@inject_*`, and negative or out-of-range depths continue to be surfaced as import notices. This contract does not mutate the original card document in the library; `nativeRisuPosition` is a storage and runtime projection field.

### Moving image-selection instructions

In import review and the native editor's **이미지 선택과 삽입을 Uimori에 맡기기** (Delegate image selection and insertion to Uimori) section, inspect source fields, lore entries, and handoff ranges. Only lore entries or titled sections that explicitly declare image-tag rules—and only when a display regex consumes `<img...>`—are proposed as automatic candidates. Ranges whose CBS block boundaries do not match are not selected by default and must be selected manually after checking the preview. When the source text changes, prior selections are never automatically reattached to different content.

Under chat settings' **이미지** (Images) tab, **이미지 배치 담당** (Image placement owner) chooses exclusively between **본문 모델** (Body model) and **판단 모델** (Judgment model; default: JEV):

- **본문 모델** (Body model): Provides the original image instructions and usable image list in the writing input and asks the model to insert image tags into the body. If 95% or more of the words making up image names appear in the card description, lore, or card instructions included in this request, the card is treated as explaining its own naming convention and those names are omitted from the list. If the remaining names exceed 100, they are sent as a name tree writing shared prefixes once; images with descriptions and lists of 100 or fewer items are sent individually verbatim.
- **판단 모델** (Judgment model): Excludes the selected instruction ranges from writing and translation inputs, and runs the judgment model separately after the body and translation finish. Translation does not have a separate image owner setting. For scenes with automatic translation enabled, images are auto-placed only on the translation; placement on the original text runs when **이미지 자동 배치** (Auto-place images) is clicked in the original-text view's scene menu. Scenes where automatic translation could not be scheduled receive placement directly on the original text.

When **판단 모델** is selected, display copies strip body image markup matching native aliases or tags bound to the current image list and render only the judgment model's placements, without removing arbitrary external images or ordinary HTML. When **본문 모델** is selected, body tags are displayed and prior judgment-model placements are hidden. Switching this setting preserves stored responses, previous placement records, and card/module source documents. `imageHandoff` stores the range's source text—including tag syntax, outfit, emotion, and position conditions—along with its originating field, start/end offsets, and selection state. Generating new illustrations is independent of this setting.

Enclosing CBS conditions around image instructions are also evaluated in their originating field before extracting the target range—for example, image instructions inside different age or outfit branches are not forwarded unconditionally together. Evaluation applies only to copied variables, surrounding writing instructions are not moved to the image model, and disabled lore entries and folders are never moved as image instructions.

Asset and paragraph references returned by the selection model pass existing hash and revision checks and apply only to display copies. Only tags whose original regex resolves to the exact same local asset are reverse-matched and inserted, allowing use of the card's image frame. Currently `<img="이름">` and `<img src=이름>` families are inspected; if an outfit variable resolves to a different image or no matching asset exists, nothing is inserted. Images from external modules are not downloaded, and missing images are never substituted with another image. This is not a general reimplementation of arbitrary tag, regex, or Lua image-generation rules.

New illustration generation uses existing Uimori illustration settings and an independent queue. Ordinary native writing responses are eligible for automatic generation scheduling and reader illustration display, whereas card first screens and button-authored text are not auto-scheduled. No separate Lightboard module is built in. Tests verify tag, regex, and asset bindings on local fixtures along with synthetic generation completion.

### Large files and assets

- **PNG cover and attachment linking**:
  - When PNG `assets` is omitted, the CCv3 default `icon/main` is linked to the cover image; an explicit empty array is preserved as-is.
  - The representative image prefers `icon/main` first and is not replaced by a later background or general image of the same name. Cards without an icon fall back to existing image selection rules.
- **Attachment path normalization**:
  - PNG attachment `__asset:{path}` references read both numeric and named paths.
  - Original paths are used solely as lookup keys to find attachments, while temporary files and export paths are normalized to app-assigned sequence numbers. Duplicate attachment keys reject the import.
- **Server upload and staging**:
  - Card and module files larger than 24 MiB are **uploaded to the server first** before review instead of sent in the request body; input files are accepted up to 512 MiB.
  - The server reads the file on disk to analyze card metadata and attachments, validates and converts images, and stages the prepared result in temporary files.
  - The review screen shows the actual registrable result, and saving does not re-analyze or re-convert images.
- **Changing content kind and cancellation**:
  - Changing the content kind reuses the same staged images and folder, replacing only metadata.
  - Failure or cancellation preserves the previous review, and saving with a digest that does not match the changed kind prompts a re-review. Preparation in progress can be stopped with **자료 확인 취소** (Cancel content verification).
- **Temporary file lifecycle**:
  - Staged temporary results are excluded from durable storage and backups and deleted after registration or during expiration cleanup.
  - If temporary file cleanup fails after a successful save, the success response is still preserved and expiration cleanup removes them later. Expired reviews require re-selecting the file.
- **Storage scope**:
  - Regardless of file size, the original card/module JSON and supported images are saved as app content without storing a separate copy of the entire input container; keep the original file yourself if needed.
  - For generating a new CHARX from current content, see [Risu export](../RISU-EXPORT.md).
- **ZIP and RISUM processing limits**:
  - ZIP archives accept up to 32,768 internal entries, and cards/modules accept up to 12,288 logical assets; identical image bytes with different names or roles count as distinct assets while byte storage is deduplicated.
  - Individual ZIP entries are limited to 64 MiB, and total uncompressed size is limited to the greater of 64 MiB or 4× the input file size, capped at 1 GiB.
  - Total converted images are accepted up to 448 MiB, leaving room for card metadata and the ZIP central directory in content backups.
  - Standalone RISUM files share the 512 MiB input limit and per-image/JSON processing budgets. Images are processed under separate pixel and frame workload limits, and assets unsupported by the current image store (such as audio or video) are reported in notices.
- **Chunk splitting and URI normalization**:
  - PNG parsing separates `ccv3` card chunks from Risu attachment chunks and links the cover image to the `ccdefault:` reference; embedded data-URI images in JSON are also separated during file reading.
  - Attachment transport representations in new PNG and JSON imports are normalized to compact `embeded://` URIs while preserving image names, roles, extensions, ordering, and the input file's SHA-256.
  - Lore, HTML, and Lua bodies are not bulk-rewritten, and separated image bytes are excluded from the 8 MiB source JSON budget.

### Structured Risu module JSON

- **RisuToki project folder extraction**:
  - Exporting a `.risum` to a new folder via RisuToki's **파일 → 파일을 프로젝트 폴더로 추출…** (File → Extract file to project folder…) generates a `module.json` with the shape `{ "type": "risuModule", "module": {...} }`.
  - Select this file in the library Modules tab under **자료 가져오기** (Import content) and click **모듈 가져오기** (Import module). It registers as a module without auto-creating bots, chats, or progress memory, and can then be attached via an existing chat's bot/persona/module settings.
- **Standalone RISUM import**:
  - Standalone `.risum` files can also be read directly from the same screen. The entire module object is preserved in `nativeRisu.module`, while active lore, name, and description are projected for library display; module descriptions are not copied into writing bodies.
  - Binary assets and JSON PNG/JPEG/WebP/AVIF/GIF data-URL images use the same image storage path. Regexes, Lua, triggers, CSS, toggles, namespaces/MCP, and similar fields remain in source form, separate from runtime execution support.
- **ZIP packaging with assets**:
  - To bring over extracted folder images as well, **zip `module.json` together with the `.risutoki` folder** and select that ZIP; a single top-level wrapper folder is also supported.
  - Assets are bound to original module assets in the `risumAssetFiles` order from `.risutoki/workspace.json`, falling back to filename order of `.risutoki/risum-assets/*.bin` when that list is absent.
  - Formats are verified from actual image bytes, and missing files are marked unsupported. Archives are read strictly inside the ZIP without extracting to external paths or the local filesystem, and ambiguous project ZIPs containing multiple module definitions or mixed card and module definitions are rejected.
- **Source fidelity**:
  - Both RisuToki-extracted JSON/ZIP files and original RISUM files can be imported. Because the extraction tool applies normalization and strips deprecated fields, the two files are not treated as identical; the app saves the actual current source read and its supported images.

### Risu preset runtime

- **Preset import and storage**:
  - In prompt management's **프롬프트 가져오기** (Import prompt), select a `.risup` or legacy `.risupreset` binary, preset JSON, or RisuToki project ZIP.
  - **창작 프롬프트로 저장** (Save as writing prompt) preserves prompt-related source fields in `RisuPrompt.nativeRisuPreset`, and **가져온 프롬프트 편집** (Edit imported prompt) directly edits Risu message layout, CBS source, toggles, default variables, and regexes.
  - Runtime blocks are generated from the source rather than maintained as a separate manually ported copy. RPack, decompression, MessagePack decoding, and import review for `.risup` execute no code, and the current preset source is stored in standalone content backups.
- **Size and token budgets**:
  - No separate cap is placed on preset block count or the 750,000-character source size. Memory budgets for file processing and prompt execution, as well as token budgets sent to the actual model, are enforced at each boundary.
- **Memory slots and reference context**:
  - Risu's `memory` slot is not substituted with user notes. Uimori includes past summaries in the transmitted conversation context and delivers user notes and corrections as separate reference context.
  - Actual delivery follows the selected prompt and context assembly, and import notices explain that Risu slot positions and wrappers are not applied directly; extra slots are not added to duplicate the same summary.
  - Models, parameters, and tools are managed separately by Uimori and are neither import targets nor counted as unsupported loss.
- **CBS evaluation and regex pipeline**:
  - At runtime, CBS is evaluated verbatim inside a worker with time and output limits, and cross-field variable mutations share the same evaluation context. Evaluation results are pinned for the duration of the run; after completion only the continuation output remains, and reconnects or backup restores never re-run evaluation.
  - Preset regexes connect to native `editinput`, `editoutput`, `editprocess`, and `editdisplay` stages and evaluate CBS after capture substitution.
  - CBS `{{role}}` uses the role of the message being processed: `user` for input not yet appended to the conversation, `char` for output and first messages, and each message's own role for prior scenes and display stages. The same role applies to body text as well as regex patterns and replacement outputs.
  - The legacy 32-rule transform limit is not applied, while worker execution, memory, and output limits remain enforced. Host-special commands such as `@@inject`, `@@repeat_back`, and `@@emo`, along with certain Risu extension behaviors, are not yet executed and are reported as issues. Legacy Uimori ASTs and the shared text-transform format are unsupported.
- **Model and permission ownership**:
  - Uimori owns models, providers, authentication, generation parameters, and tool permissions. Importing or applying a RISUP never overwrites them and never exposes them in the native prompt editor.
  - Keep original files separately if non-imported connection details are needed. Creative quality of real bot and personal preset combinations requires separate evaluation.

### Prompt editing

Both the current prompt and saved presets edit the RISUP source for message layout, CBS, toggles, default variables, and regexes; model and connection settings are managed separately. See [Prompt execution](../PROMPT-RUNTIME.md) for format and storage contracts, and [Risu export](../RISU-EXPORT.md) for moving source documents and images.

### Ownership of stored data

The Risu source document is the editing and execution source of truth, and body, lore, and first-message projections are read representations derived from it. Request context carries content ID, role, name, and lore entry ID alongside text to distinguish items with identical names without appending provenance metadata to the card's original strings. Shared modules follow the current stored revision, while versions to keep separately are managed via explicit copies or backups. See [Input lifecycle](../EXECUTION.md) and [Standalone chat restore](../CHAT-BACKUP.md).

## Risu export

- **RISUP encoding format**: Encoded as MessagePack → Risu fixed-key AES-GCM → gzip → RPack. The fixed key used here is not privacy encryption.
- **Deprecated field policy**: Applies the same deprecation policy as RisuToki (`core/risu-deprecated-fields.ts`). Deprecated card fields (such as personality, scenario, system prompt), module `cjs`, and legacy top-level preset prompt fields are omitted from output.
- **Export API endpoints**:
  - `GET /api/content/:id/risu-export?expectedRevision=N`
  - `GET /api/prompt-presets/:id/risu-export?expectedRevision=N`
  - Returns an attachment response with a UTF-8 filename, `Cache-Control: no-store`, and an `X-Uimori-Revision` header.
  - Rejects with 409 if `expectedRevision` does not match the latest revision and returns 404 for hidden content. API calls omitting the expected revision read the latest stored revision.
- **Size and compression budgets**:
  - Maximum CHARX/RISUM output: 512 MiB (same as import).
  - Card and module JSON size: up to 8 MiB.
  - Asset count limit: up to 12,288.
  - Individual ZIP entry size: 64 MiB (total expanded size also adheres to import budgets).
  - Uncompressed-image logic: When comfortably within the file limit, PNG, JPEG, WebP, AVIF, and GIF images are stored uncompressed with their original bytes while JSON and text are compressed. For larger payloads, image compression is checked to see whether it fits within the file limit. If the compression ratio is too high, only a subset of entries is stored uncompressed to stay within re-importable size limits. Export is rejected if both final file size and expanded-size budgets cannot be satisfied together.
  - RISUP processing budget: Uses the same 24 MiB file and source processing budget as preset import.
  - Safety checks: Rejects files with ZIP path traversal, conflicting data under duplicate paths, or missing image bindings. Export never modifies stored state or original imported copies.
- **Related code and tests**:
  - Implementation: `server/risu-export.ts`, `server/risu-export-codec.ts`, `core/risu-deprecated-fields.ts`, `core/risu-native-assets.ts`, `web/NativeRisuAssetsEditor.tsx`
  - Test suites:
    - `tests/risu-export.test.ts`: Feeds saved and edited content back through the real card and preset importers to verify first messages, embedded modules, images, CBS/Lua sources, deprecation policy, and revision conflicts.
    - `tests/risu-native-assets.test.ts`: Verifies identifier and source preservation across asset addition, replacement, and removal.
    - (This verification does not mean every script was executed in the actual RisuAI app.)

## Risu native prompt runtime

RISUP import selects only prompt-related fields. API keys, endpoint URLs, model selection, and sampling settings are excluded from the active prompt and managed by Uimori model settings. `web/NativeRisuPresetEditor.tsx` edits source blocks, roles, ordering, CBS, toggles, default variables, and regexes; unvalidated JSON drafts are blocked from saving and retained in the editor.

Legacy options `jailbreakToggle`, `chainOfThought`, and `promptSettings` fields `sendName`, `sendChatAsSystem`, `postEndInnerFormat`, and `assistantPrefill` are removed from UI and execution. They are omitted without separate notices during import, new saves, and export, and `jailbreak` and `cot` blocks are dropped rather than converted to plain text. The conversation block's dependent option `chatAsOriginalOnSystem` and the `type2: jailbreak` classification are also removed. No compatibility branch is maintained to reproduce historical execution results of those features.

`promptControls()` computes the input UI from `customPromptTemplateToggle`. Select-toggle values are Risu string indices defaulting to `"0"` (first item), on/off toggles default to `"0"` (off), and text toggles default to the empty string, with no separate unset choice. Missing or null values resolve to those defaults while preserving already-selected values and explicit preset defaults. UI option definitions are not a separate authored source of truth. Current selections and saved combinations are persisted via workspace revision CAS, and combinations with mismatched definitions are not applied.

Chat options combine the preset with `customModuleToggle` from attached modules and `extensions.risuai.toggles` from the card without mutating the source preset. Compatible definitions sharing the same key share one value, while differing types or option sets report a conflict. Original keys—including Korean characters, dots, and other characters—are passed to CBS as `toggle_<원래 키>`, and object reserved keys are represented with collision-free host IDs. Card and module values are also protected by chat pinning, next-request definition hashes, and reservation transactions. Model, connection, and sampling choices are never overwritten by toggle sources.

### Execution and preservation

1. The server pins the run's conversation, request, variables, and timestamp.
2. The native CBS worker evaluates fields used by active blocks in order and records source/evaluation input hashes, evaluated text, variables, and diagnostics in `nativeRisuPresetProgram`. Removed jailbreak/cot items, post-end/response-start text, host-unexecuted memory blocks, and unused formats on empty slots do not even execute variable side effects. `{{jbtoggled}}` is always `0`.
3. `compileRisuPrompt()` assembles model messages from the evaluated Risu blocks plus host slots, conversation, dialogue examples, and toggle selections. The CBS execution context for characters, timestamps, and variables is used by the preceding native worker and is not passed as a separate copy to the compiler. `{{slot}}` is the raw-text insertion marker at this stage.
4. The provider encoder checks each logical message's role, completion state, and cache support, then serializes it for the target protocol.

The new compiler tag is `risu-native-prompt-2`. It preserves history identifiers and source hashes and rejects configurations that insert the same history twice. Risu's `memory` block does not inject separate memory; Uimori's prepared memory and context are used instead. Native prompts requiring pre-request preparation are never transmitted before CBS evaluation completes.

A card's `post_history_instructions` replaces the source text of the `type2: globalNote` block, substituting `{{original}}` with that block's body before evaluating CBS; it is not duplicated as a separate global instruction. `mes_example` parses speakers and `<START>` boundaries from the raw source first, evaluates CBS on each message body, and places them at the front of the `chat` range while preserving roles; examples are not persisted into actual chat history. `chatML` and conversation history preserve original roles and bodies. `innerFormat` and `role2` apply only to persona, description, and authornote. The compiler marks all messages complete and does not append a message for the removed `assistantPrefill` setting; current provider transports also reject prefill. Removed items do not produce import warnings, while review checks for other unsupported blocks and host settings remain active.

Recompilation projects pinned CBS results without repeating evaluation, rejecting receipts whose hash or field list differs from the source. Translations separately evaluate the current prompt pinned when scheduling the translation job without modifying card state or saved presets. The host places the source text to translate along with reference material and user notes captured when scheduling the new translation into the current user message, which the native `chat` block positions. Source text is not CBS-evaluated, and is forwarded separately as pinned model-input context only when the preset omits the current message.

Optional `collaboration` configures host read-only helper agents, and `execution.storySubmission` specifies the body submission contract; neither adds content syntax. Both follow the call-limit, cancellation, and pinned-input contracts in [Collaboration](../AGENT-COLLABORATION.md).

### Verification

`tests/risu-native-prompt-composition.test.ts`, `tests/risu-native-preset.test.ts`, and `tests/risu-native-semantics.test.ts` verify real vendored CBS, evaluation ordering, global-note replacement, example roles, toggles, slots, chat ranges, caching, blocking execution and side effects of deprecated options, and receipt consistency. `tests/risu-retired-execution.test.ts` verifies re-projection for new jobs started from historical source snapshots. `tests/chat-options.test.ts` verifies chat selection, scheduling, and backup boundaries for combined toggles. `tests/risu-preset-import.test.ts` verifies prompt-only import boundaries and storage. These tests do not judge creative or translation quality on real providers.

To explicitly verify real local content, set `UIMORI_RISU_LOCAL_CARDS` to a JSON array of CHARX paths and `UIMORI_RISU_SAMPLE_PRESET` to a preset path, then run `tests/risu-native-local-compatibility.test.ts`. This test avoids logging source text while verifying first/alternate message rendering, known source buttons, current request/output processing, and original file-hash immutability. Browser verification runs `scripts/verify-risu-native-samples.mjs` using the existing `UIMORI_RISU_SAMPLE_ROOT` and an optional preset path, with `--grep` explicitly narrowing scope. It checks selection, reopening, variable isolation in independently copied chats, and next-turn execution on desktop and mobile against a local mock provider. Screenshots rendering personal content are saved to the git-ignored verification folder only with `--visual`, and traces containing HTTP bodies are never saved.

### Source-preserving request context

In model requests, bot and persona descriptions are wrapped in `uimori_source`, and general lore is structured under `uimori_lore_sources` with per-source `source` and per-entry `entry` elements. Only attachment role, content name, content ID, lore ID, and title are exposed. The host reference message includes only a single sentence stating that source markers indicate content provenance and entry boundaries. No permission, knowledge-scope, or priority markers are added. This does not depend on any specific preset or toggle, and existing `innerFormat` applicability is preserved.

Provenance metadata is added solely to the request projection. XML attributes are escaped, while bodies that already ran through CBS or other execution stages are not modified during serialization. Empty content creates no wrapper, and only adjacent entries from the same source are grouped so selection, attachment, and entry ordering are preserved. Positioned lore is inserted once with provenance attached at its original role and depth. Reference entries not consumed by a slot carry the same metadata under JSON `risuSource`. These markers are reading boundaries for the model—neither XML-parsed bodies nor permission boundaries—and stored sources and source hashes are unchanged. When the same source has different bodies via per-connection edits, a short connection-order discriminator such as `source_scope="connection-1"` distinguishes source groups; this number only disambiguates connections within a pinned request and does not signify priority. Internal path JSON is not sent to the model.

`tests/risu-context-source.test.ts` and `tests/risu-native-lore.test.ts` verify provenance delivery, body preservation, attribute escaping, positioning, and duplicate prevention. Actual improvements in model comprehension require separate response evaluation.

The internal prompt compiler supports only the single `risu-native-prompt-2` semantics. Compatibility branches for older Uimori run-snapshot compilers are not maintained and are separate from the current support scope for external Risu source documents.

Options scoped to the next request only are current settings independent of the source revision. Reservations persist across source edits and are applied once in the actual generation-reservation transaction and then cleared. Option-definition changes are validated to prevent applying invalid values, and neither cancellation/replacement records nor full prompt copies are accumulated.

## Lore context and retention

Model-facing notes send their body once while retaining kind, author, source anchor, and imported provenance; stored notes, declarations, and editing/backup formats are unchanged. Host reference context provides this model-facing representation while preserving the original declaration text in stored `snapshot.story.notes`.

State is stored as **one latest `chat_lore_state` row per chat**. Context and read ranges needed for the next request are kept without accumulating full model inputs or tool events as permanent history. Existing ranges are preserved and non-overlapping new ranges are added; no model call re-summarizes read text on every turn.

Reference entries are placed as a separate user-role message near the source text where they were first read—or after the summary and before recent conversation if the original location has been compacted into a summary. This does not fabricate actual conversation messages or new tool calls.

Token counting runs locally using `o200k_base`. Per-snippet results are reused from a bounded cache without making remote token-counting calls, with no guarantee of exact match against another model's billed tokens. Source text is never mutated and CBS/Lua are never run separately for token counting.

When the lookup budget is exceeded, least-recently-used ranges are evicted. Evicted ranges are not restored by rescanning all past run logs; if the model reads them again, they enter as fresh reads. If pinned inputs alone exceed the budget, `LORE_PINNED_BUDGET_EXCEEDED` is reported. For ordering with the overall input planner, see [Context limits](../CONTEXT-LIMITS.md).

Each new request validates current content IDs, revisions, body hashes, and actual source text and notes. Content edits or detachment drop affected ranges, and changes to the read-time source or preceding source/notes invalidate lookup results derived from that context. When a looked-up item becomes pinned, it is not delivered twice.

Individual chat backups preserve user source text, notes, current variables, and chat-local lore so writing can continue. They are not archives of every historical selection or lookup record, and new copies rebuild the required context. Full DB snapshots preserve the current DB state alongside them. See [Execution input lifecycle](../EXECUTION.md).

Implemented in [selection & retention](../../server/lore-context.ts), [current state storage](../../server/lore-retention-state.ts), [ranges & placement](../../core/lore-context.ts), and [request assembly](../../server/prompt-snapshot.ts). `tests/lore-context.test.ts` checks read ranges, invalidation, budgets, and actual next-turn requests; `tests/lore-token-selection.test.ts` checks token counting and JEV selection.

## Bot translation guides

- **Prompt preview API**: In `POST /api/chats/:id/prompt-preview`, translation mode reflects the **bot guide and translation reference scope currently stored on the server** and also returns the guide content in the response's `translationGuide` field. When a preset omits the context slot, the guide is delivered via host supplemental context on the real request, so compilation output alone should not be treated as a missing guide. The existing `mapping-only` semantics of provider preview are preserved without claiming to reproduce full runtime tool calls. Main mode does not include this field.

### Server execution pipeline

- **Guide loading and encapsulation**: `server/translation-guide.ts` reads the current guide from the chat's pinned owning bot. When `server/source-editing.ts` accepts a translation job, it stores the bot ID, content revision, name, and guide in `job.input.translationGuide`, and `resolveJobPrompt` binds only this compact metadata to that translation snapshot. The DB is not re-queried mid-run to alter the guide, and there is no new history system reproducing every past content save or full prompt.
- **Context injection**: `translationInput` places the guide into `context.translationGuide`. Because it reuses the existing context slot and host supplemental delivery when the slot is omitted, the guide is delivered for default prompts, Hermēneía, and user presets that omit the context slot. Terms are not duplicated into a separate glossary slot, and translation-principle guidance hooks into the existing translation role's reference policy.
- **Reference scope separation (`contextMode`)**: The reference scope is stored as `contextMode` on the default translation policy and pinned onto new jobs (historical policies and jobs lacking a value resolve as `full`). Under `source-only`, translation input is constructed without background content, card variables, prior conversation, or notes before CBS evaluation, so even presets using background slots cannot pull back excluded content. Metadata needed to bind results—such as source ID and hash—is preserved, and neither the selected preset content nor stored source/content documents are modified.

### Tests and verification commands

```sh
npm run quality
npm test -- tests/translation-guides.test.ts tests/translation-prompt-delivery.test.ts tests/translation-continuity.test.ts tests/source-translation.test.ts
npm run build
npm run verify:translation-guides
```

- `tests/translation-guides.test.ts`: Verifies saving, validation, revert, content import/export, request-time pinning, judgment recovery, and preview/writing separation.
- `tests/translation-prompt-delivery.test.ts`: Verifies actual serialized outputs across all seven provider protocols for default, Hermēneía, and context-omitted presets across both reference scopes (each at least once), ensuring guides, terms, and source text are neither dropped nor duplicated and CBS literals remain intact. Separate native CBS cases verify exclusion of background data while preserving the preset's own defaults and toggle values. Uses local provider stubs.
- `verify:translation-guides`: Verifies in the real app at desktop and mobile widths: editing, saving, JSON editing, unsaved-input recovery, cancellation, term deletion, preserving invalid input, edit exposure across all content types, and preservation of source kinds.

## Built-in prompts

### Delivery and provenance

`server/builtin-prompts.ts` handles listing and creating independent copies. `GET /api/prompt-templates` returns only title, role, and description, while `GET /api/prompt-templates/:id` returns the selected program and default options; both APIs are read-only. Adding, editing, and selecting prompts use the existing preset and active-prompt APIs' validation, revision checks, and draft protection.

Phēmē uses the V5.6.0 r2 programs and default selections from `risu/prompts/phēmē/dist/uimori/pheme-roleplay.uimori.json` and `pheme-novel.uimori.json` in RisuToki's Phēmē v5.6.0 distribution (revision `921a84e`). These programs match directly importing the `.risup` of the same version. Original CBS, toggle declarations, regexes, and cache breakpoints are preserved, with only optional collaboration settings attached separately.

Hermēneía uses the program and default selections imported for the translation role from `dist/hermeneia-preset.risup` (v1.2.0). `server/builtin-prompts/` stores the bodies and default selections for all three presets along with two writing collaboration definitions.

Phēmē's four cache breakpoints are preserved in both **explicit caching** and **automatic caching** on Responses and Anthropic connections. In automatic mode, once all four breakpoints are used, only additional automatic breakpoints are omitted and recorded in preview diagnostics. Selecting a preset does not change the model's caching or output-token settings.

### Verification scope

`tests/builtin-prompts.test.ts` verifies initial selection on fresh setups, preservation of stored presets across existing-DB restarts, read-only listing, independent copies, pinned RP/novel modes, and collaboration settings. `tests/risu-native-prompt-composition.test.ts` checks CBS composition for both presets. Adding and editing flows from the built-in catalog are verified with `npm run verify:browser -- --grep BPTUI`.
