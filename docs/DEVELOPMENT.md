# Development

Use [CODE-MAP](CODE-MAP.md) to find feature contracts and entry points. This page covers setup, check selection, execution, and troubleshooting.

## Environment and setup

Use Node 24.x, at least 24.14.0, as specified by [package.json](../package.json) and [.nvmrc](../.nvmrc). Windows PowerShell is the primary development environment; the browser helpers also discover Chrome and Edge on macOS and Linux.

```powershell
npm ci --no-audit --no-fund
npm run dev
```

For an offline install with a populated npm cache, add `--offline`. `dev` builds and starts the server; `npm start` uses the existing build. See [README](../README.md) for app configuration.

Run `npm run doctor` when diagnosing the environment. It checks Node, child processes, SQLite, loopback HTTP, and Chromium. `--no-browser` checks only the API environment. Set `UIMORI_BROWSER_PATH` to use a browser outside the discovered locations. The shared resolver falls back to an installed Playwright Chromium.

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

## Verification runners

Use a build matching the current app source for checks that execute `dist`. Focused tests that import source modules do not need a build.

| Command | Purpose |
| --- | --- |
| `npm run quality:full` | Formatting, lint, types, tooling tests, fresh build and complete Vitest suite. |
| `npm run test:tooling` | Fresh build plus build, verification and release-tooling tests, including failure detection. |
| `npm run verify:browser-smoke` | Small browser suite for chat and global prompt settings. |
| `npm run verify:ui` | Reader layout, editing and reading preferences; accepts `--grep` and `--visual`. Renderer unit tests run separately with `npm test -- tests/prose.test.ts`. |
| Feature-specific `verify:*` scripts | Suites such as `verify:packages`, `verify:providers`, `verify:library`, and `verify:navigation`; see [package scripts](../package.json). |
| `npm run verify:browser` | Full local synthetic browser regression. |
| `npm run verify:selfhost` | Local synthetic HTTPS proxy, session, and reconnection checks using Chromium. |
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

## Builds and evidence

Reuse results while their source, environment, and test assumptions remain applicable. After a follow-up edit, run affected checks and distinguish them from an earlier full run. Documentation and test-only changes do not invalidate compiled app inputs.

Local tooling and browser reports record the executed source/build identity. Tests, scripts, fixtures or compiled artifacts changing during a run invalidate it. Product-source drift alone records `reusableForCurrentSource: false`; that result describes the recorded build, not the new source. Release receipts still require unchanged full source identity. Runtime vendor inputs in `third_party` participate in build and verification hashes.

Actual local Risu materials are excluded from ordinary browser discovery. Set `UIMORI_RISU_SAMPLE_ROOT` for `node scripts/verify-risu-native-samples.mjs`, optionally `UIMORI_RISU_SAMPLE_PRESET` for an external `.risup`, and use `--grep` to focus cases. Source materials remain read-only; private rendered artifacts stay in ignored output directories. These loopback fixture checks do not establish live-provider quality or universal script compatibility.

## Release checks

`npm run release:check -- --area <verify:*>` runs `quality:full` and the selected browser area. The default is `verify:browser-smoke`; `--full` replaces that default with `verify:browser`. Explicit areas remain selected alongside the full suite. Deployment-tooling changes normally select `verify:selfhost`. Receipt matching, reuse and deployment rules are in [ORACLE-RELEASE](ORACLE-RELEASE.md).

## Static checks and CI

[Biome](../biome.json) owns formatting, lint rules and direct import boundaries. TypeScript uses strict checking. The dependency tests parse TypeScript/JavaScript syntax and recursively discover source files: side-effect imports and re-exports participate in eager runtime cycle checks, erased type imports do not. Literal dynamic imports participate in snapshot boundary checks but not eager cycles. Computed runtime import paths are not statically resolved. License and snapshot manifest checks remain separate.

[CI](../.github/workflows/quality.yml) reports the Windows quality job for every PR and main push. Changes limited to Markdown under `docs/`, root README/AGENTS or LICENSE skip installation/build/tests; mixed changes, missing comparison history and manual runs execute full quality. After quality passes, non-documentation changes also run a small Ubuntu job: one build, `npm test -- tests/server.test.ts tests/chat-backup.test.ts`, then `npm run verify:browser -- --grep READERREC` using Playwright Chromium. This covers server persistence/restart, backup recovery and Reader request/SSE recovery without repeating the full suite on Linux. The Windows quality and Linux core jobs each have a 30-minute emergency cap so normal hosted-runner variance can finish and report test failures; individual test deadlines remain the primary stuck-work detector. Manual browser runs still build and execute the complete `verify:browser` suite. Local results, hosted Linux CI and Oracle ARM64 deployment are separate evidence.

`node scripts/measure-native-storage.mjs` measures expanded JSON, packed rows, shared text and SQLite pages for actual native preparation over 10, 100 and 300 synthetic 8 KB scenes. It retains an isolated measurement DB and report under `output/benchmarks/`; it never opens user databases or calls providers. The three snapshots share one isolated text pool; the report checks JSON roundtrip equality. These are not measurements of cumulative production DB growth.

## Results and troubleshooting

Browser reports, screenshots, traces, and `summary.json` are under `output/playwright/<run-id>/`. The common runner uses fresh DBs and ports, records source/build identity, and cleans up its processes. Its exit code and summary distinguish failed checks, missing prerequisites, and cleanup failures.

- **Child-process or browser failure:** `spawn EPERM` or a missing browser is an environment blocker. Diagnose with `doctor` and rerun in an environment that can execute the required process.
- **Stale build:** Rebuild when app inputs changed. The runners check build identity separately from test inputs.
- **Unexpected shared settings:** Inspect the preserved SQLite at `output/playwright/<run-id>/evidence-db/app.sqlite` before replaying a long browser suite.
- **Loopback hangs behind a proxy:** Browser launch options include `--no-proxy-server` for local traffic.

Local fixtures, browser emulation, live providers, and physical devices establish different evidence. Report which one actually ran.

## Reset and cleanup

`npm run cleanup -- --run <run-id>` cleans up resources owned by that run. Reports and evidence are separate from live process cleanup.

`npm run reset:dev` deletes only this checkout's default `.local/uimori.sqlite` and its SQLite sidecars. Existing backups and older database files remain untouched. Stop the server first. The command rejects an in-use database or unsafe paths and does not reset an arbitrary `UIMORI_DB`.

Only empty and current schema-24 databases are admitted. Older databases are rejected before schema writes; use a separate empty path for new development. Current data formats and this boundary are documented in [DATA-MIGRATIONS](DATA-MIGRATIONS.md).
