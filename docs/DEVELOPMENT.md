# Development

Use [CODE-MAP](CODE-MAP.md) to find feature contracts and entry points. This page covers setup, check selection, execution, and troubleshooting.

## Environment and setup

Use Node 24.x, at least 24.14.0, as specified by [package.json](../package.json) and [.nvmrc](../.nvmrc). Windows PowerShell is the primary development environment; the browser helpers also discover Chrome and Edge on macOS and Linux.

```powershell
npm ci --no-audit --no-fund
npm run dev
```

For an offline install with a populated npm cache, add `--offline`. `dev` builds and starts the server; `npm start` uses the existing build. See [README](../README.md) for app configuration.

Run `npm run doctor` when diagnosing the environment. It checks Node, child processes, SQLite, loopback HTTP, and Chromium. `--no-browser` checks only the API environment. Set `UIMORI_BROWSER_PATH` to use a browser outside the discovered locations. The shared resolver falls back to an installed Playwright Chromium. `doctor`, the shared browser harness and `verify:selfhost` launch the resolved browser and check a synthetic loopback page and nonzero text geometry before app tests. Missing libraries, fonts or executables report `BLOCKED`; this basic layout check does not prove complete glyph coverage. Configure an environment-specific wrapper with `UIMORI_BROWSER_PATH`, not a hardcoded workspace path.

## Verification

Choose checks that can expose failures caused by the change. Completing a feature or making a commit does not, by itself, require a full suite.

| Change or question | Useful checks |
| --- | --- |
| Code behavior | Focused tests, such as `npm test -- tests/<file>.test.ts`; use `npm run quality` for lint and type checks when relevant |
| UI behavior | The relevant `verify:*` command against a matching build; `verify:browser-smoke` covers basic chat and global prompt settings |
| Verification tooling | Tests for the affected runner; `npm run test:tooling` covers the full tooling suite |
| Cross-cutting changes beyond focused coverage | Consider `npm run quality:full` and broader browser coverage for the interactions at risk |
| Documentation only | Check accuracy, links, commands, consistency, and `git diff --check` |
| Release candidate | `npm run release:check -- --area <verify:*>`; see below |

Use the smallest existing tests that exercise the affected behavior and plausible failures. Add tests for gaps that matter, rather than mirroring implementation. Once the relevant checks pass, finish. Rerun or expand only for a subsequent change, failure, or unresolved risk.

`quality` runs Biome and TypeScript without starting the app or a browser; `check` runs TypeScript alone. `test:tooling` creates a fresh build before running build, verification and release-tooling tests, so it also works from a clean checkout. `quality:full` runs `quality`, that build-backed tooling suite, then the complete Vitest suite. The build precedes Vitest because some tests restart the compiled server. Vitest uses a 30-second per-test emergency cap for hosted Windows runner variance; operation-specific polls and network deadlines remain explicit and shorter.

Helper data/gateway changes use `npm test -- tests/helper-data-tools.test.ts tests/helper-data-runtime.test.ts tests/helper-tool-contracts.test.ts tests/helper-library-read.test.ts tests/helper-compaction.test.ts tests/helper-workspace.test.ts tests/context-compaction.test.ts`. The data tests use real read-only SQLite child processes; runtime tests exercise native Chat encoding/decoding against intercepted synthetic responses, not a paid provider. The manual-compaction regression counts full writer projections rather than enforcing a machine-dependent time threshold. Build before checking compiled child-process or browser execution. [Helper goal evaluation](HELPER-EVALUATION.md) defines the synthetic task oracles and real-model evidence boundary; `npm test -- tests/helper-data-runtime.test.ts --reporter=verbose --silent=false` emits per-case cumulative `HELPER_GOAL_METRICS`, including helper and compaction calls. These fixture metrics are not autonomous model scores.

## Verification runners

Use a build matching the current app source for checks that execute `dist`. Focused tests that import source modules do not need a build.

