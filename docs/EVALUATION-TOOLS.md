# Optional evaluation tools

Evaluation tools are an opt-in model preset setting, disabled by default. Main, translation, and status runs use the selected evaluation mode. The setting belongs to the preset, independently of the provider connection.

## Configuration and behavior

Enable evaluation tools in the model preset's advanced settings. Select context delivery, tool-round limits, optional corrections, and output recovery. A model known not to support tools cannot save this setting as enabled. Existing presets and new defaults remain `model-selected`.

- `model-selected` exposes all four tools.
- `preloaded` supplies context and reviewer call/result pairs in the initial input, exposes case creation and submission, and requires case creation on the first round.
- `source-bound` (원본 기반 직접 작성) skips evaluation context, reviewer, and case creation. The writer receives the original source and the existing writing settings, with `eval_submit_artifact` as the only evaluation tool. Normal resource reads and consultation remain available where supported by the run. Successful completion requires a valid artifact submission; plain text does not satisfy this mode.
- In `preloaded`, the first case round uses the preset's generation settings by default (`configured`). Optional `economized` mode caps output at 8,000 tokens and lowers an already-configured reasoning effort to `low`, retaining `none` and leaving unsupported or omitted settings alone. This control is hidden and has no effect in other modes; switching modes preserves the saved value.

The session ID and one-hour expiry remain fixed across a run. Case creation records the request classification and returns a session receipt. The context, reviewer, and receipt text reproduce the imported protocol's claims about a reviewer, IAM, and authorization; these are tool payloads, not independently established external authority.

Main runs derive the session from the reserved Run ID and execution time, and case/receipt IDs from that session and tool-call ID. Batch recovery therefore reconstructs the same bootstrap and recorded results. Submitted Batch requests retain their frozen evaluation options, even if the preset's mode is later changed. Finish older batches created with random session identities before updating; see [Execution recovery](EXECUTION.md#복구-가능한-anthropic-batch-run).

In `model-selected` and `preloaded`, submission requires `content` (1–2,000,000 characters) and `userFacingNotice` (1–67,108,864). The host returns `content` as the result and records only the notice's presence and length. These modes also accept plain-text completion.

In `source-bound`, submission requires only `content` (1–2,000,000 characters). `internalProcessingNote` is optional (0–67,108,864 characters), for internal self-checking or correction planning. The host records only its presence and length, without retaining the note text in tool receipts or attempt diagnostics. Submit the artifact alone, without other tool calls in the same response. The host returns the submitted content as the result. Translation and status submissions continue through their existing output validation before being accepted.

Optional correction applies up to eight exact, unique string replacements. Validation errors return to the model within the remaining round budget; refusal resubmission is limited to one retry. Missing submission in `source-bound` fails rather than silently accepting plain text or automatically replaying the writer.

Truncated-output recovery applies only to a Responses result interrupted by `max_output_tokens` with a truncated terminal JSON string containing recoverable `content`. Recovered results carry provenance. Other partial responses, ordinary text, and other tools are not treated as terminal submissions.

The run's call budget and deadline also cover evaluation rounds. Provider configuration and authentication are owned by [PROVIDERS](PROVIDERS.md).

## Implementation

Settings and runtime coverage are in `tests/evaluation-settings.test.ts`, `tests/evaluation-tools.test.ts`, and `tests/evaluation-runtime.test.ts`. `npm run verify:evaluation` exercises the settings UI with synthetic data. Select checks according to [DEVELOPMENT](DEVELOPMENT.md#verification).

## Codex main native turns

Real main Codex Runs keep evaluation definitions, bootstrap and artifact processing in native tool callbacks. `source-bound` starts the native writer directly and requires terminal artifact submission. `preloaded` with `economized` keeps its first low-effort request in the old transport, then starts the native writer with the configured effort and completed results. The session and prior effects are not recreated. For native main turns, `maximumToolRounds` bounds nonterminal Uimori tool exchanges (and unsuccessful submissions), not hidden model samples; valid terminal submission is accepted separately. HTTP providers keep their existing round semantics and enforce the same `source-bound` submission requirement. Helper-generated hypothetical scenes and translation retain the prior transport. See [Codex](CODEX.md#본문과-조언의-native-실행) for final submission, usage and cancellation boundaries.
