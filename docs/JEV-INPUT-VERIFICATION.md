# JEV full-response input verification

## Reproduce

Build the current application, configure the server-local JEV credential, then explicitly opt in to the input verification:

```sh
npm run build
node scripts/verify-jev-input.mjs --live
```

The probe invokes the compiled application main and translation judgment functions against `https://api.typesafe.ai/v1/systemone`, model `jev-latest`. It uses the saved `.local/uimori.sqlite` JEV credential (or the existing environment fallback) without printing it. It does not read conversations, change application data, automatically retry calls, or store successful request/response bodies. The default report is `.local/jev-input-verification.json`; an optional positional path overrides it. A failed case makes the process exit with code 1.

The current implementation rejects the 500,000-token cases before transport with `JEV_INPUT_BUDGET`, so the default run makes only two baseline API calls and exits with code 1 for the unsupported maximum inputs. For the maximum main case alone, `--diagnostic-max-main` checks that preflight without a paid request and also exits with code 1. Inspect the reported error and zero attempt count to distinguish the expected budget rejection from another failure. When transport occurs, diagnostic mode captures the provider JSON error field from at most 8 KiB of response data. It never logs request headers or credentials:

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

## Recorded evidence and limits

On 2026-09-20, the full-response implementation sent a 16,000-estimated-token / 96,000-character synthetic candidate unchanged to both judgment paths. Each made one attempt with only `explicitRefusal`; the main and translation calls were accepted and the provider reported 16,396 and 16,327 input tokens respectively. The local report is `.local/jev-input-within-budget.json`.

The 500,000-token candidate had earlier received HTTP 400 with `detail.error_type = "max_tokens_exceeded"`. After adding the published-budget preflight, the same maximum-main input failed locally with `JEV_INPUT_BUDGET` and zero transport attempts, recorded in `.local/jev-input-preflight.json`. This establishes acceptance of the tested long input and rejection of the generation-setting maximum, not arbitrary maximum-length output support.

These dated observations do not establish current provider availability or refusal-classification quality. The standalone probe verifies transport and whole-input delivery; it does not create a persisted Run. Candidate preservation, failed-judgment handling and the role-specific disable switches are covered by application tests and described in the [generation contract](GENERATION.md#본문-응답-판정).