| Command | Purpose |
| --- | --- |
| `npm run quality:full` | Formatting, lint, types, tooling tests, fresh build and complete Vitest suite. |
| `npm run test:tooling` | Fresh build plus build, verification and release-tooling tests, including failure detection. |
| `npm run verify:liquid-gallery` | Novel reader theme, opaque portraits, 10k-token outputs, light/dark responsive controls. |
| `npm run verify:themes` | Custom themes, palettes, portable files, reader state preservation and emergency recovery. |
| `npm run verify:input-translation` | Manual composer translation, temporary undo, stale results, final-only submission, request copying and existing edit/recovery regressions. |
| `npm run verify:translation-guides` | Bot guide forms, native JSON, draft recovery, validation and mobile layout. |
| `npm run verify:personal` | Ordinary resource saves, local recovery, image metadata, provider keys and portable chat restoration. |
| `npm run verify:browser-smoke` | Small browser suite for chat and global prompt settings. |
| `npm run verify:ui` | Reader layout, editing, reading preferences and shared-control motion; accepts `--grep` and `--visual`. Renderer unit tests run separately with `npm test -- tests/prose.test.ts`. |
| Feature-specific `verify:*` scripts | Suites such as `verify:packages`, `verify:providers`, `verify:library`, and `verify:navigation`; see [package scripts](../package.json). |
| `npm run verify:browser` | Full local synthetic browser regression. |
| `npm run verify:selfhost` | Independent HTTPS/authentication, cross-device SSE, and re-entry/session-revocation scenarios. Accepts `--grep` for diagnosis; a filtered run is not the full suite. |
| `npm run verify:visual` | Full browser suite with extra viewport and layout checks; use `--grep` to focus it. |
| `npm run verify:gallery` | Screen and journey captures; see [UI-GALLERY](UI-GALLERY.md). |
| `npm run benchmark:story` | Repeated long-story performance measurements. |

Feature runners using the [shared browser harness](../scripts/browser-verification.mjs) accept `--grep <pattern>` to narrow their existing selection and `--visual` to enable extra visual checks:

```powershell
npm run verify:providers -- --grep PMUI03
npm run verify:providers -- --grep PMUI03 --visual
```

A report records the selected files, filter and executed tests. A run with no tests, failed or skipped tests, or incomplete cleanup fails. Visual runs also list the screenshots they captured; filenames and test titles are not duplicated in a separate acceptance list.

`tests/server.test.ts` checks independent server processes, ports and SQLite databases from one build, including restart persistence. No extra Git checkouts are needed.

After a matching build, `node --expose-gc scripts/benchmark-native-preparation.mjs` compares sequential and batched native text preparation for 10, 50 and 100 messages, three times each. It checks identical outputs and records elapsed time, Worker calls, sampled process RSS and cancellation latency under `output/benchmarks/`. These synthetic measurements exclude callbacks and provider work.

### Shared-control motion

Read the [Uimori motion skill](../.agents/skills/uimori-motion/SKILL.md) when changing app-owned dialog/menu/switch motion. `web/style.css` owns the timing/easing tokens; the native state and focus owners remain unchanged. Modals fade in without transforming nested fixed-position menus; action menus grow from their actual opening edge and become short upward reveals on phones. Closing stays immediate. When the mobile scene navigator is visible, the default reader leaves bottom clearance for the last scene controls; theme spacing still takes precedence. New motion is opt-in to the OS's no-preference mode; manuscript/author styles are not rewritten.

After building, `npm run verify:ui -- --grep MOTION` exercises mobile/desktop controls with normal and reduced motion, rapid re-entry, persistent switch values and final geometry. It records screenshots and videos alongside browser reports. The skill lists existing nested-dialog, keyboard and long-reader checks to select when relevant.

## Builds and evidence

Reuse results while their source, environment, and test assumptions remain applicable. After a follow-up edit, run affected checks and distinguish them from an earlier full run. Documentation and test-only changes do not invalidate compiled app inputs.

Browser reports record the build identity checked before launch; tooling reports record selected files and actual Node test results. Local runners do not issue a second source/test certification or rehash the same inputs at the end. Finish edits and rebuild before final verification; after a later change, rerun the affected checks. Release receipts separately require unchanged full source identity. Runtime vendor inputs in `third_party` participate in the build identity.

Actual local Risu materials are excluded from ordinary browser discovery. Set `UIMORI_RISU_SAMPLE_ROOT` for `node scripts/verify-risu-native-samples.mjs`, optionally `UIMORI_RISU_SAMPLE_PRESET` for an external `.risup`, and use `--grep` to focus cases. Source materials remain read-only; private rendered artifacts stay in ignored output directories. These loopback fixture checks do not establish live-provider quality or universal script compatibility.

## Release checks

`npm run release:check -- --area <verify:*>` runs `quality`, a matching `build`, and the selected browser area. The default is `verify:browser-smoke`; `--full` selects `quality:full` and replaces that default with `verify:browser`. Explicit areas remain selected alongside the full suite. Deployment-tooling changes normally select `verify:selfhost`. Local receipt matching and reuse remain developer conveniences. Oracle deployment independently requires the exact SHA’s full GitHub CI result and runs image/DB/HTTPS checks on the host; see [ORACLE-RELEASE](ORACLE-RELEASE.md).

### Publishing a version

