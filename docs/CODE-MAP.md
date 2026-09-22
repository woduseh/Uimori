# Code map

| Responsibility | Entry points | Current contract |
| --- | --- | --- |
| Resource editing and local recovery | `web/resource-editor-session.ts`, `web/resource-editor.tsx`, `server/resource-service.ts`, `server/resource-routes.ts` | [Editing](SAVE-PERFORMANCE.md) |
| Helper app tools | `server/helper-runtime.ts`, `server/helper-resource-tools.ts`, `server/helper-workspace.ts` | [Usage](USAGE.md) |
| Provider/key configuration | `server/provider-connections.ts`, `server/credentials.ts`, `server/jev-credentials.ts`, `server/vertex-credentials.ts` | [Providers](PROVIDERS.md) |
| Image conversion/storage/metadata | `server/image-processing.ts`, `server/image-storage.ts`, `server/asset-metadata.ts`, `web/ImageMetadataFields.tsx` | [Library](LIBRARY.md) |
| Independent copies and retries | `server/chat-copy.ts`, `server/chat-fork.ts`, `server/run-retry.ts`, `server/chat-media.ts` | [Chat backup](CHAT-BACKUP.md) |
| Portable user resources | `server/resource-bundle.ts`, `server/transfer-images.ts`, `core/native-transfer-validation.ts` | [Transfer](NATIVE-TRANSFER.md) |
| DB schema, snapshot, one-time transfer | `server/database-schema.ts`, `server/database-backup.ts`, `scripts/transfer-personal-v1.mjs`, `scripts/legacy24-source.mjs` | [Data](DATA-MIGRATIONS.md) |
| Execution, context and notes | `server/store.ts`, `server/execution-snapshot.ts`, `server/execution-retention.ts`, `server/context-planning.ts`, `server/story-notes.ts` | [Execution inputs](RESERVATION-SNAPSHOTS.md) |
| Native Risu execution | `server/risu-native-runtime.ts`, `server/risu-native-lua-session.ts`, `server/risu-native-render.ts`, `server/risu-native-projection.ts` | [Risu import](RISU-IMPORT.md) |
| Provider protocols | `core/provider-request.ts`, `core/provider-http.ts`, `core/*-protocol.ts` | [Providers](PROVIDERS.md) |
| Reader and application | `web/useStory.ts`, `web/SourceReader.tsx`, `server/reader.ts`, `server/app.ts` | [Usage](USAGE.md) |
| Tests and local verification | `tests/personal-workspace-*.test.ts`, `scripts/transfer-personal-v1.test.mjs`, `tests/` | [Development](DEVELOPMENT.md) |
