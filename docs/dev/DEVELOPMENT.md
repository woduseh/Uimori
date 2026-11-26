# Development

Use [CODE-MAP](CODE-MAP.md) to find feature contracts and entry points. This page covers setup, verification runners, execution, and troubleshooting; [CHECKS](CHECKS.md) covers which checks a change needs.

## Environment and setup

Use Node 26.x, at least 26.13.0, as specified by [package.json](../../package.json) and [.nvmrc](../../.nvmrc). Windows PowerShell is the primary development environment; the browser helpers also discover Chrome and Edge on macOS and Linux.

Doctor and the browser verification runners share the Node support check in `scripts/node-runtime.mjs`, which reads `package.json`'s `engines.node` interval. The declared range owns the minimum patch and upper major bound; `.nvmrc` pins the version used by CI.

```powershell
npm ci --no-audit --no-fund
npm run dev
```

Run `git config core.hooksPath .githooks` once per clone; worktrees share it. The pre-commit hook checks staged files with Biome, because CI is otherwise the first place a file formatted by another tool is refused.

For an offline install with a populated npm cache, add `--offline`. `dev` builds and starts the server; `npm start` uses the existing build. See [README](../../README.md) for app configuration.

Run `npm run doctor` when diagnosing the environment. It checks Node, child processes, SQLite, loopback HTTP, and Chromium. `--no-browser` checks only the API environment. Set `UIMORI_BROWSER_PATH` to use a browser outside the discovered locations. The shared resolver falls back to an installed Playwright Chromium. `doctor`, the shared browser harness and `verify:selfhost` launch the resolved browser and check a synthetic loopback page and nonzero text geometry before app tests. Missing libraries, fonts or executables report `BLOCKED`; this basic layout check does not prove complete glyph coverage. Configure an environment-specific wrapper with `UIMORI_BROWSER_PATH`, not a hardcoded workspace path.

## Verification

Choose checks with [CHECKS](CHECKS.md).

## Verification runners

Use a build matching the current app source for checks that execute `dist`. Focused tests that import source modules do not need a build.

