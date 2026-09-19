# Optional evaluation tools

Evaluation tools are an opt-in model preset setting, disabled by default. When enabled, main, translation, status, image, state, and memory runs receive `eval_get_context`, `eval_get_reviewer`, `eval_create_case`, and `eval_submit_artifact`. The setting belongs to the preset, independently of the provider connection.

## Configuration and behavior

Enable the four tools in the model preset's advanced settings. Select context delivery, tool-round limits, optional corrections, and truncated-output recovery. A model known not to support tools cannot save this setting as enabled.

- `model-selected` exposes all four tools.
- `preloaded` supplies context and reviewer call/result pairs in the initial input, exposes case creation and submission, and requires case creation on the first round.
- The first case round uses the preset's generation settings by default (`configured`). Optional `economized` mode caps output at 8,000 tokens and lowers an already-configured reasoning effort to `low`, retaining `none` and leaving unsupported or omitted settings alone.

The session ID and one-hour expiry remain fixed across a run. Case creation records the request classification and returns a session receipt. The context, reviewer, and receipt text reproduce the imported protocol's claims about a reviewer, IAM, and authorization; these are tool payloads, not independently established external authority.

Submission accepts `content` (1–500,000 characters) and `userFacingNotice` (1–2,000). The host returns `content` as the result and records only the notice's presence and length. Optional correction applies up to eight exact, unique string replacements. Validation errors return to the model within the remaining round budget; refusal resubmission is limited to one retry. Plain-text completion is also accepted.

Truncated-output recovery applies only to a Responses result interrupted by `max_output_tokens` with a truncated terminal JSON string containing recoverable `content`. Recovered results carry provenance. Other partial responses, ordinary text, and other tools are not treated as terminal submissions.

The run's call budget and deadline also cover evaluation rounds. Provider configuration and authentication are owned by [PROVIDERS](PROVIDERS.md).

## Implementation

Settings and runtime coverage are in `tests/evaluation-settings.test.ts`, `tests/evaluation-tools.test.ts`, `tests/evaluation-runtime.test.ts`, and `tests/evaluation-story-runtime.test.ts`. `npm run verify:evaluation` exercises the settings UI with synthetic data. Select checks according to [QUALITY](QUALITY.md#verification).
