# Uimori

Uimori is a single-user, self-hosted creative-writing app. Favor simple, maintainable solutions, long-form reading usability, and preservation of user data.

Carry implementation requests through to a working result, appropriate verification, and local commits within the authorized scope. Make routine decisions independently and use approvals that apply to the current task. Ask only when missing input or authorization materially changes the outcome; continue independent work meanwhile.

## Design judgment

Optimize for correct behavior, local reasoning, and low maintenance and operating costs, not pattern adoption, layer counts, or fewer lines of code.

- Start with the requested behavior, its current owner, and the invariants to preserve. Trace the relevant execution path and expand the investigation only as dependencies or risks warrant.
- Choose the smallest cohesive change that solves the problem. Prefer a simple local solution over speculative infrastructure, but do not preserve a brittle workaround just to minimize the diff. Keep unrelated redesigns out of scope.
- Keep rules that change together close to each other and make state ownership explicit. Separate independently changing concerns; share domain knowledge, not merely similar-looking syntax.
- Introduce or retain abstractions when they hide meaningful implementation details, protect an important boundary, or isolate an existing variation. Do not add forwarding layers, extension points, or design patterns without a concrete current benefit.
- Keep calculations separable from I/O where useful and make side effects explicit. Keep provider and storage details from leaking into unrelated application policies or UI code.
- Use types and data structures to express valid states and establish invariants at their owning boundaries. Avoid redundant internal validation when those invariants are preserved; retain necessary input validation, storage consistency checks, and safeguards.
- For asynchronous or external operations, examine allowed transitions, cancellation, late responses, duplicate effects, and partial completion. Retry only when duplicate effects are safe or prevented; preserve unknown outcomes and actionable errors instead of hiding failures behind defaults or silent fallbacks.
- Ground performance work in the relevant workload, cost model, and evidence; label unmeasured claims as hypotheses. Add caching, parallelism, or infrastructure only when the benefit justifies the added complexity and operating cost.
- Remove code and documentation made obsolete by the change after checking indirect uses and supported contracts. Remove tests only after checking what protection remains. Simplification must preserve user data, credentials, and necessary access boundaries.

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
- [ENGINEERING-REVIEW](.agents/skills/engineering-review/SKILL.md): read for architecture or module-boundary reviews, refactoring plans, and maintainability or slop audits; not routine edits.
- [UIMORI-MOTION](.agents/skills/uimori-motion/SKILL.md): read when implementing or reviewing motion in app-owned UI controls.

Update the owning document when behavior changes. Keep plans and execution history out of standing instructions.
