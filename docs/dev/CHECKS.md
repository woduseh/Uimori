# Choosing checks

Choose checks that can expose failures caused by the change. Completing a feature or making a commit does not, by itself, require a full suite. Runner details, builds and troubleshooting live in [DEVELOPMENT](DEVELOPMENT.md).

| Change or question | Useful checks |
| --- | --- |
| Any code change, as a first pass | `npm run check:changed`, or `npm run check:changed -- <base>` for committed branch work; then add the focused checks below that it does not cover |
| Code behavior | Focused tests, such as `npm test -- tests/<file>.test.ts`; use `npm run quality` for lint and type checks when relevant |
| UI behavior | The relevant `verify:*` command against a matching build; `verify:browser-smoke` covers basic chat and global prompt settings |
| Stylesheets under `web/` | `npm test -- tests/style-spacing.test.ts tests/themes.test.ts`; the spacing scale and the startup palette are Vitest checks that the `verify:*` browser runners do not run |
| Verification tooling | Tests for the affected runner; `npm run test:tooling` covers the full tooling suite |
| Cross-cutting changes beyond focused coverage | Consider `npm run quality:full` and broader browser coverage for the interactions at risk |
| Documentation only | Run `node scripts/check-documentation.mjs` and `git diff --check`; review accuracy, commands and consistency |
| Release candidate | `npm run release:check -- --area <verify:*>`; see [DEVELOPMENT](DEVELOPMENT.md#release-checks) |

Use the smallest existing tests that exercise the affected behavior and plausible failures. Add tests for gaps that matter, rather than mirroring implementation. Once the relevant checks pass, finish. Rerun or expand only for a subsequent change, failure, or unresolved risk.

`check:changed` finds Vitest files through the import graph of changed modules and, for other files, by a test naming the file or its extension, so a test that locates files another way is missed. A hub module such as `core/provider.ts` selects nearly the whole suite. It does not build: tests that start the compiled server fail with "Run npm run build" until the build matches the source. It skips Vitest for documentation-only changes, as CI does.

`quality` runs Biome, TypeScript, the comment check and `check:i18n` without starting the app or a browser; the CI static job runs it; `check` runs TypeScript alone. `test:tooling` creates a fresh build before running build, verification and release-tooling tests, so it also works from a clean checkout. `quality:full` runs `quality`, that build-backed tooling suite, then the complete Vitest suite. The build precedes Vitest because some tests restart the compiled server. Vitest uses a 30-second per-test emergency cap for hosted runner variance; operation-specific polls and network deadlines remain explicit and shorter.

Linux shell changes also run `npm test -- tests/main-shell.test.ts tests/helper-shell.test.ts tests/helper-shell-runtime.test.ts tests/helper-runner.test.ts` on Linux: these exercise writer reference exports, real Unix sockets, Bash, Python, temporary SQLite saves, transport failures, and process cancellation. The Linux Vitest shards in CI run them. Windows runs portable shell checks but skips the Unix socket and runner cases.

Helper data/gateway changes use `npm test -- tests/helper-data-tools.test.ts tests/helper-data-runtime.test.ts tests/helper-tool-contracts.test.ts tests/helper-resource-editing.test.ts tests/helper-settings-tools.test.ts tests/helper-task-tools.test.ts tests/helper-compaction.test.ts tests/helper-workspace.test.ts tests/context-compaction.test.ts`. The data tests use real read-only SQLite child processes; runtime tests exercise native Chat encoding/decoding against intercepted synthetic responses, not a paid provider. The manual-compaction regression counts full writer projections rather than enforcing a machine-dependent time threshold. Build before checking compiled child-process or browser execution. [Helper goal evaluation](HELPER-EVALUATION.md) defines the synthetic task oracles and real-model evidence boundary; `npm test -- tests/helper-data-runtime.test.ts --reporter=verbose --silent=false` emits per-case cumulative `HELPER_GOAL_METRICS`, including helper and compaction calls. These fixture metrics are not autonomous model scores.

Helper code-check changes use `npm test -- tests/helper-code-tools.test.ts tests/helper-plan-mode.test.ts tests/helper-discovery.test.ts tests/tool-contract-portability.test.ts tests/app-guides.test.ts`. Their Lua syntax and regex checks run the real Lua and evaluator workers on synthetic resources.