| Command | Purpose |
| --- | --- |
| `npm run quality:full` | Formatting, lint, types, tooling tests, fresh build and complete Vitest suite. |
| `npm run test:tooling` | Fresh build plus build, verification and release-tooling tests, including failure detection. |
| `npm run verify:narrative-themes` | Four narrative layouts, independent palettes, scene portraits and responsive reading controls. |
| `npm run verify:liquid-gallery` | A copied legacy user theme with portraits and 10k-token outputs, through a theme toggle that keeps the composer draft. |
| `npm run verify:themes` | Custom themes, palettes, portable files, reader state preservation and emergency recovery. |
| `npm run verify:input-translation` | Manual composer translation, temporary undo, stale results, final-only submission, request copying and existing edit/recovery regressions. |
| `npm run verify:translation-guides` | Bot guide forms, native JSON, draft recovery, validation and mobile layout. |
| `npm run verify:personal` | Ordinary resource saves, local recovery, image metadata, provider keys and portable chat restoration. |
| `npm run verify:browser-smoke` | Small browser suite for chat and global prompt settings. |
| `npm run verify:ui` | Reader layout, editing, Markdown rendering, reading preferences and shared-control motion; accepts `--grep` and `--visual`. Renderer unit tests run separately with `npm test -- tests/prose.test.ts`. |
| `npm run verify:story-ui` | Story UI settings, original/translated source rendering, retained streaming surfaces, action admission, and native Risu coexistence. |
| Feature-specific `verify:*` scripts | Suites such as `verify:packages`, `verify:providers`, `verify:library`, and `verify:navigation`; see [package scripts](../../package.json). |
| `npm run verify:risu-compat` | Native Risu form submission, action receipt recovery, authored controls and existing reader behavior at mobile and desktop widths. |
| `npm run verify:browser` | Full local synthetic browser regression. |
| `npm run verify:selfhost` | Independent HTTPS/authentication, cross-device SSE, and re-entry/session-revocation scenarios. Accepts `--grep` for diagnosis; a filtered run is not the full suite. |
| `npm run verify:visual` | Full browser suite with extra viewport and layout checks; use `--grep` to focus it. |
| `npm run verify:gallery` | Screen and journey captures against a matching build; accepts no arguments. See [UI-GALLERY](UI-GALLERY.md). |
| `npm run verify:copy` | Warning-only scan and JSON review inventory of literal i18n and JSX explanations; see [UI-GALLERY](UI-GALLERY.md#copy-review-warnings). No browser, provider calls, or build required. |
| `npm run check:i18n` | ICU syntax, locale keys/arguments, missing translations and unused keys ([rule](APP-INVARIANTS.md#ui-language-i18n)); part of `quality`. `-- --candidates` also lists static Korean and dynamic-call review candidates. See [UI language](../I18N.md). |
| `npm run verify:i18n` | Four UI languages, re-entry, reader recovery, retained editor state and model inputs, mobile/pseudo text, accessible names, manifest and restarted-worker synthetic push. Requires a matching build. |
| `npm run benchmark:story` | Repeated long-story timing at large fixture sizes (`tests/story-performance.manual.ts`, outside the default `npm test` collection); writes `story-performance.json` under `output/benchmarks/`. The same functional contracts run at minimal size in `tests/story-scale-invariants.test.ts`. |
| `npm run eval:helper` | Lists the small helper behavior cases. After building, `-- --synthetic` checks the runner; explicit live configuration is described in [Helper evaluation](HELPER-EVALUATION.md). |

Feature runners using the [shared browser harness](../../scripts/browser-verification.mjs) accept `--grep <pattern>` to narrow their existing selection and `--visual` to enable extra visual checks:

```powershell
npm run verify:providers -- --grep PMUI02
npm run verify:providers -- --grep PMUI02 --visual
```

A report records the selected files, filter and executed tests. A run with no tests, failed or skipped tests, or incomplete cleanup fails. Visual runs also list the screenshots they captured; filenames and test titles are not duplicated in a separate acceptance list.

These runners execute spec files in parallel. The harness starts one server with its own SQLite DB and port for each Playwright worker, and `playwright.config.ts` connects each worker to its server through `TEST_PARALLEL_INDEX`. A file is the unit of parallelism: its tests run in order on one worker. Files on the same worker share its server one after another, and the worker count changes which files share a server, so a file must not depend on what earlier files leave behind; for example, name the bot to start a chat from instead of taking the first one in the library. The default worker count is half the logical CPUs, limited to one worker per 2 GiB of total memory and to the number of selected files; 16 logical CPUs and 32 GiB give 8 workers, and a 4-vCPU CI runner gives 2. Override it with `--workers <n>` or `UIMORI_BROWSER_WORKERS`; `--workers 1` reproduces the earlier single-server run when you suspect interference between files:

```powershell
npm run verify:browser -- --workers 4
npm run verify:browser -- --grep READERREC --workers 1
```

One runner of the shared harness executes at a time on a machine, across checkouts and worktrees: `waitForBrowserTurn` holds a loopback port, and a second run waits for it instead of starting. Two runs sharing the CPUs fail with "App ready timeout" or in unrelated specs that pass alone. The operating system frees the port when the holder exits, so an interrupted run leaves nothing to clean up.

`summary.json` records the worker count and each server's URL and DB under `servers`; each server's log is under `servers/<n>/server.log`. A direct `npx playwright test` without the harness still uses one worker and `UIMORI_BASE_URL`/`UIMORI_DB`.

`tests/server.test.ts` checks independent server processes, ports and SQLite databases from one build, including restart persistence, and fails with "Run npm run build" when the build does not match the source. `tests/background-work.test.ts` also executes `dist`, through `tests/fixtures/background-failure.mjs`, and runs the same build check first. No extra Git checkouts are needed.

After a matching build, `node --expose-gc scripts/benchmark-native-preparation.mjs` compares sequential and batched native text preparation for 10, 50 and 100 messages, three times each. It checks identical outputs and records elapsed time, Worker calls, sampled process RSS and cancellation latency under `output/benchmarks/`. These synthetic measurements exclude callbacks and provider work.

For before/after native generation preparation, run `node --expose-gc scripts/benchmark-native-run.mjs output/benchmarks/native-run-local baseline`, rebuild after the change, then rerun with the same directory and label `after`. The directory must be new or carry the runner's fixture marker. It reuses exact synthetic SQLite rows and input JSON for 10/100 Korean scenes (about 7,500 tokens each) with 50/500 lore entries. The measured boundary is native preparation through the real main-request builder and serialized Responses body, including the input/editInput/start callback path; it excludes reservation, context planning, providers and browser latency. Two warmups and nine raw samples retain median/min/max, first invocation, CPU, sampled RSS, Worker count, input/output/wire and logical DB hashes, source/build identity and the uncommitted diff. No timing CI gate or OS cache reset is implied. Run without concurrent heavy work.

After a matching build, `node --expose-gc scripts/benchmark-presentation.mjs output/benchmarks/presentation-local baseline` measures the reader response plus the last five concurrent native presentation responses for 30 and 300 completed synthetic scenes (8,000 characters each). Rebuild after a change, then rerun with the same directory and label `after` to reuse the exact isolated SQLite fixtures. The directory must be new or carry this runner's fixture marker. Reports retain source/build hashes, Git status/diff, fixture hashes, the first process-local flow, two warmups and nine raw samples with median/min/max, process CPU, sampled RSS, prepared-statement counts and response hashes/bytes. Compare response and fixture hashes as well as timing. No OS cache reset, browser paint, remote network or paid provider is included; RSS sampling can miss synchronous peaks. Run measurements without concurrent builds, tests or other heavy agent work.

### Request timing, bundle sizes and the operating ledger

API responses carry a `Server-Timing` header with `auth`, `db` (SQLite time and `q=<statements>`) and `total` durations; hijacked streams and static files carry none. `GET /api/diagnostics/metrics` summarizes the last 4,096 API responses per route pattern since the process started, behind the usual API authentication. `responseBytes` counts the uncompressed body; a `304` counts as zero, and `notModified` counts those responses. `server/request-metrics.ts` owns both. The SQL counter in `server/sql-metrics.ts` covers only the server's main `Store` connection; worker threads and child processes that open their own connection are not counted, and synchronous SQL that background work started by a request runs before the response is sent counts toward that request.

`npm run build` writes `dist/bundle-sizes.json` with raw, gzip and brotli bytes for every served web file. Hashes in asset names are replaced by `[hash]` so two builds can be diffed; compressed sizes are those of the precompressed `.gz`/`.br` files where they exist.

`scripts/perf-ledger.mjs` prints one JSON document of aggregates from a database opened read-only: table and page sizes, run timelines and phase spans, refusals, retries, tokens and cache reuse, streaming diagnostics, tools, helper, translation and storage. It selects only identifiers, enumerations, numbers and byte lengths, and replaces any other string in its output with `(redacted)`. `--since <date>` sets the window start (default 30 days ago). It imports only `node:` modules, so it can be piped into a running container without copying files:

```powershell
node scripts/perf-ledger.mjs .local/uimori.sqlite --since 2026-10-24
Get-Content scripts/perf-ledger.mjs | ssh <host> "docker exec -i <container> node --input-type=module - --since 2026-10-24"
```

The second form reads the container's `UIMORI_DB`. `node --test scripts/perf-ledger.test.mjs` checks the output against a synthetic database after a build.

`scripts/eval-early-refusal.mjs` measures whether the main-refusal judgment would recognize a refusal from the start of a response. It reads refused candidates (`MAIN_RESPONSE_REFUSED` runs' stored `mainJudgment`) and completed runs' sources from a database opened read-only, replays `judgeMainRefusal` from the compiled build with the server's judgment selection and saved credential on each prefix and on the full text, and prints aggregates only: detection and false-positive rates per prefix and threshold, score percentiles and the share of generation an early stop would skip. Attempts are not recorded. The judgment calls cost provider usage, so start with `--dry-run`, which prints the sample sizes and planned call count; a real run stops before the first call when the plan exceeds `--max-calls` (default 500). It imports the build from `--dist` (default `./dist`), so inside the container it is piped like the ledger:

```powershell
node scripts/eval-early-refusal.mjs .local/uimori.sqlite --dry-run
Get-Content scripts/eval-early-refusal.mjs | ssh <host> "docker exec -i <container> node --input-type=module - --dist /app/dist --dry-run"
```

`node --test scripts/eval-early-refusal.test.mjs` replays it against a synthetic database with a stub judgment endpoint after a build.

### Translation reference preparation

After a matching build, run `node --expose-gc scripts/benchmark-translation-references.mjs output/benchmarks/translation-references-local baseline`. Rebuild after the change and rerun with the same directory and label `after`. The directory must be new or carry the runner's fixture marker. It reuses isolated SQLite fixtures with 30/300 completed translations, 16,000-character originals and 8,000-character translations. Job inputs are empty, so this conservative case does not claim savings from large retained settings. The optional final argument selects reference capture without a tool read (`none`), a single captured translation (`one`), or every captured translation (`all`, the default). Use a distinct report label per mode. The timed boundary includes identity capture and the requested access. It excludes current job/snapshot preparation, provider/model work and browser/network latency. Reports retain source/build identity, runner copies, input/output/database hashes, the first call, two warmups and nine raw samples, elapsed time, CPU, entry/return memory, SQL statement counts and returned text bytes. Each sample checks exact reference output, and the run checks unchanged DB rows. Memory samples are not peaks, and OS caches are not reset. Run without concurrent builds or tests.

### Shared-control motion

Read the [Uimori motion skill](../../.agents/skills/uimori-motion/SKILL.md) when changing app-owned dialog/menu/switch motion. `web/style.css` owns the motion tokens and [UI principles](UI-PRINCIPLES.md#tokens) names their roles; the native state and focus owners remain unchanged. Content modals use a centered, rounded shell on desktop and mobile, with 24px desktop / 16px mobile viewport clearance and internal scrolling below a non-scrolling header. Each modal resets its preferred width and maximum height before feature overrides, so a nested confirmation cannot inherit a wide settings shell. Above the narrow layout the app and chat settings dialogs take `--settings-dialog-w` by `--settings-dialog-h`; narrow screens keep the shared shell. Feature styles only choose their preferred width or a deliberate inner layout; app navigation and assistant panels keep their separate panel behavior, and the narrow-layout navigation modal docks left over the backdrop instead of centering. Dialogs, action menus, the composer menu, the input-language menu, mobile sheets, scene previews and transient notices fade and rise into place over `--motion-overlay`, icon-button tooltips only fade, and all of them close immediately; shared buttons, action-menu triggers and navigation rows ease their hover and pressed colours over `--motion-fast`. The outline that marks where an opened helper change landed fades over `--motion-mark` and stays static under reduced motion. All of it is CSS (`@starting-style` and named transition properties) behind `prefers-reduced-motion: no-preference`, and a dialog ends at `transform: none`. The mobile latest-position action stays outside the reader in normal flow, so manuscript spacing does not need an overlay clearance; theme spacing still takes precedence. New motion is opt-in to the OS's no-preference mode; manuscript/author styles are not rewritten.

Browser specs run with reduced motion by default (`playwright.config.ts`), so geometry and colour assertions see settled surfaces; a spec that needs entrance motion or an activity animation emulates `no-preference` itself. No browser case pins transition durations, easing or entrance geometry: those are taste-level values that changed with every motion pass, so review motion in the running app as the skill describes.

## Builds and evidence

Reuse results while their source, environment, and test assumptions remain applicable. After a follow-up edit, run affected checks and distinguish them from an earlier full run. Test-only changes do not invalidate compiled app inputs. The user-guide Markdown files directly under `docs/` do: the build copies them into `dist/docs` for the helper's `guide.read`, so they are part of the build identity and editing one calls for a rebuild before a check that executes `dist`. `docs/dev`, `docs/plans` and `docs/releases` are not copied.

Browser reports record the build identity checked before launch; tooling reports record selected files and actual Node test results. Local runners do not issue a second source/test certification or rehash the same inputs at the end. Finish edits and rebuild before final verification; after a later change, rerun the affected checks. Release receipts separately require unchanged full source identity. Runtime vendor inputs in `third_party` participate in the build identity.

The Docker build context contains the compiler inputs, runtime vendor files, licenses, the Markdown files directly under `docs/` and the four scripts used by the build runner. The build fails when no guide is present, so a context that drops them cannot produce an image without `guide.read` content. Tests, fixtures and unrelated verification scripts are excluded, so edits to them do not invalidate the Docker compile layer. Check image startup and cache behavior on a Docker host when changing this boundary; a local Node build alone does not verify Docker packaging.

Actual local Risu materials are excluded from ordinary browser discovery. Set `UIMORI_RISU_SAMPLE_ROOT` for `node scripts/verify-risu-native-samples.mjs`, optionally `UIMORI_RISU_SAMPLE_PRESET` for an external `.risup`, and use `--grep` to focus cases; `--visual` writes private rendered screenshots under the git-ignored output folder without storing HTTP-body traces. For Vitest local compatibility checks without logging prose, pass a JSON array of CHARX paths in `UIMORI_RISU_LOCAL_CARDS` (with optional `UIMORI_RISU_SAMPLE_PRESET`) and run `tests/risu-native-local-compatibility.test.ts`. Source materials remain read-only; these loopback fixture checks do not establish live-provider quality or universal script compatibility.

Other opt-in local verification variables:

- `UIMORI_CODEX_PREFLIGHT=1` with `npx vitest run tests/codex-installed.test.ts`: checks the installed Codex CLI version, empty auth state, and `generate-json-schema --experimental` (`dynamicTools` function shape, `item/tool/call`, text tool responses) in a fresh empty auth directory with no login or model calls, writing `output/codex-preflight/summary.json`.
- `UIMORI_NARRATIVE_DEMO_DIR` with `npm run verify:narrative-themes`: points to a local directory holding `bot.webp` (2:3) and `persona.webp` (1:1) for personal visual inspection against an isolated synthetic server (output stays in git-ignored `output/`; omit it to use deterministic synthetic images).

### Risu Lua upstream changes

Run `npm run check:risu-lua -- --risu ../Risuai` to compare a local Risu Git checkout with the upstream commit recorded in the vendored snapshot. That default is a source comparison baseline, not a declaration of Uimori's Lua compatibility version. The checkout must contain both revisions, including the baseline commit; shallow history may be insufficient. Use `--base <ref> --ref <ref>` to compare two other revisions. The tool resolves both refs to commit IDs and reads committed files; uncommitted checkout changes are excluded. It does not fetch updates, execute upstream code, or modify either app.

The report identifies host API additions, removals and declaration changes, Lua wrapper changes, and callback changes. It also compares names with Uimori's current Lua bridge: `exposed` means a name is present, `explicitly-unsupported` means the bridge rejects it, and `unclassified` needs inspection. Callback dispatch is reported separately as `statically-observed` or `unclassified`; dynamic dispatch is not enumerated. These are source observations, not proof of matching arguments, permissions, asynchronous behavior or persistence. Internal `*Main` functions and public wrappers remain separate names. Review changes to the connected UI, storage and provider code before adopting a new upstream feature.

```powershell
npm run check:risu-lua -- --risu ../Risuai
node scripts/risu-lua-diff.mjs --risu ../Risuai --base <reviewed-commit> --ref HEAD --json --check
```

Use the direct Node command for machine-readable JSON without npm's command banner. Normal reporting exits successfully even when sources differ; `--check` exits 1 for detected drift, 0 for unchanged sources, and 2 for invalid input or an unreadable comparison. Parsing failures are errors, not evidence of unchanged APIs. No scheduled upstream monitor is installed by this command, and it never applies updates automatically. To review a later update, compare with the last reviewed upstream commit rather than advancing a baseline merely to clear a warning.

`node --test scripts/risu-lua-diff.test.mjs` checks the detector with disposable Git fixtures. The standard tooling suite discovers these tests automatically. This verifies change detection and reporting, not actual card execution or complete Risu compatibility.

## Release checks

`npm run release:check -- --area <verify:*>` runs `quality`, a matching `build`, and one selected local feature check. The default is `verify:browser-smoke`; `--full` selects `quality:full` and replaces that default with `verify:browser`. An explicit feature area remains selected alongside the full suite. `--area` rejects the full browser, gallery and visual runners; use `--full` for the complete regression. Deployment-tooling changes normally select `verify:selfhost`. Local receipt matching and reuse remain developer conveniences. Oracle deployment independently requires the exact SHA’s full GitHub CI result and runs image/DB/HTTPS checks on the host; see [ORACLE-RELEASE](ORACLE-RELEASE.md).

After a matching build, `node scripts/test-tooling.mjs --files scripts/oracle-host-control.test.mjs scripts/oracle-smoke.test.mjs scripts/oracle-runner.test.mjs` checks temporary session cleanup, preserved maintenance outcomes and release diagnostics with disposable app/database and runner fixtures. These checks do not operate Oracle or establish production HTTPS behavior.

### Publishing a version

`package.json` is the app version source; `npm version <version> --no-git-tag-version` updates it and the lockfile without creating a tag. `server/app-version.ts` imports the package metadata, which TypeScript copies into the compiled output. Both `/api/health` and the Codex handshake use that value; the About screen reads it from the server and keeps the separate build fingerprint. Do not reset the DB schema to match an app release number.

Update both READMEs (English `README.md` and Korean `README.ko.md`), release notes under `docs/releases/`, and any affected installation/data instructions. Check the final candidate with the release checker and focused version, startup/restart, schema/backup and About-screen tests. Synthetic model/CLI fixtures are not evidence of live-provider quality or a real Docker upgrade.

Commit and push the reviewed candidate, confirm checks for that exact commit, then create an annotated `v<version>` tag and publish the matching GitHub release notes. Never move an already published release tag; corrections get a new version. Do not include local configuration, credentials, DBs or test evidence in a source release. Release publication does not update an installed app; use the [manual update instructions](../UPDATES.md) or the dedicated Oracle deployment runner.

## Static checks and CI

[Biome](../../biome.json) owns formatting, lint rules and direct import boundaries. TypeScript uses strict checking. The dependency tests parse TypeScript/JavaScript syntax and recursively discover source files: side-effect imports and re-exports participate in eager runtime cycle checks, erased type imports do not. Literal dynamic imports participate in snapshot boundary checks but not eager cycles. Computed runtime import paths are not statically resolved. License and snapshot manifest checks remain separate.

Server and browser modules cannot import the provider HTTP or Vertex execution internals directly. Server model calls use `executeProvider` in `core/transport.ts`; protocol encoders remain available for request measurement and Batch handling. `Store.transaction` and `HelperWorkspace.operation` accept synchronous callbacks only: their types reject Promise-like results because commit and operation receipts do not wait for asynchronous work. Perform asynchronous preparation before entering these operations.

[CI](../../.github/workflows/quality.yml) starts independent static, four Linux Vitest shards, Windows tooling, Linux reader-recovery and Linux self-host/browser-smoke jobs after change classification. Each Vitest runner builds once because some files restart the compiled server, then `node scripts/ci-vitest.mjs 1/4` (through `4/4`) collects and runs its native Vitest shard. A deterministic duration-weighted sequencer uses historical Linux CI timings (`scripts/ci-vitest-timings.json`) to balance the shards; new tests fall back to a default weight. It never skips a file. File isolation remains enabled. Linux shards run three file workers on the 4-vCPU hosted runner. Local `npm test` runs files in parallel with the browser runners' default worker count (half the logical CPUs, at most one per 2 GiB), so small machines still run serially; override it with `npm test -- --maxWorkers=<n>`. The deployment target is Linux, so the complete suite runs there. The Windows tooling job then runs `npm run test:windows`: server processes, backups, maintenance, schema, personal workspace, helper CLI/shell, Codex process discovery, request files, transfer archives and import envelopes, the areas where file locking, paths and child processes differ on the Windows quick-start platform. Add a file to that script when a change depends on Windows file or process behavior. The final `quality` job checks every required outcome and verifies that shard reports cover exactly the collected file set without duplicates, missing reports or a different commit. Pending/optional tests remain visible in counts; failed/cancelled jobs are never treated as passes.

The classifier reads names from both sides of a rename. A source file moved into documentation still runs full CI. Changes limited to Markdown under `docs/dev/`, `docs/plans/` or `docs/releases/`, root README/README.ko/AGENTS or LICENSE keep the cheap docs-only path; the root `docs/*.md` user guides are build inputs packaged into `dist/docs` for `guide.read`, so a change to one runs full CI. The docs-only path runs `node scripts/check-documentation.mjs` and `git diff --check` without installing dependencies. The documentation checker follows local file links and their heading anchors through both READMEs, AGENTS and every Markdown document under `docs/`, `.claude/` and `.githooks/`. It also requires each inline-code path under a source directory, such as `server/app.ts`, `core/*-protocol.ts` or the test file in `npm test -- tests/prose.test.ts`, to match an existing file or directory; a `<placeholder>` segment counts as a wildcard, and release notes are exempt because they describe earlier trees. Inside `sh`, `bash`, `powershell` and other shell fences, only lines that start with `node`, `npm` or `npx` count as commands: their source paths follow the same rule, and `npm run <name>` must name a `package.json` script; other lines are treated as sample output and skipped. The machine-local `.claude/settings.local.json` and `.claude/worktrees/` are neither read nor required to exist. Case IDs named under `docs/dev/`, including ranges such as CODEFIELD01-04, must appear in a file under `tests/`; `termsShapedLikeCaseIds` lists the words that only look like one. A docs-only pass is not a full deployment verification; dispatch the workflow on that exact branch/SHA for all required checks. A push or pull request whose range changes the `package.json` version is a release candidate, and it runs three independent full-browser shards alongside the other jobs, not after them; a manual `browser=true` run does the same for any other commit. Ordinary pushes skip them, so the local `npm run verify:browser` and the release candidate's CI run are the two complete browser checks. A push to `main` is never cancelled by a later push, so each pushed head keeps its own CI record; only a pull request's superseded run is cancelled. Every shard has its own runner, provider fixture and artifacts, and runs its files on the default worker count for that runner. `npm run verify:browser -- --shard 1/3` uses the same file-level selection locally. The final aggregate checks the union of collected browser cases. Browser test cases are discovered automatically without hand-maintained file lists.

Browser jobs install the managed Chromium executable. The runners pass that executable explicitly, so CI omits the separate headless-shell download.
Node versions in CI follow `.nvmrc`. Standard JSON test reports, file counts and shard times are uploaded for seven days; failures retain synthetic browser traces. Compare comparable CI runs before claiming a speedup. More machines reduce wall time but can increase total runner minutes. The timing snapshot is advisory, not a correctness dependency. Refresh it only from successful Linux CI Vitest artifacts when test costs change materially, never from a local or Windows run, where Unix-only files skip and record near-zero times. `scripts/update-ci-vitest-timings.mjs` refuses any shard whose inventory is not Linux or whose report carries Windows paths, prints the merged ledger, and writes the committed file only with `--write` and the run ID. Files a shard did not measure keep their earlier time; files no longer collected are dropped.

```sh
gh run download <run-id> --pattern "ci-vitest-*" --dir output/ci-timings/<run-id>
node scripts/update-ci-vitest-timings.mjs output/ci-timings/<run-id> --run <run-id> --write
```

`npm run test:personal` exercises the personal-workspace contracts, including current backup and import behavior.

Self-host checks print bounded named steps and retain failure traces for desktop and mobile contexts. They use disposable synthetic credentials, not production access. Each scenario creates its own required chat/model state and is selectable alone. Filling the composer occurs before session revocation; the subsequent conditional DOM click cannot wait for a composer already removed by the login gate.

## Results and troubleshooting

Browser reports, screenshots, traces, and `summary.json` are under `output/playwright/<run-id>/`. The common runner uses a fresh DB and port for each worker, records source/build identity, and cleans up its processes. Its exit code and summary distinguish failed checks, missing prerequisites, and cleanup failures.

- **Child-process or browser failure:** `spawn EPERM` or a missing browser is an environment blocker. Diagnose with `doctor` and rerun in an environment that can execute the required process.
- **Vertex fixture failure or timeout:** `waitForCompletedRun` in `tests/fixtures/run-completion.ts` stops at any terminal run state. Its error includes the last observed run status/error, at most five related job and attempt states, and the latest three fixture-handler errors. Diagnostic messages are bounded and redact the fixture bearer before truncation; request/response bodies, snapshots and assertion diffs are not dumped. The existing 10-second operation deadline and completion requirement are unchanged. `npm test -- tests/vertex-app.test.ts` exercises it against loopback handlers without a live provider.
- **Stale build:** Rebuild when app inputs changed. The runners check build identity separately from test inputs.
- **Unexpected shared settings in a failed run:** Inspect the preserved SQLite at `output/playwright/<run-id>/evidence-db/app-<n>.sqlite` before replaying a long browser suite. The failed test's `parallelIndex` in `playwright.json` plus one is its worker's `<n>`.
- **Loopback hangs behind a proxy:** Browser launch options include `--no-proxy-server` for local traffic.

Cases using `preservePromptWorkspace` restore their captured global model settings through the public API, then compare a separate GET with that baseline (excluding the advancing revision). A restore mismatch fails the originating case and reports the changed fields. `npm run verify:global-models -- --grep GMUI01` exercises this boundary with saved model selections and refusal-detection settings; a successful save response alone is not restoration evidence.

Local fixtures, browser emulation, live providers, and physical devices establish different evidence. Report which one actually ran.

## Reset and cleanup

`npm run cleanup` lists owned browser runs; `npm run cleanup -- --run <run-id>` removes one explicitly selected inactive run, including diagnostic artifacts. It never stops unrelated processes. The shared browser and self-host runners remove temporary databases on success and retain a copy under `evidence-db` on failure. The gallery retains its seeded database under `evidence-db` after either outcome.

The shared browser harness, self-host runner and tooling runner perform bounded local artifact retention after their own run finishes; the gallery does not invoke retention itself. For each owned output family, the newest three successes and five failures are retained, in addition to the current run, any active/alive-owner process, uncertain cleanup, unowned output and artifacts referenced by the current source's successful local release checks. `npm run cleanup -- --retention` previews candidates; add `--apply` for explicit cleanup. It never sends termination signals or removes arbitrary user data. Retention warnings are recorded independently and cannot turn a successful verification into a failed app test. CI uploads retain seven days of reports; browser fixtures use synthetic credentials, never production tokens.

`npm run reset:dev` deletes only this checkout's default `.local/uimori.sqlite` and its SQLite sidecars. Existing backups and older database files remain untouched. Stop the server first. The command rejects an in-use database or unsafe paths and does not reset an arbitrary `UIMORI_DB`.

Empty databases initialize at schema 15. Existing databases must already use schema 15 and the `uimori-personal-v1` format; older or future versions and unrelated formats are rejected before schema writes. No in-app upgrade from schemas 13 or 14 remains. Use disposable databases for development. Current data formats and this boundary are documented in [DATA-MIGRATIONS](../DATA-MIGRATIONS.md).

Manual storage measurements use `scripts/synthetic-story.mjs` and current transcript-v2 import, not obsolete package shapes or cumulative completed snapshots. After building, run `node --expose-gc scripts/measure-context-storage.mjs` or `node scripts/measure-transcript-import.mjs --counts=10,100`. These are synthetic measurements, not CI timing gates.

For a long-novel workload, use `node --expose-gc scripts/measure-context-storage.mjs --long-story --label baseline`. It imports 10/30/100 Korean scenes around 7,500 `o200k_base` tokens each and 50 synthetic lore entries, recording exact UTF-16 length, UTF-8 bytes, tokens and hashes. Reuse the emitted directory with `--fixture <directory> --label improved` for identical stored inputs and full-output hash comparisons. History, checkpoint lookup, logical-message capture and native display-context construction are timed separately (three warmups, nine samples). These stages exclude native workers, transport and providers; the legacy 8,000-character mode remains available without `--long-story`.

The existing Liquid Gallery runner also has opt-in long-reader timings:

```powershell
$env:UIMORI_BENCHMARK='1'
npm run verify:liquid-gallery -- --grep PERF
Remove-Item Env:UIMORI_BENCHMARK
```

This selects synthetic 8- and 30-scene workloads with roughly 7,500-token Korean originals and English translations, authored HTML/CSS, a local image and Lua button code. It records one warmup and five repetitions of re-entry, past-page navigation and saved original/translation switches in a desktop browser. Each Playwright JSON report includes the `long-reader-performance` attachment with exact text metrics, click-to-ready times, HTTP resource timings and main-thread long tasks. It verifies unchanged saved data and no new generation requests. The ready boundary is all target text plus visible images and two animation frames, not compositor paint; resource time includes local queue/transport and is not isolated server CPU. Timing values are observations, not pass thresholds. Reading preferences, themes and mobile layouts retain their separate functional browser checks.

`tests/database-schema.test.ts` checks fresh initialization, current DB reopening and refusal of unsupported files without changing their bytes. `tests/text-retention.test.ts` and `tests/execution-retention.test.ts` check retained messages and execution payloads without a live provider. Chats own their state and head directly; runtime branch identifiers and the branch table are removed.

### Interrupted browser runs

Browser checks use Playwright's live list reporter and a JSON report. If a run is interrupted before the JSON report completes, its test count is unknown rather than zero; consult the live log and individual failure traces. Do not label a partially executed suite as passing or make it pass by restoring a retired product contract.

### Synthetic generation

`core/fixture-provider.ts` exposes explicit fixture behavior separately from product chat settings. Unit tests pass options to `executeFixtureMain` or `MainHooks.fixture`; HTTP scenarios use `app.controls.fixture` or `/api/test/control` with `action: "fixture"`. The controls are exposed only in test mode, captured before execution waits, and never saved in chat settings or provider inputs. Normal generation still requires a configured model. Test settings conflicts with current `maxCalls`, not mock style fields.

Storage regressions are grouped by their owner: reader projections, chat option receipts, execution retention, text retention, and database initialization. The storage measurement tools use `scripts/synthetic-story.mjs`; the pre-native loading runner has been removed.

### Personal workspace verification scope

`npm run verify:personal-features` covers backups, search, cross-browser reading-position resume, bookmarks, usage, and PWA install. Optional push notifications are split into `npm run verify:push` so ordinary manuscript edits do not re-run PushManager/permission scenarios every time; run that suite whenever shared notification or push code changes. Actual mobile push delivery is separate from synthetic browser verification.
