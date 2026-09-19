# Quality and verification

Use the Node version in [`.nvmrc`](../.nvmrc) and [`package.json`](../package.json). Setup, command details, and recovery are in [DEVELOPMENT](DEVELOPMENT.md).

<a id="실행-시점"></a>

## Verification

Choose checks that can expose failures caused by the change. Completing a feature or making a commit does not, by itself, require a full suite.

| Change or question | Useful checks |
| --- | --- |
| Code behavior | Focused tests, such as `npm test -- tests/<file>.test.ts`; use `npm run quality` for lint and type checks when relevant |
| UI behavior | The relevant `verify:*` command against a matching build; `verify:browser-smoke` covers basic chat and global prompt settings |
| Verification tooling | Tests for the affected runner; `npm run test:tooling` covers the full tooling suite |
| Cross-cutting changes beyond focused coverage | Consider `npm run quality:full`, `verify:smoke`, or broader browser coverage for the interactions at risk |
| Documentation only | Check accuracy, links, commands, consistency, and `git diff --check` |
| Release candidate | `npm run release:check -- --area <verify:*>`; see below |

Use the smallest existing tests that exercise the affected behavior and plausible failures. Add tests for gaps that matter, rather than mirroring implementation. Once the relevant checks pass, finish. Rerun or expand only for a subsequent change, failure, or unresolved risk.

`quality` runs Biome and TypeScript without starting the app or a browser; `check` runs TypeScript alone. `quality:full` runs `quality`, `test:tooling`, a fresh build, then the complete Vitest suite. The build precedes Vitest because some tests restart the compiled server. `verify:smoke` runs the M0 F02/F03/F06 application checks; it is distinct from the smaller browser smoke.

Use `verify:redesign` for broad browser regression, `verify:visual` for additional viewports and layout review, and `benchmark:story` for repeated performance measurements when those questions matter. [UI-GALLERY](UI-GALLERY.md) describes screenshot capture.

## Builds and evidence

Tests that import source directly need no build. A check that executes `dist` needs a build matching its inputs. Rebuild only when those inputs changed or the artifact is missing; documentation and test-only edits do not automatically require it. The shared app and browser runners check source/build identity and provide isolated databases, ports, and output paths.

Reuse relevant results while their source, environment, and test assumptions remain applicable. After a small follow-up edit, run affected checks and distinguish that result from an earlier full run. Report what actually ran, including failures and blocked checks; synthetic checks support different claims from provider, device, or production observations. An environment failure such as Windows `spawn EPERM` is a blocked observation, not an application result. See [DEVELOPMENT](DEVELOPMENT.md) for recovery.

Browser defaults are defined in [`fixtures/browser-viewports.json`](../fixtures/browser-viewports.json). Shared runners preserve failure screenshots and traces; `NR_VISUAL_REVIEW=1` enables extra visual checks and successful screenshots for a selected domain. Inspect the rendered output when making a visual claim.

## Release checks

The current [`release-check` runner](../scripts/release-check.mjs) requires `quality:full`, `verify:smoke`, and the selected local feature `verify:*` command. The default area is `verify:browser-smoke`; `--full` adds `verify:redesign`. Choose wider coverage when the release changes shared behavior broadly or is intended to establish a stabilization baseline. Release/self-host tooling normally uses `--area verify:selfhost`.

The runner writes a receipt to `output/release/checks/`. It reuses each successful check only when source, verification inputs, Node version, platform, and the saved log hash match. A missing or stale build can be rebuilt without repeating still-valid checks. Recorded failed or incomplete checks must be resolved; narrowing the requested area does not clear them. Plain terminal output from separately run commands is not an importable receipt. Deployment behavior and additional source/remote requirements are in [ORACLE-RELEASE](ORACLE-RELEASE.md).

## Static checks and CI

[`biome.json`](../biome.json) owns formatting, lint rules, exceptions, and direct import restrictions; TypeScript uses strict checking. Biome blocks application-layer imports into `core`, browser imports into `server`, server/Node imports into `web`, and test/tool imports into product code. [`tests/module-cycles.test.ts`](../tests/module-cycles.test.ts) separately checks static value-import cycles in `core` and `server`. These checks do not establish transitive dependency or browser runtime safety. Prefer a narrow, explained suppression when a rule cannot express valid code.

[CI](../.github/workflows/quality.yml) runs `npm ci` and `quality:full` on Windows for pull requests and pushes to `main`. Its manual `browser` option adds a fresh build and `verify:redesign` after quality passes. Local results and CI results are separate evidence.
