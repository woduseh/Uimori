# JEV full-response input verification

## Reproduce

Build the current application, configure the server-local JEV credential, then explicitly opt in to the input verification:

```sh
npm run build
node scripts/verify-jev-input.mjs --live
```

The probe invokes the compiled application main and translation judgment functions against `https://api.typesafe.ai/v1/systemone`, model `jev-latest`. It uses the saved `.local/uimori.sqlite` JEV credential (or the existing environment fallback) without printing it. It does not read conversations, change application data, automatically retry calls, or store successful request/response bodies. The default report is `.local/jev-input-verification.json`; an optional positional path overrides it. A failed case makes the process exit with code 1.

The current implementation rejects the 500,000-token cases before transport with `JEV_INPUT_BUDGET`, so the default run makes only two baseline API calls. The historical six calls below predate that preflight. For the maximum main case alone, `--diagnostic-max-main` now checks that preflight without a paid request. When transport occurs, diagnostic mode captures the provider JSON error field from at most 8 KiB of response data. It never logs request headers or credentials:

```sh
node scripts/verify-jev-input.mjs --live --diagnostic-max-main .local/jev-input-diagnostic.json
```

To test a long candidate below the estimated budget, run two calls with 16,000 candidate tokens, one per judgment path:

```sh
node scripts/verify-jev-input.mjs --live --within-budget .local/jev-input-within-budget.json
```

## Published limits

The [official model specifications](https://docs.typesafe.ai/models) list a 64k-token total for state plus all questions and a 32k-token limit for state plus the longest question. The application checks those respective 64,000 and 32,000 budgets using `o200k_base` estimates, preserves the complete candidate on failure, and never truncates it. These are published provider budgets; the exact provider tokenizer is not established. A below-budget local estimate therefore does not guarantee provider acceptance. Provider `max_tokens_exceeded` errors also map to `JEV_INPUT_BUDGET`.

The candidate is `' story'.repeat(targetTokens)`, whose length is checked with the application's `o200k_base` estimator. Each outgoing wire must contain the identical complete candidate in `state.response` and exactly one question, `explicitRefusal`. The maximum case uses 500,000 candidate tokens, matching the generation-setting ceiling in `core/model-capabilities.ts`. This estimator is not the JEV provider tokenizer, and this synthetic repeated-text input does not establish behavior for every language or content distribution.

## Observed live result: 2026-09-20

Four calls ran from 06:56:26 through 06:56:32 UTC using the new full-response judgment implementation. All four recorded exactly one attempt and passed the complete-state equality assertion. No retries or input truncation occurred.

| Judgment | Candidate tokens / characters | Request bytes | Outcome | Refusal score | Provider input / output tokens | Duration |
| --- | ---: | ---: | --- | ---: | --- | ---: |
| Main baseline | 128 / 768 | 1,531 | accepted | 0.03 | 524 / 23 | 562 ms |
| Translation baseline | 128 / 768 | 1,193 | accepted | 0.01 | 455 / 23 | 237 ms |
| Main maximum | 500,000 / 3,000,000 | 3,000,763 | `JEV_HTTP_400` | unavailable | unavailable | 2,315 ms |
| Translation maximum | 500,000 / 3,000,000 | 3,000,425 | `JEV_HTTP_400` | unavailable | unavailable | 2,786 ms |

Candidate SHA-256 values:

- Baseline: `1a2114061064b832fd68fc587e0dab2342e861f790a2e66f573e9764e15c6a90`
- Maximum: `741242be547aa29b53b2a6c44eba7911e9c9fd124105647cdf58e27535e02ca1`

Maximum request SHA-256 values:

- Main: `d67392ab0bd078ccbc965215c18895c97f31d74dca523fd60f156f9b94083d34`
- Translation: `a5db42f2d4e18ecbcbf7d444e2df0ced70e2e104711918a65d34fec9e73641a8`

**The application's maximum allowed output size did not pass live JEV verification.** The baseline proves that the connection and the single-question request contract worked during the same run. Both concrete maximum inputs were rejected with HTTP 400.

One additional diagnostic maximum-main call at 06:58:05 UTC, using the same candidate and request hashes, returned `{"error_type":"max_tokens_exceeded"}` in the provider JSON error field after 2,383 ms. This fifth call was an explicit investigation of the failed result, not an automatic retry. It confirms a provider token-budget rejection for that input, but the error itself supplies no numerical boundary. The application now maps that explicit provider error to `JEV_INPUT_BUDGET`; the initial four-call report predates that mapping and therefore records `JEV_HTTP_400`. The published numerical limits were subsequently located in the model specifications cited above.

A sixth diagnostic call at 07:00:33 UTC recorded the exact envelope path: `detail.error_type = "max_tokens_exceeded"`. It took 2,525 ms and again verified identical full input and a single question. The intermediate build only recognized top-level and `error.error_type` fields, so this call still reported `JEV_HTTP_400`. The implementation was then corrected to recognize the observed `detail` envelope; automated tests verify that mapping. A further over-budget live call after this correction was not performed. The sixth-call metadata is in `.local/jev-input-diagnostic-mapped.json` (its filename does not imply a successful mapping).

## Final implementation: long live calls and preflight

After adding the published 64k/32k preflight, two additional live calls on 2026-09-20 at 07:03:36–07:03:38 UTC used 16,000 estimated candidate tokens / 96,000 characters. Both exceeded the former 6,000/5,000 application budgets, sent exactly the complete candidate as `state.response`, and contained only `explicitRefusal`:

| Judgment | Request bytes | Outcome | Refusal score | Provider input / output tokens | Duration |
| --- | ---: | --- | ---: | --- | ---: |
| Main long | 96,763 | accepted | 0.04 | 16,396 / 23 | 991 ms |
| Translation long | 96,425 | accepted | 0.01 | 16,327 / 23 | 360 ms |

The candidate SHA-256 was `319a56b5957e4a526b689c56e0d538681c871b7984ece858657fbd01cb64a2ba`. Main request SHA-256 was `a6ae0feb1f6f5052908f2d54729c1f6ddd066a2ce436f220b320340dea66c1e4`; translation request SHA-256 was `5b9334f6d85aa5ad2b5e7274e60064551cb1d3877f794cc1af788f60a5275dea`. Each made exactly one attempt. The report is `.local/jev-input-within-budget.json`.

A final maximum-main preflight at 07:03:39 UTC rejected the same 500,000-token candidate with `JEV_INPUT_BUDGET` in 81 ms, with **zero transport attempts**. Its report is `.local/jev-input-preflight.json`. This run made no additional API call. Across the entire investigation there were eight real calls, with no automatic retries. These results show long whole-input acceptance for the specific synthetic candidate and explicit preflight rejection of the application maximum, not acceptance of arbitrary maximum-length model output.

When service-refusal judgment is enabled, the application must preserve the generated candidate and fail the judgment on this result. It must not silently shorten the candidate, accept it without judgment, or retry a failed judgment as a translation refusal. The separate main/translation disable switches deliberately bypass judgment for that role; these probes exercise the enabled judgment functions. Automated application tests cover those preservation and failure-path contracts; this standalone probe verifies the real judgment transport and does not itself create a persisted Run.
