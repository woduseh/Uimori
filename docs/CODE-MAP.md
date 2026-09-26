# Code map

| Responsibility | Entry points | Current contract |
| --- | --- | --- |
| Resource editing and local recovery | `web/resource-editor-session.ts`, `web/resource-editor.tsx`, `server/resource-service.ts`, `server/resource-routes.ts` | [Editing](EDITING.md) |
| Helper execution and app operations | `server/helper-runtime.ts`, `server/helper-app-tools.ts`, `server/helper-resource-tools.ts`, `server/helper-workspace.ts` | [Helper tools](HELPER-TOOLS.md) |
| Helper grep, partial reads and SQL | `server/helper-data-tools.ts`, `server/helper-data-worker.ts` | [Helper tools](HELPER-TOOLS.md) |
| Model-facing read/tool contracts | `core/read-tools.ts`, `core/story-read-tools.ts`, `core/provider.ts`, `server/helper-data-tools.ts`, `server/helper-app-tools.ts` | [Tool contracts](TOOL-CONTRACTS.md) |
| Provider/key configuration | `server/provider-connections.ts`, `server/credentials.ts`, `server/jev-credentials.ts`, `server/vertex-credentials.ts` | [Providers](PROVIDERS.md) |
| Image conversion/storage/metadata | `server/image-processing.ts`, `server/image-storage.ts`, `server/asset-metadata.ts`, `web/ImageMetadataFields.tsx` | [Library](LIBRARY.md) |
| Independent copies and retries | `server/chat-copy.ts`, `server/chat-fork.ts`, `server/run-retry.ts`, `server/chat-media.ts` | [Chat backup](CHAT-BACKUP.md) |
| Portable user resources | `server/resource-bundle.ts`, `server/transfer-images.ts`, `core/native-transfer-validation.ts` | [Transfer](NATIVE-TRANSFER.md) |
| DB schema, snapshot, one-time transfer | `server/database-schema.ts`, `server/database-backup.ts`, `scripts/transfer-personal-v1.mjs`, `scripts/legacy24-source.mjs` | [Data](DATA-MIGRATIONS.md) |
| Execution, context and notes | `server/run-executor.ts`, `server/store.ts`, `server/execution-snapshot.ts`, `server/execution-retention.ts`, `server/context-planning.ts`, `server/story-notes.ts` | [Execution inputs](EXECUTION.md) |
| Native Risu execution | `server/risu-native-runtime.ts`, `server/risu-native-lua-session.ts`, `server/risu-native-render.ts`, `server/risu-native-projection.ts` | [Risu import](RISU-IMPORT.md) |
| Model request fields and provider protocols | `core/model-request-fields.ts`, `core/provider-request.ts`, `core/provider-http.ts`, `core/*-protocol.ts` | [Providers](PROVIDERS.md) |
| Composer translation and request copying | `core/input-translation.ts`, `server/input-translation.ts`, `web/useInputTranslation.ts`, `web/InputTranslation.tsx`, `web/RequestMessage.tsx` | [Input translation](INPUT-TRANSLATION.md) |
| Reader and application | `web/useStory.ts`, `web/SourceReader.tsx`, `server/reader.ts`, `server/app.ts` | [Usage](USAGE.md) |
| Tests and local verification | `tests/personal-workspace-*.test.ts`, `scripts/transfer-personal-v1.test.mjs`, `tests/` | [Development](DEVELOPMENT.md) |
| Bot translation guides | `core/translation-guide.ts`, `server/translation-guide.ts`, `web/TranslationGuideEditor.tsx` | [Translation guides](TRANSLATION-GUIDES.md) |

Theme resources and selection: `core/themes.ts`, `server/themes.ts`, `web/ThemeContext.tsx`, `web/ThemeSettings.tsx`, `web/ThemeFrame.tsx`. [Authoring and usage](THEME-AUTHORING.md).

Saved-text lifetime is implemented in `server/text-retention.ts`; pending image reclamation uses `server/unused-data.ts`. Import retry receipts are shared in `server/import-operations.ts`. See [DATA-MIGRATIONS](DATA-MIGRATIONS.md) for the current storage contract, not historical execution-replay assumptions.

Provider editing keeps independent in-memory drafts in `web/provider-editor-state.ts`; `web/ProviderManagement.tsx` coordinates lists and navigation, while `web/ProviderConnectionForm.tsx` and `web/ProviderModelForm.tsx` own the mounted forms.
