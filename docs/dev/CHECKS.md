# Choosing checks

Choose checks that can expose failures caused by the change. Completing a feature or making a commit does not, by itself, require a full suite. Runner details, builds and troubleshooting live in [DEVELOPMENT](DEVELOPMENT.md).

| Change or question | Useful checks |
| --- | --- |
| Any code change, as a first pass | `npm run check:changed`, or `npm run check:changed -- <base>` for committed branch work; then add the focused checks below that it does not cover |
| A delegated unit with a fixed scope | `npm run check:unit-diff -- --base <ref> --allow '<glob>'`: fails on paths outside the globs, fewer test cases without `--allow-test-removal`, new `.skip`/`.only`/`.todo`/`.fixme`, and a `package.json` version change |
| Code behavior | Focused tests, such as `npm test -- tests/<file>.test.ts`; use `npm run quality` for lint and type checks when relevant |
| UI behavior | `npm run verify -- <domain>` for the [feature map](../../tests/feature-map.json) domain that owns the change, or `npm run verify -- --changed`, against a matching build; `browser-smoke` covers basic chat and global prompt settings. The [verify skill](../../.agents/skills/uimori-verify/SKILL.md) is the standard loop |
| Stylesheets under `web/` | `npm test -- tests/style-spacing.test.ts tests/themes.test.ts`; the spacing scale and the startup palette are Vitest checks that the browser runs do not cover |
| Verification tooling | Tests for the affected runner; `npm run test:tooling` covers the full tooling suite |
| Cross-cutting changes beyond focused coverage | Consider `npm run quality:full` and broader browser coverage for the interactions at risk |
| Documentation only | Run `node scripts/check-documentation.mjs` and `git diff --check`; review accuracy, commands and consistency |
| Release candidate | `npm run release:check -- --area <domain>`; see [DEVELOPMENT](DEVELOPMENT.md#release-checks) |

Use the smallest existing tests that exercise the affected behavior and plausible failures. Once the relevant checks pass, finish. Rerun or expand only for a subsequent change, failure, or unresolved risk.

## Which tests to keep

This is a personal app: a miss found in use is recoverable, while tests that pin old behavior made each change of direction cost several test edits. Write or keep a test only when it protects one of these:

- saved user data: writes, backup and restore, import and export, deletion boundaries;
- typed but unsaved input surviving failure, reload and conflict;
- credentials, sessions and access boundaries;
- wire formats to providers and Risu file compatibility;
- real concurrency and recovery failures;
- one representative browser flow per feature;
- deterministic structure: module cycles, import boundaries, i18n keys.

Do not write, and remove when you touch the area: the same flow at another viewport or colour scheme; pixel, geometry, copy-text and class pins; assertions that a removed control is absent; failure, retry and conflict combinations repeated per form when one shared mechanism handles them; unit tests that mirror the implementation; several cases that fail for the same mistake; tests of diagnostic wording.

Before deleting a browser case, name the component and action it exercises and find another browser case that mounts it. In the 2026-11 browser cut, a headless or server test named as the replacement usually did not cover the case, and most such deletions were restored in review.

## What the commands cover

`check:changed` counts deleted files as changes; only Biome is limited to files that still exist. It finds Vitest files through the import graph of changed modules and, for other files, by a test naming the file or its extension, so a test that locates files another way is missed; a root user guide under `docs/` also selects `tests/app-guides.test.ts`. A hub module such as `core/provider.ts` selects nearly the whole suite, so a local run executes at most 30 files (`--limit <n>`), tests named after or directly importing a changed module first, and prints how many it left out; `--all` or `CI=true` runs every affected file. A changed `scripts/` file runs its `scripts/<name>.test.mjs` and any tooling test that imports it, directly or through other scripts and hooks; `.githooks/` or `.claude/hooks/` changes do the same, or run the whole tooling suite when no such test exists. A selected tooling test that mentions `dist/` triggers a build first, as does the full tooling suite. Global configuration (`fullSuiteInput` in `scripts/change-classifier.mjs`) prints `scope: full-required`, because the import graph cannot show what it affects; run `quality:full` before finishing.

`check:changed -- --list-json [<base>]` prints the same selection as JSON without running anything; its `affectedTests` lists every affected Vitest file, ignoring the limit. PR CI reuses this selection instead of a second rule set: `scripts/ci-vitest.mjs <shard> --impact-base <sha>` runs only `affectedTests` and runs every test when `fullRequired` is not empty. `--exclude-dist` and `--dist-only` split off `distTests`, the Vitest files that start the compiled server, so only the job that runs them needs a build. An impact run reaches those files only through their imports, and `tests/background-work.test.ts` imports none of the sources it exercises, so only a full run checks it against a source change. `scripts/ci-changes.mjs` reports `windows_sensitive=false` only when every changed file is under `web/`, documentation, or a browser spec.

Biome, TypeScript, the comment check and `check:i18n` run in parallel. The comment check receives only the changed files (`node scripts/check-comments.mjs <file> ...` checks those files and their allowlist entries), unless the checker or its allowlist changed. `check:i18n` runs only for changes under `web/`, which holds the locale catalogs, or to the checker; it also reads `core/`, `server/`, `scripts/` and `tests/` for unused keys, so removing the last use of a key there is caught by `quality`. Apart from the full tooling suite, it does not build: tests that start the compiled server fail with "Run npm run build" until the build matches the source, and a change to `server/index.ts` or `server/app.ts` prints that reminder. It skips Vitest and tooling tests for documentation-only changes, as CI does.

`quality` runs Biome, TypeScript, the comment check and `check:i18n` without starting the app or a browser; the CI static job runs it; `check` runs TypeScript alone. `test:tooling` creates a fresh build before running build, verification and release-tooling tests, so it also works from a clean checkout. `quality:full` runs `quality`, that build-backed tooling suite, then the complete Vitest suite. The build precedes Vitest because some tests restart the compiled server. Vitest uses a 30-second per-test emergency cap for hosted runner variance; operation-specific polls and network deadlines remain explicit and shorter.

Linux shell changes also run `npm test -- tests/main-shell.test.ts tests/helper-shell.test.ts tests/helper-shell-runtime.test.ts tests/helper-runner.test.ts` on Linux: these exercise writer reference exports, real Unix sockets, Bash, Python, temporary SQLite saves, transport failures, and process cancellation. The Linux Vitest shards in CI run them. Windows runs portable shell checks but skips the Unix socket and runner cases.

Helper data/gateway changes use `npm test -- tests/helper-data-tools.test.ts tests/helper-data-runtime.test.ts tests/helper-tool-contracts.test.ts tests/helper-resource-editing.test.ts tests/helper-settings-tools.test.ts tests/helper-task-tools.test.ts tests/helper-compaction.test.ts tests/helper-workspace.test.ts tests/context-compaction.test.ts`. The data tests use real read-only SQLite child processes; runtime tests exercise native Chat encoding/decoding against intercepted synthetic responses, not a paid provider. The manual-compaction regression counts full writer projections rather than enforcing a machine-dependent time threshold. Build before checking compiled child-process or browser execution. [Helper goal evaluation](HELPER-EVALUATION.md) defines the synthetic task oracles and real-model evidence boundary; `npm test -- tests/helper-data-runtime.test.ts --reporter=verbose --silent=false` emits per-case cumulative `HELPER_GOAL_METRICS`, including helper and compaction calls. These fixture metrics are not autonomous model scores.

Helper code-check changes use `npm test -- tests/helper-code-tools.test.ts tests/helper-plan-mode.test.ts tests/helper-discovery.test.ts tests/tool-contract-portability.test.ts tests/app-guides.test.ts`. Their Lua syntax and regex checks run the real Lua and evaluator workers on synthetic resources.
