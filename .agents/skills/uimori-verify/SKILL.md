---
name: uimori-verify
description: Run Uimori's standard browser verification loop for a UI or app change — doctor, build, npm run verify for the owning feature-map domain, desktop and mobile screenshot review, cleanup. Use for 브라우저 검증, UI 확인, verify 실행, or choosing which browser specs a change needs. Not for unit-only changes, release checks or Oracle deployment.
---
# Uimori verify

One loop for browser evidence. Paths are relative to the repository root. Which checks a change needs is decided in `docs/dev/CHECKS.md`; runner details and the feature-map rules live in `docs/dev/DEVELOPMENT.md`. Read those sections instead of copying them here.

## 1. Doctor

```powershell
npm run doctor
```

Run it when the environment is new or a previous run reported `BLOCKED`. A blocked browser, Node or child process is an environment problem: report it, do not work around it in tests.

## 2. Build

```powershell
npm run build
```

Browser runs execute `dist` and refuse a build that does not match the source ("Run npm run build"). Finish the edits first, then build once.

## 3. Verify the owning domain

```powershell
npm run verify -- --changed
npm run verify -- <domain>
npm run verify -- <domain> --grep <case-or-title> --visual
```

- `--changed` picks the domains whose `sources` or specs in `tests/feature-map.json` match the changed files. It prints which domains it chose, and the browser inputs no domain covers (it adds `browser-smoke` for those). Check that list against the change before trusting it.
- Name the domain yourself when you know the owner; an unknown name prints every domain, preset and engine with its title.
- `--grep` narrows a run for diagnosis. A narrowed run is not the domain's evidence; rerun the domain without it before reporting.
- A `SKIP <spec>: set <VAR>` line means a spec needs private local material that is not configured. Report the skip; do not set variables to private data you were not given.
- Only one browser run holds the machine at a time; a second one waits. Do not start parallel runs, and leave `npm run verify -- all` to the once-per-bundle full run.

The last line of each run is JSON with `status`, `runId` and the path of `summary.json` under `output/playwright/<run-id>/`. Only `PASS` is a pass; `FAIL` and `BLOCKED` keep their traces and a copy of the databases under `evidence-db`.

## 4. Review desktop and mobile screenshots

For a change that alters what the user sees, rerun the domain with `--visual` (add `--grep` to the affected cases if the domain is large). Then:

1. Open `summary.json` and read its `screenshots` list; the paths are relative to the run directory.
2. Open the captures of the changed surface at both widths (`fixtures/browser-viewports.json` sets them; file names carry `mobile`/`desktop` or the width).
3. Check the changed surface itself: layout at both widths, overflow, clipped text, focus and empty, loading and error states the change touches.
4. If no capture shows the changed surface, say so; `npm run verify -- gallery` captures the main screens in light and dark themes.

Screenshots support inspection; their existence alone does not prove the result looks right. Report what you looked at.

## 5. Clean up

```powershell
npm run cleanup
npm run cleanup -- --run <run-id>
```

Successful runs remove their temporary databases and apply bounded retention on their own. List the owned runs, and remove a failed run's artifacts once its evidence has been read or reported. Cleanup never stops unrelated processes.

## Report

State the command, `runId`, test count and status for each run, any `SKIP` lines, which screenshots were reviewed at which width, and what was not covered: synthetic fixtures, not live providers or physical devices.
