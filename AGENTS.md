# Uimori

Uimori is a single-user, self-hosted creative-writing app. Favor simple, maintainable solutions, long-form reading usability, and preservation of user data.

Carry implementation requests through to a working result, appropriate verification, and local commits within the authorized scope. Make routine decisions independently and use approvals that apply to the current task. Ask only when missing input or authorization materially changes the outcome; continue independent work meanwhile.

## Design judgment

Optimize for correct behavior, local reasoning, and low maintenance and operating costs. Choose the smallest cohesive change that solves the requested problem, and justify new infrastructure against this single-user, self-hosted app's actual needs.

Keep business rules and state ownership clear. Keep provider and storage details out of unrelated application policies and UI code. For asynchronous provider and storage operations, account for cancellation, late responses, duplicate effects, and unknown outcomes; preserve user data, credentials, and necessary access boundaries.

Use [DEVELOPMENT](docs/DEVELOPMENT.md) for verification rather than duplicating its procedures here. Briefly explain material design decisions and tradeoffs, and distinguish verified behavior from remaining uncertainty.

## Delegation

- When collaboration tools are available, proactively delegate substantial, clearly scoped work that can proceed independently and improve speed or quality. Handle small or tightly coupled work directly.
- Give each worker a clear outcome, relevant context, ownership boundaries, and expected verification. Avoid overlapping concurrent edits.
- The coordinating agent owns cross-cutting decisions, integration, and final acceptance. Continue non-overlapping work while workers run. Inspect their changes and evidence, reuse checks that still apply, and verify integration where needed.

## References

Read only the references needed for the task:

- [README](README.md): product overview and usage.
- [CODE-MAP](docs/CODE-MAP.md): feature contracts and entry points.
- [THEME-AUTHORING](docs/THEME-AUTHORING.md): read when creating or changing themes and their public styling contract.
- [DEVELOPMENT](docs/DEVELOPMENT.md): setup, check selection, commands, and troubleshooting.
- [ORACLE-RELEASE](docs/ORACLE-RELEASE.md): read when preparing or performing an authorized Oracle deployment.
- [UIMORI-MOTION](.agents/skills/uimori-motion/SKILL.md): read when implementing or reviewing motion in app-owned UI controls.

Update the owning document when behavior changes. Keep plans and execution history out of standing instructions.
