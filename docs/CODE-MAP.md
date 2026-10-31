# Code map

| Responsibility | Entry points | Current contract |
| --- | --- | --- |
| UI language, retained messages and localized display formats | `web/i18n.ts`, `web/LanguageSelect.tsx`, `web/locales/`, `web/api-errors.ts`, `web/pwa.ts`, `web/public/sw.js` | [UI language](I18N.md) |
| Composition, writing briefs and source-linked review | `core/outline.ts`, `server/outline-read.ts`, `server/outline-store.ts`, `server/outline-routes.ts`, `web/OutlinePanel.tsx` | [Outline workspace](OUTLINE.md) |
| Optional automatic original-work reference and helper Q&A context | `core/story-guide.ts`, `server/story-guide-store.ts`, `server/story-guide-runtime.ts`, `server/story-guide-routes.ts`, `server/helper-context.ts`, `web/StoryGuidePanel.tsx` | [Original-work reference](STORY-GUIDE.md) |
| Resource editing and local recovery | `web/resource-editor-session.ts`, `web/resource-editor.tsx`, `server/resource-service.ts`, `server/resource-routes.ts` | [Editing](EDITING.md) |
| Prompt library, selected presets and chat creative options | `web/PromptLibrary.tsx`, `web/PromptEditor.tsx`, `web/ChatOptionSettings.tsx`, `server/prompt-workspace.ts`, `server/chat-options.ts` | [Prompt runtime](PROMPT-RUNTIME.md), [Usage](USAGE.md) |
| Helper execution and app operations | `server/helper-runtime.ts`, `server/helper-app-tools.ts`, `server/helper-resource-tools.ts`, `server/helper-lore-read.ts`, `server/helper-settings-tools.ts`, `server/helper-task-tools.ts`, `server/helper-scene-tools.ts`, `server/helper-workspace.ts` | [Helper tools](HELPER-TOOLS.md) |
| Helper image/file input, stored CHARX image reads, drafts and retention | `core/request-files.ts`, `core/provider-files.ts`, `core/provider-image-reference.ts`, `server/request-files.ts`, `server/helper-image-tools.ts`, `server/helper-attachments.ts`, `server/helper-attachment-prompt.ts`, `web/helper-attachment-draft.ts` | [Helper attachments](HELPER-ATTACHMENTS.md), [Stored images](HELPER-TOOLS.md#stored-content-images) |
| Helper grep, partial reads and SQL | `server/helper-data-tools.ts`, `server/helper-data-worker.ts` | [Helper tools](HELPER-TOOLS.md) |
| Model-facing read/tool contracts | `core/read-tools.ts`, `core/knowledge-browse.ts`, `core/story-read-tools.ts`, `core/provider.ts`, `server/helper-data-tools.ts`, `server/helper-app-tools.ts` | [Tool contracts](TOOL-CONTRACTS.md) |
| Pricing from actual connection catalogs or manual rates | `core/model-pricing.ts`, `core/pricing-types.ts`, `server/helper-pricing-tools.ts` | [Usage and pricing](USAGE-REPORT.md), [Helper tools](HELPER-TOOLS.md#web-search-and-model-pricing) |
| Helper provider search and citation handling | `core/helper-web-search.ts`, `core/openai-protocol.ts`, `core/anthropic-protocol.ts`, `server/helper-runtime.ts` | [Helper tools](HELPER-TOOLS.md#web-search-and-model-pricing) |
| Provider/key configuration | `server/provider-connections.ts`, `server/credentials.ts`, `server/jev-credentials.ts`, `server/vertex-credentials.ts` | [Providers](PROVIDERS.md) |
| Codex App Server connection and native turns | `core/codex-protocol.ts`, `server/codex-process.ts`, `server/codex-runtime.ts` | [Codex](CODEX.md) |
| Illustration presets, scoped selection and frozen recipes | `core/illustration-presets.ts`, `core/illustration-workflow.ts`, `server/illustration-presets.ts`, `server/illustrations.ts`, `web/IllustrationPresetSettings.tsx` | [Illustrations](ILLUSTRATIONS.md) |
| Image conversion/storage/metadata | `server/image-processing.ts`, `server/image-storage.ts`, `server/asset-metadata.ts`, `web/ImageMetadataFields.tsx` | [Library](LIBRARY.md) |
| Independent copies and retries | `server/chat-copy.ts`, `server/chat-fork.ts`, `server/run-retry.ts`, `server/chat-media.ts` | [Chat backup](CHAT-BACKUP.md) |
| Unified backup-file and transcript import | `web/BackupFileImport.tsx`, `web/backup-file.ts`, `server/resource-bundle.ts`, `server/chat-backup.ts`, `server/chat-transcript.ts` | [Transfer](NATIVE-TRANSFER.md), [Chat backup](CHAT-BACKUP.md), [Transcript](CHAT-TRANSCRIPT.md) |
| Portable user resources | `server/resource-bundle.ts`, `server/transfer-images.ts`, `core/native-transfer-validation.ts` | [Transfer](NATIVE-TRANSFER.md) |
| DB schema and snapshot | `server/database-schema.ts`, `server/database-backup.ts` | [Data](DATA-MIGRATIONS.md) |
| Summary length defaults, frozen settings, and title generation | `core/summary-length.ts`, `core/context-summary-policy.ts`, `server/prompt-workspace.ts`, `web/ModelWorkspaceEditor.tsx`, `server/chat-title.ts` | [Execution inputs](EXECUTION.md) |
| Execution, context and notes | `server/run-executor.ts`, `server/store.ts`, `server/execution-snapshot.ts`, `server/execution-retention.ts`, `server/context-planning.ts`, `server/story-notes.ts` | [Execution inputs](EXECUTION.md) |
| Native Risu execution | `server/risu-native-run.ts`, `server/risu-native-runtime.ts`, `server/risu-native-lua-session.ts`, `server/risu-native-render.ts`, `server/risu-native-projection.ts` | [Risu import](RISU-IMPORT.md) |
| Model request fields, shared execution and provider protocols | `core/model-request-fields.ts`, `core/provider-request.ts`, `core/transport.ts`, `core/provider-http.ts`, `core/*-protocol.ts` | [Providers](PROVIDERS.md) |
| Composer translation and request copying | `core/input-translation.ts`, `server/input-translation.ts`, `web/useInputTranslation.ts`, `web/InputTranslation.tsx`, `web/RequestMessage.tsx` | [Input translation](INPUT-TRANSLATION.md) |
| Composer reference images and their lifetime | `core/request-images.ts`, `core/provider-image-reference.ts`, `core/provider-images.ts`, `server/request-images.ts`, `web/request-image-draft.ts`, `web/RequestImages.tsx` | [Usage](USAGE.md), [Execution](EXECUTION.md), [Chat backup](CHAT-BACKUP.md) |
| Authored first-message selection and removal | `server/package-start.ts`, `web/PackageStartPicker.tsx`, `server/import-operations.ts` | [First messages](READING.md#native-risu-첫-메시지). Removal detaches the head without an empty source/run, preserves history, and replays its durable receipt before revision checks. |
| Reader and application, delayed loading and retry | `web/useStory.ts`, `web/SourceReader.tsx`, `web/ReaderLoadingState.tsx`, `server/reader.ts`, `server/app.ts` | [Reading](READING.md), [UI principles](UI-PRINCIPLES.md) |
| Completed Markdown, reading decoration and canonical display anchors | `core/reading-markdown.ts`, `web/Prose.tsx`, `web/PlainProse.tsx`, `web/reading-dom.ts` | [Reading](READING.md) |
| Shared save conflicts and recovery decisions | `web/SaveConflictDialog.tsx`, `web/resource-editor-session.ts`, `web/resource-editor.tsx`, `web/main.tsx` | [Editing](EDITING.md), [Usage](USAGE.md) |
| All-chat activity inbox and receipts | `server/activity-feed.ts`, `web/useActivityFeed.ts`, `web/ActivityNavigation.tsx`, `web/BotTreeNavigation.tsx`, `web/ActivityStatus.tsx` | [PWA and activity notifications](PWA.md) |
| Notices and execution feedback | `web/NoticeBanner.tsx`, `web/TransientNotice.tsx`, `web/DismissibleError.tsx` | [UI principles](UI-PRINCIPLES.md) |
| Workspace, bot, and manuscript search UI | `web/ManuscriptSearch.tsx`, `web/BotTreeNavigation.tsx`, `web/BotNavigation.tsx` | [Manuscript search](MANUSCRIPT-SEARCH.md), [UI principles](UI-PRINCIPLES.md) |
| Rewrite requests and copy/replace choice, plus scene context controls | `server/scene-context.ts`, `server/prompt-snapshot.ts`, `core/story-context.ts`, `web/RequestMessage.tsx`, `web/SourceReader.tsx` | [Editing](EDITING.md) |
| Retained manuscript comparison and scene names | `web/SourceVersions.tsx`, `web/SceneTitleEditor.tsx`, `server/source-editing.ts`, `server/scene-titles.ts` | [Editing](EDITING.md), [Reading state](READING-STATE.md) |
| Tests and local verification | `tests/`, `scripts/verify-*.mjs` | [Development](DEVELOPMENT.md) |
| Automatic translation and final request notifications | `server/auto-translation-defaults.ts`, `web/AutoTranslationDefaults.tsx`, `server/store.ts`, `server/source-editing.ts`, `server/push-events.ts`, `server/push-service.ts`, `web/RuntimeSettings.tsx`, `web/PushSettings.tsx`, `web/public/sw.js` | [PWA and push](PWA.md) |
| Bot translation guides | `core/translation-guide.ts`, `server/translation-guide.ts`, `web/TranslationGuideEditor.tsx` | [Translation guides](TRANSLATION-GUIDES.md) |

Theme resources and selection: `core/themes.ts`, `server/themes.ts`, `web/ThemeContext.tsx`, `web/ThemeSettings.tsx`, `web/ThemeFrame.tsx`. [Authoring and usage](THEME-AUTHORING.md).
Standalone palettes and uploaded fonts: `core/theme-palettes.ts`, `core/fonts.ts`, `server/fonts.ts`, `web/PaletteSettings.tsx`, `web/FontContext.tsx`, `web/FontSettings.tsx`. Helper registration and selection: `server/helper-presentation-tools.ts`.

Operational failures remain in task status, provider error details and execution inputs; there is no separate anonymous diagnostic-report generator. See [Troubleshooting](DIAGNOSTICS.md).

Saved-text lifetime is implemented in `server/text-retention.ts`; pending image reclamation uses `server/unused-data.ts`. Import retry receipts are shared in `server/import-operations.ts`. See [DATA-MIGRATIONS](DATA-MIGRATIONS.md) for the current storage contract, not historical execution-replay assumptions.
Scene deletion and manual orphan-memory review: `server/scene-deletion.ts`, `server/orphan-memory.ts`, `web/SceneDeleteAction.tsx`, `web/OrphanMemoryPanel.tsx`. See [deletion](DELETION.md).

Provider editing keeps independent in-memory drafts in `web/provider-editor-state.ts`; `web/ProviderManagement.tsx` coordinates lists and navigation, while `web/ProviderConnectionForm.tsx` and `web/ProviderModelForm.tsx` own the mounted forms.