`package.json` is the app version source; `npm version <version> --no-git-tag-version` updates it and the lockfile without creating a tag. `server/app-version.ts` imports the package metadata, which TypeScript copies into the compiled output. Both `/api/health` and the Codex handshake use that value; the About screen reads it from the server and keeps the separate build fingerprint. Do not reset the DB schema to match an app release number.

Update README, release notes under `docs/releases/`, and any affected installation/data instructions. Check the final candidate with the release checker and focused version, startup/restart, schema/backup and About-screen tests. Synthetic model/CLI fixtures are not evidence of live-provider quality or a real Docker upgrade.

Commit and push the reviewed candidate, confirm checks for that exact commit, then create an annotated `v<version>` tag and publish the matching GitHub release notes. Never move an already published release tag; corrections get a new version. Do not include local configuration, credentials, DBs or test evidence in a source release. Release publication does not deploy Oracle or operate the generic updater.

## Static checks and CI

[Biome](../biome.json) owns formatting, lint rules and direct import boundaries. TypeScript uses strict checking. The dependency tests parse TypeScript/JavaScript syntax and recursively discover source files: side-effect imports and re-exports participate in eager runtime cycle checks, erased type imports do not. Literal dynamic imports participate in snapshot boundary checks but not eager cycles. Computed runtime import paths are not statically resolved. License and snapshot manifest checks remain separate.

[CI](../.github/workflows/quality.yml) starts independent static, four Windows Vitest shards, Windows tooling, Linux core/recovery and Linux self-host/browser-smoke jobs after change classification. Each Vitest runner builds once because some files restart the compiled server, then `node scripts/ci-vitest.mjs 1/4` (through `4/4`) collects and runs its native Vitest shard. File isolation and serial execution inside each runner stay enabled; local `npm test` is not made more aggressive on small machines. The final `quality` job checks every required outcome and verifies that shard reports cover exactly the collected file set without duplicates, missing reports or a different commit. Pending/optional tests remain visible in counts; failed/cancelled jobs are never treated as passes.

Changes limited to Markdown under `docs/`, root README/AGENTS or LICENSE keep the cheap docs-only path. A docs-only pass is not a full deployment verification; dispatch the workflow on that exact branch/SHA for all required checks. Manual `browser=true` runs three independent full-browser shards alongside the other jobs, not after them. Every shard has its own runner, server, DB, provider fixture and artifacts; Playwright stays at one worker. `npm run verify:browser -- --shard 1/3` uses the same file-level selection locally. The final aggregate checks the union of collected browser cases. No hand-maintained file lists or duration scheduler are required.

Node versions in CI follow `.nvmrc`. Standard JSON test reports, file counts and shard times are uploaded for seven days; failures retain synthetic browser traces. Existing Windows test coverage and the separate Linux runtime checks are preserved. Compare comparable CI runs before changing shard counts or claiming a speedup; more machines reduce wall time but can increase total runner minutes.

`npm run test:personal` exercises the personal-workspace contracts. `node --test scripts/transfer-personal-v1.test.mjs` verifies read-only schema-24 extraction after building. The removed transparent snapshot archive has no optimizer or DDL signature check.

Self-host checks print bounded named steps and retain failure traces for desktop and mobile contexts. They use disposable synthetic credentials, not production access. Each scenario creates its own required chat/model state and is selectable alone. Filling the composer occurs before session revocation; the subsequent conditional DOM click cannot wait for a composer already removed by the login gate.

## Results and troubleshooting

Browser reports, screenshots, traces, and `summary.json` are under `output/playwright/<run-id>/`. The common runner uses fresh DBs and ports, records source/build identity, and cleans up its processes. Its exit code and summary distinguish failed checks, missing prerequisites, and cleanup failures.

- **Child-process or browser failure:** `spawn EPERM` or a missing browser is an environment blocker. Diagnose with `doctor` and rerun in an environment that can execute the required process.
- **Stale build:** Rebuild when app inputs changed. The runners check build identity separately from test inputs.
- **Unexpected shared settings in a failed run:** Inspect the preserved SQLite at `output/playwright/<run-id>/evidence-db/app.sqlite` before replaying a long browser suite.
- **Loopback hangs behind a proxy:** Browser launch options include `--no-proxy-server` for local traffic.

Local fixtures, browser emulation, live providers, and physical devices establish different evidence. Report which one actually ran.

## Reset and cleanup

`npm run cleanup -- --run <run-id>` removes one explicitly selected inactive browser run, including diagnostic artifacts. It never stops unrelated processes. Successful browser runs remove temporary databases; failed runs retain a copy under `evidence-db`.

