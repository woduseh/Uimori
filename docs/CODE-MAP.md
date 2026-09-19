# Code map

Entry points by feature. Paths are relative to the repository root; linked documents describe current behavior and supported scope.

| Area | Contracts | Entry points |
| --- | --- | --- |
| Risu native import and editing | [Import](RISU-IMPORT.md) | `core/risu-native.ts`, `server/character-card-file.ts`, `server/risu-native-import.ts`, `server/risu-native-projection.ts`, `server/risu-module-file.ts`, `web/RisuNativeFields.tsx` |
| RISUP prompt source and model separation | [Prompt runtime](PROMPT-RUNTIME.md), [import](RISU-IMPORT.md#risu-프리셋) | `core/risu-native-preset.ts`, `server/risu-preset-import.ts`, `server/risu-native-preset.ts`, `web/NativeRisuPresetEditor.tsx` |
| Native prompt composition, names, defaults, CBS | [Prompt runtime](PROMPT-RUNTIME.md), [packages](PACKAGES.md) | `core/risu-prompt.ts`, `core/template-variables.ts`, `core/package-runtime.ts`, `server/risu-native-cbs.ts` |
| Branch variables and history | [Shared variables](PROMPT-RUNTIME.md#분기-공유-변수) | `core/chat-variables.ts`, `server/chat-variables.ts`, `server/chat-variables-archive.ts`, `web/ChatVariables.tsx` |
| Packages, lore, opening scenes, images | [Packages](PACKAGES.md), [lore context](LORE-CONTEXT.md) | `core/risu-content.ts`, `server/product-store.ts`, `server/package-start.ts`, `server/package-images.ts`, `server/lore-selection.ts` |
| Risu native triggers, Lua, and authored actions | [Native import](RISU-IMPORT.md) | `server/risu-native-runtime.ts`, `server/risu-native-lua.ts`, `server/risu-native-lua-session.ts`, `server/risu-native-run.ts`, `server/risu-native-actions.ts`, `server/risu-native-host.ts` |
| Native message rendering and isolation | [Native import](RISU-IMPORT.md), [reading](READING.md) | `server/risu-native-render.ts`, `server/risu-native-worker.ts`, `server/risu-native-preview.ts`, `web/RisuMessageFrame.tsx`, `web/risu-message-frame.ts` |
| Reservations, model requests, recovery | [Snapshots](RESERVATION-SNAPSHOTS.md), [runtime](RUNTIME-SIMPLIFICATION.md) | `server/reservation-snapshot.ts`, `server/prompt-snapshot.ts`, `server/main-request.ts`, `server/model-runner.ts`, `server/snapshot-archive.ts` |
| Database, transfer, backup, source editing | [Migrations](DATA-MIGRATIONS.md), [transfer](NATIVE-TRANSFER.md), [backup](CHAT-BACKUP.md), [transcripts](CHAT-TRANSCRIPT.md) | `server/database-schema.ts`, `server/native-transfer.ts`, `server/chat-backup.ts`, `server/risu-native-archive.ts`, `server/chat-transcript.ts`, `server/source-editing.ts` |
| Prompts, model roles, providers | [Global models](GLOBAL-MODELS.md), [providers](PROVIDERS.md), [parameters](MODEL-PARAMETERS.md), [pricing](MODEL-PRICING.md) | `server/prompt-workspace.ts`, `server/provider-management.ts`, `server/provider-connection-test.ts`, `server/jev-provider.ts`, `server/jev-credentials.ts`, `core/model-capabilities.ts`, `core/provider-catalog.ts` |
| Context, summaries and narrative notes | [Context limits](CONTEXT-LIMITS.md) | `server/context-planning.ts`, `server/context-compaction.ts`, `server/context-store.ts`, `server/story-notes.ts`, `core/context-budget.ts` |
| Helper, drafts, collaboration | [Helper](USAGE.md#도우미와-독립-가정-장면), [context](CONTEXT-LIMITS.md), [collaboration](AGENT-COLLABORATION.md) | `server/helper-runtime.ts`, `server/helper-workspace.ts`, `server/edit-drafts.ts`, `server/agent-collaboration.ts` |
| Outlines and illustrations | [Outlines](OUTLINE.md), [illustrations](ILLUSTRATIONS.md) | `server/outline-store.ts`, `server/illustrations.ts`, `server/illustration-runner.ts`, `server/comfyui-client.ts`, `server/codex-runtime.ts` |
| Library, Reader, UI | [UI principles](UI-PRINCIPLES.md), [library](LIBRARY.md), [reading](READING.md) | `server/reader.ts`, `server/library-organization.ts`, `web/useStory.ts`, `web/SourceReader.tsx`, `web/Prose.tsx` |
| Diagnostics, installation, updates, releases | [Diagnostics](DIAGNOSTICS.md), [self-hosting](SELF-HOST.md), [updates](UPDATES.md), [Oracle release](ORACLE-RELEASE.md) | `server/diagnostic-report.ts`, `server/maintenance.ts`, `compose.yaml`, `deploy/nginx.conf`, `scripts/release-oracle.mjs`, `scripts/update-controller.mjs` |
| Tests and development environment | [Quality](QUALITY.md), [development](DEVELOPMENT.md) | `package.json`, `tests/`, `scripts/browser-verification.mjs`, `scripts/lib.mjs` |
