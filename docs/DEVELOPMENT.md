# Development

Use [QUALITY](QUALITY.md#verification) to choose checks and [CODE-MAP](CODE-MAP.md) to find feature contracts and entry points. This page covers running the tools.

## Environment and setup

Use Node 24.x, at least 24.14.0, as specified by [package.json](../package.json) and [.nvmrc](../.nvmrc). Windows PowerShell is the primary development environment; the browser helpers also discover Chrome and Edge on macOS and Linux.

```powershell
npm ci --no-audit --no-fund
npm run dev
```

For an offline install with a populated npm cache, add `--offline`. `dev` builds and starts the server; `npm start` uses the existing build. See [README](../README.md) for app configuration.

Run `npm run doctor` when diagnosing the environment. It checks Node, child processes, SQLite, loopback HTTP, and Chromium. `--no-browser` checks only the API environment. Set `NR_BROWSER_PATH` to use a browser outside the discovered locations.

## Verification runners

Use a build matching the current app source for checks that execute `dist`. Focused tests that import source modules do not need a build. [QUALITY](QUALITY.md) explains build reuse and check selection.

| Command | Purpose |
| --- | --- |
| `npm run verify:smoke` | M0 F02/F03/F06: environment, build, server identity, generation/conflicts/reconnection, runner selftest, and cleanup. |
| `npm run verify:browser-smoke` | Small browser suite for chat and global prompt settings. |
| Feature-specific `verify:*` scripts | Suites such as `verify:packages`, `verify:providers`, `verify:library`, and `verify:navigation`; see [package scripts](../package.json). |
| `npm run verify:redesign` | Full local synthetic browser regression. |
| `npm run verify:selfhost` | Local synthetic HTTPS proxy, session, and reconnection checks using Chromium. |
| `npm run verify:visual` | Full browser suite with extra viewport and layout checks; use `--grep` to focus it. |
| `npm run verify:gallery` | Screen and journey captures; see [UI-GALLERY](UI-GALLERY.md). |
| `npm run benchmark:story` | Repeated long-story performance measurements. |
| `npm run verify:selftest` | Runner failure-detection tests. |

Feature runners using the [shared browser harness](../scripts/browser-verification.mjs) accept `--grep <pattern>` to narrow their existing selection and `--visual` to enable extra visual checks:

```powershell
npm run verify:providers -- --grep PMUI03
npm run verify:providers -- --grep PMUI03 --visual
```

A focused report records the selected files and filter. It requires at least one executed test, but does not claim the full suite's coverage or require screenshots from unselected cases.

For a specific milestone or case:

```powershell
npm run verify -- --milestone M1-local --case P07,P08
npm run verify -- --case F04
```

`M0`, `M1-local`, and `M2-local` select local synthetic case groups. `M1` and `M2` are aliases for their local groups. These runners reuse a matching build and rebuild only when it is missing or stale; run `quality` separately when lint or type checks are needed. Live-model, creative-quality, and physical-device evaluation are outside these commands.

The worktree isolation runner takes two prepared, clean worktrees at the same commit, each with dependencies and a build:

```powershell
node scripts/verify-worktrees.mjs --a '<worktree A>' --b '<worktree B>'
```

It verifies separate server/browser resources without creating worktrees.

## Results and troubleshooting

Browser reports, screenshots, traces, and `summary.json` are under `output/playwright/<run-id>/`. The common runner uses fresh DBs and ports, records source/build identity, and cleans up its processes. Its exit code and summary distinguish failed checks, missing prerequisites, and cleanup failures.

- **Child-process or browser failure:** `spawn EPERM` or a missing browser is an environment blocker. Diagnose with `doctor` and rerun in an environment that can execute the required process.
- **Stale build:** Rebuild when app inputs changed. The runners check build identity separately from test inputs.
- **Unexpected shared settings:** Inspect the preserved SQLite at `output/playwright/<run-id>/evidence-db/app.sqlite` before replaying a long browser suite.
- **Loopback hangs behind a proxy:** Browser launch options include `--no-proxy-server` for local traffic.

Local fixtures, browser emulation, live providers, and physical devices establish different evidence. Report which one actually ran.

## Reset and cleanup

`npm run cleanup -- --run <run-id>` cleans up resources owned by that run. Reports and evidence are separate from live process cleanup.

`npm run reset:dev` deletes this checkout's default `.local/narrative.sqlite`, its SQLite sidecars, and recognized legacy backups. Stop the server first. The command rejects an in-use database or unsafe paths and does not reset an arbitrary `NR_DB`.

Current data formats and supported upgrades are documented in [DATA-MIGRATIONS](DATA-MIGRATIONS.md).
