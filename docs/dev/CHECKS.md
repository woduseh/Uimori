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

`check:changed` prints what it left out, and its notices are instructions: a local run executes at most 30 affected Vitest files and says how many it skipped, global configuration prints `scope: full-required`, and a `server/index.ts` or `server/app.ts` change names the tests that need a build first. `--list-json` prints the selection without running it, and PR CI runs the same selection through `scripts/ci-vitest.mjs`.

No notice reports these gaps in the selection:

- It finds Vitest files through the import graph of changed modules and, for other files, by a test naming the file or its extension. A test that reaches its sources another way is missed: `tests/background-work.test.ts` runs `dist` and `tests/helper-runner.test.ts` spawns `runner/runner.mjs`, and neither imports what it exercises. CI always runs the first in `linux-browser-core`; only a full run, such as the shards on `main`, checks the second against a source change.
- `check:i18n` runs only for changes under `web/` or to the checker, but it also reads `core/`, `packages/`, `server/`, `scripts/` and `tests/` for unused keys, so removing the last use of a key there is caught by `quality`, not by `check:changed`.
- It does not build. Tests that start the compiled server fail with "Run npm run build" until the build matches the source.

`quality:full` builds before Vitest because some tests restart the compiled server. Vitest's 30-second per-test cap is an emergency limit for hosted runner variance; operation-specific polls and network deadlines remain explicit and shorter.

## Evidence boundaries

- The Unix socket, Bash, Python and process-cancellation cases of the main and helper shells run only on Linux (`linuxTest` and `posixTest` in those test files). A Windows run skips them, so a shell or runner change has its evidence from the Linux CI shards.
- Helper data tests use real read-only SQLite child processes, and runtime tests exercise native Chat encoding and decoding against intercepted synthetic responses, not a paid provider. The Lua syntax and regex checks run the real Lua and evaluator workers on synthetic resources. Build before checking compiled child-process or browser execution.
- The manual-compaction regression counts full writer projections rather than enforcing a machine-dependent time threshold.
- [Helper goal evaluation](HELPER-EVALUATION.md) defines the synthetic task oracles and the real-model evidence boundary. `npm test -- tests/helper-data-runtime.test.ts --reporter=verbose --silent=false` emits per-case cumulative `HELPER_GOAL_METRICS`, including helper and compaction calls.
