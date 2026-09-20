# Development

Use [QUALITY](QUALITY.md#verification) to choose checks and [CODE-MAP](CODE-MAP.md) to find feature contracts and entry points. This page covers running the tools.

## Environment and setup

Use Node 24.x, at least 24.14.0, as specified by [package.json](../package.json) and [.nvmrc](../.nvmrc). Windows PowerShell is the primary development environment; the browser helpers also discover Chrome and Edge on macOS and Linux.

```powershell
npm ci --no-audit --no-fund
npm run dev
```

For an offline install with a populated npm cache, add `--offline`. `dev` builds and starts the server; `npm start` uses the existing build. See [README](../README.md) for app configuration.

Run `npm run doctor` when diagnosing the environment. It checks Node, child processes, SQLite, loopback HTTP, and Chromium. `--no-browser` checks only the API environment. Set `UIMORI_BROWSER_PATH` to use a browser outside the discovered locations. The shared resolver falls back to an installed Playwright Chromium.

## Verification runners

Use a build matching the current app source for checks that execute `dist`. Focused tests that import source modules do not need a build. [QUALITY](QUALITY.md) explains build reuse and check selection.

| Command | Purpose |
| --- | --- |
| `npm run quality:full` | Formatting, lint, types, tooling tests, fresh build and complete Vitest suite. |
| `npm run test:tooling` | Build, verification and release-tooling tests, including failure detection. |
| `npm run verify:browser-smoke` | Small browser suite for chat and global prompt settings. |
| `npm run verify:ui` | Reader layout, editing and reading preferences; accepts `--grep` and `--visual`. Renderer unit tests run separately with `npm test -- tests/prose.test.ts`. |
| Feature-specific `verify:*` scripts | Suites such as `verify:packages`, `verify:providers`, `verify:library`, and `verify:navigation`; see [package scripts](../package.json). |
| `npm run verify:redesign` | Full local synthetic browser regression. |
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

The worktree isolation runner takes two prepared, clean worktrees at the same commit, each with dependencies and a build:

```powershell
node scripts/verify-worktrees.mjs --a '<worktree A>' --b '<worktree B>'
```

It verifies separate server/browser resources without creating worktrees.

After a matching build, `node --expose-gc scripts/benchmark-native-preparation.mjs` compares sequential and batched native text preparation for 10, 50 and 100 messages, three times each. It checks identical outputs and records elapsed time, Worker calls, sampled process RSS and cancellation latency under `output/benchmarks/`. These synthetic measurements exclude callbacks and provider work.

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

Only empty and current schema-21 databases are admitted. Older databases are rejected before schema writes; use a separate empty path for new development. Current data formats and this boundary are documented in [DATA-MIGRATIONS](DATA-MIGRATIONS.md).
