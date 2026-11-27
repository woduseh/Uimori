---
name: uimori-verify
description: Run Uimori's standard browser verification loop for a UI or app change — doctor, build, npm run verify for the owning feature-map domain, desktop and mobile screenshot review, cleanup. Use for 브라우저 검증, UI 확인, verify 실행, or choosing which browser specs a change needs. Not for unit-only changes, release checks or Oracle deployment.
---
# Uimori verify

One loop for browser evidence. Paths are relative to the repository root. `docs/dev/CHECKS.md` decides which checks a change needs. Commands, options and report fields are in `docs/dev/DEVELOPMENT.md` under "Verification runners", "Feature map" and "Reset and cleanup". This file holds only the order and the judgment calls.

1. **Doctor**: `npm run doctor` when the environment is new or a run reported `BLOCKED`. A blocked browser, Node or child process is an environment problem: report it, do not work around it in tests.
2. **Build**: `npm run build`, once, after the edits are finished.
3. **Verify** the owning domain: `npm run verify -- <domain>`, or `npm run verify -- --changed`.
   - Check the domains `--changed` printed against the change before trusting it.
   - `--grep` is for diagnosis. A narrowed run is not the domain's evidence; rerun the domain without it before reporting.
   - Report a `SKIP <spec>: set <VAR>` line. Do not set variables to private data you were not given.
   - Leave `npm run verify -- all` to the once-per-bundle full run.
   - Only `PASS` in the final JSON line is a pass.
4. **Look**, for a change the user can see: rerun with `--visual`, read the `screenshots` list in the run's `summary.json`, and open the captures of the changed surface at both widths (`fixtures/browser-viewports.json` sets them). Check layout, overflow, clipped text, focus, and the empty, loading and error states the change touches. If no capture shows the changed surface, say so; `npm run verify -- gallery` captures the main screens in light and dark themes. A screenshot existing does not show that the result looks right.
5. **Clean up**: once a failed run's evidence has been read or reported, remove it with `npm run cleanup -- --run <run-id>`.

## Report

State the command, `runId`, test count and status for each run, any `SKIP` lines, and which screenshots you looked at, at which width. Name the one to three screens and states the user should look at themself, because how it looks and feels is their call. Say what was not covered: the fixtures are synthetic, not live providers or physical devices.
