# Native generation preparation measurement — 2026-10-13

## Selected user flow

When continuing a long story, native Risu preparation processes the previous messages before model work can proceed. `run-executor.ts` calls `prepareNativeRisuRun`, whose batch Worker runs `processNativeRisuTextInWorker` for each message. That created a CBS evaluator, cloned the full card/lore and built its database view even when the existing literal-text check immediately returned unchanged text.

`createNativeRisuCbs` now initializes that view only on its first nonliteral parse. The literal detector, input limit, native aliases, normalization, per-parse watchdog, variable writes and evaluation order remain the same. There is no cross-request cache, new dependency, parallel execution or model policy change. The production change is confined to this evaluator; its private initializer owns the existing setup code.

## Candidate comparison

| Candidate | Frequency / scale | Evidence and decision |
| --- | --- | --- |
| Repeated CBS setup during generation | Every native preparation, roughly two messages per scene; 10/100 long scenes, 50/500 lore entries | The preliminary batch probe took 68ms for 60 messages/50 lore and 196ms for 200 messages/500 lore. Selected after the larger actual preparation/request-builder measurement below. |
| Full live history for each displayed scene | Re-entry and page movement, up to five presentation requests; 8/30 long scenes in existing browser fixture | Existing browser baseline: re-entry medians 374/684ms, previous page 381/622ms. Shared history would require a new cross-request or batch boundary. Previous discarded-context optimization is already present at baseline. Deferred. |
| Repeated HTML parsing when switching original/translation | Each saved-language switch; about 7,500 tokens per text | Browser medians 11–16ms, no new API request. Insufficient absolute wait to justify a sanitizer change. Deferred. |
| Asset alias index construction | Each displayed original/translation, image-rich cards | Preliminary synchronous render medians: 100 assets 1.9ms, 1,000 assets 10.7ms, 3,000 assets 60.4ms. Possible smaller follow-up; no asset implementation included. |
| Manuscript search ancestor numbering | Each debounced search / continuation page across visible ancestry | Static candidate only; not measured or changed. |

Preliminary probes are hypothesis selection evidence, not the adopted improvement's baseline. Raw probes are in `output/candidate-probe.{mjs,json}`. The original browser run completed both tests but failed process cleanup; it is not a passing verification run. Its owned processes were identified and stopped before subsequent measurements.

## Method and adoption criterion

- Initial tree: clean, HEAD `b67f533bb38688e56893be61355157231957b8be`. No existing user changes were overwritten or included in the commit.
- Environment: Windows 10.0.26300 x64, Node 24.14.0, SQLite 3.51.2, Ryzen 7 7800X3D, 16 logical CPUs, about 32GiB RAM.
- Exact reusable JSON snapshots and isolated SQLite DBs under `output/benchmarks/native-run-20261013-v2/`. Original corpus is deterministic synthetic Korean: 10 scenes = 124,593 UTF-16 characters / 75,570 o200k_base tokens; 100 scenes = 1,254,376 characters / 755,700 tokens. Lore entries are 300 characters each, matching the existing synthetic bot helper. No assets, Lua scripts, private materials or paid calls are needed for this generation fixture. The current request contains a variable write/read to exercise CBS alongside ordinary prose.
- Timing starts at `prepareNativeRisuRun` and ends after `buildMainProviderRequest` and `JSON.stringify(encodeResponses(...).body)`. Real input/editInput/start invocation paths run, without preview mode. The Risu preparation interval is also recorded separately. DB reservation/history capture, lore selection, context compaction, HTTP/model wait and click-to-first-token are excluded. The serialized request is a local compatibility oracle, not an executed large model request.
- First invocation recorded separately; then two warmups and nine samples. Explicit GC is outside timing. No OS cache reset; no cold-cache or p95/p99 claim. CPU includes Workers. RSS is sampled every 5ms and at return; synchronous peaks and retained heap are not established.
- Before implementation: require at least 50ms and 15% median reduction in the long preparation scenario, no material normal-case regression, identical prepared output/wire and preserved data, without retained caches or dependencies.
- Builds, tests and other heavy work were not concurrent with measurements. Independent agents only inspected source. Final comparison uses the same fixture and runner logic; source/build hashes and uncommitted diffs are in each report, not HEAD alone.

The initial DB assertion compared main SQLite file bytes and omitted WAL contents. That failed after reopening despite no writes during the measured flow. The runner now hashes every logical table row, including data in WAL. Both baseline and modified code were rebuilt and remeasured after that correction; `baseline.json` and `after.json` are the accepted pair. Earlier preliminary reports are excluded.

