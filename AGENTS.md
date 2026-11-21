# Uimori

Uimori is a single-user, self-hosted creative-writing app. Favor simple, maintainable solutions, long-form reading usability, and preservation of user data.

Carry an implementation request through to a working result, verification that fits the change, and a local commit. Make routine, reversible decisions yourself, state the assumptions behind them, and keep going. Ask only when missing input or authorization would materially change the outcome, and continue independent work while you wait.

Commit finished, verified work locally without asking. Other agent sessions may share this checkout, so commit only the files you changed, naming their paths, and leave other staged or unstaged changes as they are. Get the user's go-ahead before a push, a pull request, a release, or a deployment. Do not ask again for a go-ahead the user already gave for the same action.

## Design judgment

Optimize for correct behavior, local reasoning, and low maintenance and operating costs. Choose the smallest cohesive change that solves the requested problem at its cause. Reuse the logic the codebase already has, and where the change touches duplicated code, consolidate it instead of adding a parallel path. Preserve the behavior that callers and stored user data rely on. Justify new infrastructure against this single-user, self-hosted app's actual needs.

Keep business rules and state ownership clear. Keep provider and storage details out of unrelated application policies and UI code. For asynchronous provider and storage operations, account for cancellation, late responses, duplicate effects, and unknown outcomes; preserve user data, credentials, and necessary access boundaries.

Use [DEVELOPMENT](docs/DEVELOPMENT.md) to choose verification rather than duplicating its procedures here. In the report, explain material design decisions and tradeoffs, name any change beyond the request, and distinguish verified behavior from remaining uncertainty.

## Delegation

Work directly by default. Delegate when the work splits into substantial pieces that can proceed independently without editing the same files, and the parallel speed or the independent check is worth the cost of briefing a worker and verifying its result.

- Give each worker a clear outcome, relevant context, ownership boundaries, and expected verification.
- The coordinating agent owns cross-cutting decisions, integration, and final acceptance. Continue non-overlapping work while workers run. Inspect their changes and evidence, reuse checks that still apply, and verify integration where needed.

## References

Read only the references needed for the task:

- [README](README.md) and [README.ko](README.ko.md): product overview and usage in English and Korean. When changing one, update the other to match.
- [CODE-MAP](docs/CODE-MAP.md): feature contracts and entry points.
- [UI-PRINCIPLES](docs/UI-PRINCIPLES.md): read before changing app-owned UI, layout, visible copy, or loading/error/empty states. Start with its working checklist.
- [THEME-AUTHORING](docs/THEME-AUTHORING.md): read when creating or changing themes and their public styling contract.
- [DEVELOPMENT](docs/DEVELOPMENT.md): setup, check selection, commands, and troubleshooting.
- [ORACLE-RELEASE](docs/ORACLE-RELEASE.md): read when preparing or performing an authorized Oracle deployment.
- [UIMORI-MOTION](.agents/skills/uimori-motion/SKILL.md): read when implementing or reviewing motion in app-owned UI controls.

Update the owning document when behavior changes. Keep plans and execution history out of standing instructions.
