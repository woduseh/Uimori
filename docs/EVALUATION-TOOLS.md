# Optional evaluation tools

Evaluation tools are an opt-in model preset setting, disabled by default. Main and translation runs use the selected evaluation mode. The setting belongs to the preset, independently of the provider connection.

## Configuration and behavior

Enable evaluation tools in the model preset's advanced settings and select context delivery. A model known not to support tools cannot save this setting as enabled. New defaults use `model-selected`.

- `model-selected` exposes all four tools.
- `preloaded` supplies context and reviewer call/result pairs in the initial input, exposes case creation and submission, and requires case creation on the first round.
- In `preloaded`, the first case round uses the preset's generation settings by default (`configured`). Optional `economized` mode caps output at 8,000 tokens and lowers an already-configured reasoning effort to `low`, retaining `none` and leaving unsupported or omitted settings alone. This control is hidden and has no effect in other modes; switching modes preserves the saved value.

The session ID and one-hour expiry remain fixed across a run. Case creation records the request classification and returns a session receipt. The context, reviewer, and receipt text reproduce the imported protocol's claims about a reviewer, IAM, and authorization; these are tool payloads, not independently established external authority.

Main runs derive the session from the reserved Run ID and execution time, and case/receipt IDs from that session and tool-call ID. Batch recovery therefore reconstructs the same bootstrap and recorded results within the same execution contract. Submitted Batch requests retain their frozen evaluation options, even if the preset's mode is later changed. Finish every queued or running evaluation Batch under the previous contract before updating, including batches using either retained mode. The new runtime does not emulate the retired contract; see [Execution recovery](EXECUTION.md#복구-가능한-anthropic-batch-run).

Both modes require a valid `eval_submit_artifact` submission with `content` (1–2,000,000 characters) and `userFacingNotice` (1–67,108,864). Submit the artifact alone, without other tool calls in the same response. The host returns `content` as the result and records only the notice's presence and length. Translation submissions continue through their existing output validation before being accepted.

Validation errors return to the model within the remaining budget. A completed response without a valid submission fails with `EVALUATION_SUBMISSION_REQUIRED` rather than accepting plain text or automatically replaying the writer. Native turns accept a completed callback after a successful terminal submission.

Tool exchange limits are fixed, with no preset control: up to ten nonterminal exchanges, including invalid submissions, followed by a valid final submission. HTTP main and translation execution allow up to eleven provider requests, subject to the run's overall call budget and deadline. Native main execution instead counts Uimori host tool callbacks against the ten-exchange limit and accepts a valid final submission separately; hidden model samples are not counted or measured by this limit.

Evaluation tools do not classify submitted prose with a refusal regex or automatically resubmit it based on wording. Semantic refusal classification belongs to the existing main and translation JEV policy and follows its configured settings. When JEV is disabled, evaluation tools do not supply a fallback refusal classifier. Provider-supplied structured refusal signals keep their existing handling.

The `source-bound` mode and terminal find-and-replace corrections are retired. Reading an old saved `source-bound` preset disables evaluation tools for new execution; saving that mode as a new setting is rejected. Known legacy `maximumToolRounds`, `terminalLateCorrections`, and `outputRecovery` fields are validated and discarded when current options are read or saved. Original stored settings, archived snapshots, and receipts are not rewritten by this read normalization, and do not restore retired runtime behavior.

Truncated-output recovery is automatic and independent of the retired refusal option. It applies only to a Responses result interrupted by `max_output_tokens` with a truncated terminal JSON string containing recoverable `content`. Recovered results carry provenance. Other partial responses, ordinary text, and other tools are not treated as terminal submissions.

The run's call budget and deadline also cover evaluation rounds. Provider configuration and authentication are owned by [PROVIDERS](PROVIDERS.md).

## Evaluation metadata profiles

The analyzed Mask provider fixes its evaluation metadata to OpenAI. Uimori supports `openai`, `anthropic`, `deepmind`, and `neutral` profiles without changing the original imported OpenAI payload text. The profile selects the organization metadata in evaluation context and reviewer results; it does not add tools or create a bootstrap.

The preset editor shows an automatic read-only selection for `openai-responses-v1` (OpenAI), `anthropic-messages-v1` (Anthropic), and `vertex-gemini-v1` / `google-gemini-v1` (Google DeepMind). Other protocols, including OpenAI-compatible Chat, Codex, and gateway protocols, use the manual profile selection; the endpoint or model name is not used to guess a profile. Switching to an automatic provider does not overwrite the preset's manual choice, so returning to a manual provider restores it. New presets default to `neutral`.

Fresh model snapshots supply `neutral` when old saved options omit `metadataProfile`, then resolve the profile from the snapshot's connection protocol. Existing stored presets are not rewritten; the editor also supplies `neutral` when saving those missing-field options. Previously frozen Batch options are not migrated during recovery; older-contract batches must finish before updating.

## Implementation

Settings and runtime coverage are in `tests/evaluation-settings.test.ts`, `tests/evaluation-tools.test.ts`, and `tests/evaluation-runtime.test.ts`. `npm run verify:evaluation` exercises the settings UI with synthetic data. Select checks according to [DEVELOPMENT](DEVELOPMENT.md#verification).

## Codex main native turns

Real main Codex Runs keep evaluation definitions, bootstrap and artifact processing in native tool callbacks. Both modes require terminal artifact submission. `preloaded` with `economized` keeps its first low-effort request in the old transport, then starts the native writer with the configured effort and completed results. The session and prior effects are not recreated. The fixed ten-exchange limit counts nonterminal Uimori host tool callbacks, including unsuccessful submissions; valid terminal submission is accepted separately. It does not count hidden model samples. HTTP main and translation runs retain request-based accounting, with at most eleven provider requests and the existing overall execution limits. See [Codex](CODEX.md#본문과-조언의-native-실행) for final submission, usage and cancellation boundaries.