## Results

All times are milliseconds, median with min–max in parentheses, nine samples per condition.

| Scenario | Before: preparation + request serialization | After | Absolute reduction | Reduction |
| --- | --- | --- | --- | --- |
| 10 scenes / 50 lore | 201.26 (194.70–204.15) | 191.88 (185.20–194.93) | 9.38ms | 4.7% |
| 100 scenes / 500 lore | 511.48 (506.02–524.09) | 283.53 (281.14–291.88) | 227.95ms | 44.6% |

| Resource / stage | 10 scenes before → after | 100 scenes before → after |
| --- | --- | --- |
| Native preparation median | 190.88 → 181.89ms | 444.87 → 216.53ms (−51.3%) |
| Process CPU median (range) | 219 (188–235) → 219 (187–297)ms | 578 (532–656) → 328 (281–375)ms |
| Sampled process RSS median | 150.50 → 151.43MiB | 282.66 → 282.54MiB |
| Worker starts per invocation | 3 → 3 | 3 → 3 |
| Serialized request bytes | 342,607 → 342,607 | 3,048,049 → 3,048,049 |
| First invocation total | 231.35 → 228.00ms | 522.16 → 298.38ms |

The long-case reduction is far larger than the observed variation and meets the criterion. The small-case gain is modest; do not generalize it as a stable speed guarantee. No meaningful memory reduction is claimed. Prepared output, variable result, complete input snapshot, wire body and every logical DB row are unchanged. No model request is sent, and identical wire bytes do not imply actual API billing savings.

At this workload the removed work saves about 0.23 seconds of local preparation on each continuation. It does not establish the same reduction in full user click-to-response latency: context selection/compaction, provider latency and browser scheduling are outside the boundary. Ordinary prose benefits most; histories full of CBS expressions still need evaluator initialization.

## Reproduction and verification

```powershell
npm run build
node --expose-gc scripts/benchmark-native-run.mjs output/benchmarks/native-run-local baseline
# Apply the CBS change and rebuild before using the identical stored input.
npm run build
node --expose-gc scripts/benchmark-native-run.mjs output/benchmarks/native-run-local after
```

Raw evidence: `output/benchmarks/native-run-20261013-v2/baseline.json`, `after.json`, `input-10.json`, `input-100.json`, the two SQLite fixtures, per-label `.diff` and saved runner sources. Production build source hashes are `6819ccc2cb39883c0d17f9a637ac0c29d3d17389b43eac55663bcdf4c36ceffb` before and `9471c39312a003efa84818de725e023fe8f82af2413996e5b97f421509f96781` after. Full-tree fingerprints include the measurement script and test edits; app compilation hashes are recorded separately. Generated evidence is local and untracked.

Focused checks use:

```powershell
npm test -- tests/risu-native-prepare.test.ts tests/risu-native-render.test.ts tests/risu-native-import.test.ts tests/risu-native-semantics.test.ts tests/risu-native-preset.test.ts tests/native-cbs-session.test.ts tests/package-presentation-session.test.ts tests/main-request.test.ts tests/native-wire.test.ts
npm run quality
$env:UIMORI_BENCHMARK='1'
npm run verify:liquid-gallery -- --grep PERF
Remove-Item Env:UIMORI_BENCHMARK
node scripts/check-documentation.mjs
git diff --check
```

The focused tests cover sequential variable writes, greeting/message roles, native aliases, text/output limits, timeout/cancellation, import normalization, request construction, protocol encoding and original/translation display sessions. Final applicable results: 141 tests passed across nine files; three personal-sample tests were skipped because no external sample root was configured. The failed render file was rerun after correcting the new test's unsupported viewport expectation against the existing vendored CBS contract (empty text plus an issue); production behavior was not changed to satisfy the test. The other eight passing files were reused. Sandbox SSR file errors required a host rerun and are not counted as passes.

`npm run quality`, documentation validation and `git diff --check` passed. The current matching build passed both 8/30-scene long-reader browser scenarios, including unchanged sources/translations/runs/attempts/variables, no added generation requests and complete process cleanup. Evidence: `output/playwright/liquid-gallery-2026-10-13T02-00-36-806Z-48e97a3c/summary.json` and its `playwright.json` timing attachment. This was a host rerun after the baseline sandbox cleanup failure; browser timings are not used for a same-environment before/after improvement claim. Private card behavior, physical mobile devices, production hardware, external model quality and actual API costs remain unmeasured.
