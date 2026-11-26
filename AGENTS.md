# Uimori

Uimori is a single-user, self-hosted creative-writing app. Favor simple, maintainable solutions, long-form reading usability, and preservation of user data.

Carry an implementation request through to a working result, verification that fits the change, and a local commit. Make routine, reversible decisions yourself, state the assumptions behind them, and keep going. Ask only when missing input or authorization would materially change the outcome, and continue independent work while you wait.

Commit finished, verified work locally without asking. Get the user's go-ahead before a push, a pull request, a release, or a deployment. Do not ask again for a go-ahead the user already gave for the same action.

## Design judgment

Optimize for correct behavior, local reasoning, and low maintenance and operating costs. Let the cause of a problem decide the size of the change: fix it where it originates and update the affected callers, even when that takes a refactor. Reuse the logic the codebase already has, and in the area you change, consolidate duplicated code and fix related problems instead of adding a parallel path. Preserve the behavior that callers and stored user data rely on. Justify new infrastructure against this single-user, self-hosted app's actual needs.

Keep business rules and state ownership clear. Keep provider and storage details out of unrelated application policies and UI code. For asynchronous provider and storage operations, account for cancellation, late responses, duplicate effects, and unknown outcomes; preserve user data, credentials, and necessary access boundaries.

Use [CHECKS](docs/dev/CHECKS.md) to choose verification rather than duplicating its procedures here. In the report, explain material design decisions and tradeoffs, name any change beyond the request, and distinguish verified behavior from remaining uncertainty.

## Delegation

Work directly by default. Delegate only a substantial piece that can proceed without editing files that another worker or the coordinator touches, when the parallel speed or the independent check is worth the cost of briefing a worker and verifying its result. Small steps and steps that share files stay with the coordinator.

- Scope each brief to one deliverable: a few files and one verification. The worker returns when it is done, and the next deliverable goes to a fresh worker rather than a longer brief, because every turn rereads the worker's whole context.
- Give each worker the outcome, ownership boundaries, and expected verification. Put the relevant facts and section anchors in the brief instead of asking it to read whole reference documents; workers already receive this file.
- Ask workers to batch independent reads, searches and edits in one message, to start verification with `npm run check:changed`, and to leave full suites to integration.
- Ask for a fixed return: changed files, checks run with their results, and open issues.
- The coordinating agent owns cross-cutting decisions, integration, and final acceptance. Continue non-overlapping work while workers run. Inspect their changes and evidence, reuse checks that still apply, and verify integration where needed.

## References

Read only the references needed for the task:

- [README](README.md) and [README.ko](README.ko.md): product overview and usage in English and Korean. When changing one, update the other to match.
- [CODE-MAP](docs/dev/CODE-MAP.md): feature contracts, entry points, and owning user/dev documents.
- [UI-PRINCIPLES](docs/dev/UI-PRINCIPLES.md): read before changing app-owned UI, layout, visible copy, or loading/error/empty states. Start with its working checklist.
- [THEME-AUTHORING](docs/THEME-AUTHORING.md): read when creating or changing themes and their public styling contract.
- [CHECKS](docs/dev/CHECKS.md): which checks a change needs.
- [DEVELOPMENT](docs/dev/DEVELOPMENT.md): setup, verification runners, commands, and troubleshooting.
- [ORACLE-RELEASE](docs/dev/ORACLE-RELEASE.md): read when preparing or performing an authorized Oracle deployment.
- [UIMORI-MOTION](.agents/skills/uimori-motion/SKILL.md): read when implementing or reviewing motion in app-owned UI controls.

Update the owning document when behavior changes. Keep plans and execution history out of standing instructions.

Documents record what the code cannot state. User guides live directly under `docs/*.md`, are packaged into `dist/docs` for the helper's `guide.read`, and describe app behavior only for users and the runtime helper—keep internal source paths, test listings, and `구현 참고` sections out of them. Agent-facing documents under `docs/dev/` (including [TOOL-CONTRACTS](docs/dev/TOOL-CONTRACTS.md), [HELPER-TOOLS](docs/dev/HELPER-TOOLS.md), [RISU-COMPAT](docs/dev/RISU-COMPAT.md), [PROVIDERS-AND-CODEX](docs/dev/PROVIDERS-AND-CODEX.md), and [APP-INVARIANTS](docs/dev/APP-INVARIANTS.md)) name the function or constant a constraint is about. Entry files per feature live in CODE-MAP and are not repeated. Name a test only when it is the evidence that lets the document leave a behavior out, or when it cannot be found from the source file's name, such as a cross-cutting regression test or a browser spec case ID. Keep only what code and tests cannot state: reasons, production measurements, external constraints, ownership invariants, boundaries between features, and deliberate omissions; do not restate tool descriptions, schemas, limits, endpoint tables, or tested behavior. Remove a statement as duplicated only after finding the code, description, schema field, or test that carries it, and correct a document that contradicts the code. In source code, omit comments except for the rare external-system constraints enforced by `scripts/check-comments.mjs`.