Browser/self-host and tooling runners perform bounded local artifact retention after their own run finishes. For each owned output family, the newest three successes and five failures are retained, in addition to the current run, any active/alive-owner process, uncertain cleanup, unowned output and artifacts referenced by the current source's successful local release checks. `npm run cleanup -- --retention` previews candidates; add `--apply` for explicit cleanup. It never sends termination signals or removes arbitrary user data. Cleanup warnings are recorded independently and cannot turn a successful verification into a failed app test. CI uploads retain seven days of reports; browser fixtures use synthetic credentials, never production tokens.

`npm run reset:dev` deletes only this checkout's default `.local/uimori.sqlite` and its SQLite sidecars. Existing backups and older database files remain untouched. Stop the server first. The command rejects an in-use database or unsafe paths and does not reset an arbitrary `UIMORI_DB`.

Empty and personal-v1 databases are admitted. Personal schemas 1 through 5 upgrade once to schema 6; unrelated legacy formats are rejected before schema writes. Use disposable databases for development. Current data formats and this boundary are documented in [DATA-MIGRATIONS](DATA-MIGRATIONS.md).

Manual storage measurements use `scripts/synthetic-story.mjs` and current transcript-v2 import, not obsolete package shapes or cumulative completed snapshots. After building, run `node --expose-gc scripts/measure-context-storage.mjs` or `node scripts/measure-transcript-import.mjs --counts=10,100`. These are synthetic measurements, not CI timing gates.

For a long-novel workload, use `node --expose-gc scripts/measure-context-storage.mjs --long-story --label baseline`. It imports 10/30/100 Korean scenes around 7,500 `o200k_base` tokens each and 50 synthetic lore entries, recording exact UTF-16 length, UTF-8 bytes, tokens and hashes. Reuse the emitted directory with `--fixture <directory> --label improved` for identical stored inputs and full-output hash comparisons. History, checkpoint lookup, logical-message capture and native display-context construction are timed separately (three warmups, nine samples). These stages exclude native workers, transport and providers; the legacy 8,000-character mode remains available without `--long-story`.

The existing Liquid Gallery runner also has opt-in long-reader timings:

```powershell
$env:UIMORI_BENCHMARK='1'
npm run verify:liquid-gallery -- --grep PERF
Remove-Item Env:UIMORI_BENCHMARK
```

This selects synthetic 8- and 30-scene workloads with roughly 7,500-token Korean originals and English translations, authored HTML/CSS, a local image and Lua button code. It records one warmup and five repetitions of re-entry, past-page navigation and saved original/translation switches in a desktop browser. Each Playwright JSON report includes the `long-reader-performance` attachment with exact text metrics, click-to-ready times, HTTP resource timings and main-thread long tasks. It verifies unchanged saved data and no new generation requests. The ready boundary is all target text plus visible images and two animation frames, not compositor paint; resource time includes local queue/transport and is not isolated server CPU. Timing values are observations, not pass thresholds. Reading preferences, themes and mobile layouts retain their separate functional browser checks.

`tests/fixtures/personal-schema-1.sql` is synthetic output from the previous product build (`9a14ac4`, same application source as `bf7de22`), including real native resources, translation, fixed values and oneoff/delegation rows. The migration test loads that prior schema rather than relabeling a newly created database.

`tests/fixtures/personal-schema-3.sql` is synthetic output from the real `7cac3f7` runtime. Its intentionally added legacy branch exercises conversion into independent chats. `tests/database-schema.test.ts` checks prior-schema migration and restart idempotence; `tests/text-retention.test.ts` and `tests/execution-retention.test.ts` check retained messages and execution payloads without a live provider. The ordinary branch ID remains an internal execution scope, not a public shared-branch management API.

### Interrupted browser runs

Browser checks use Playwright's live list reporter and a JSON report. If a run is interrupted before the JSON report completes, its test count is unknown rather than zero; consult the live log and individual failure traces. Do not label a partially executed suite as passing or make it pass by restoring a retired product contract.

### Synthetic generation

`core/fixture-provider.ts` exposes explicit fixture behavior separately from product chat settings. Unit tests pass options to `executeFixtureMain` or `MainHooks.fixture`; HTTP scenarios use `app.controls.fixture` or `/api/test/control` with `action: "fixture"`. The controls are exposed only in test mode, captured before execution waits, and never saved in chat settings or provider inputs. Normal generation still requires a configured model. Test settings conflicts with current `maxCalls`/`status`, not mock style fields.

Storage regressions are grouped by their owner: reader projections, chat option receipts, execution retention, text retention, and database migrations. The storage measurement tools use `scripts/synthetic-story.mjs`; the pre-native loading runner has been removed.
