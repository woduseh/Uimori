# Uimori

Uimori is a single-user, self-hosted creative-writing app. Favor simple, maintainable solutions, long-form reading usability, and preservation of user data.

## Boundaries

These are not defaults, and nothing below overrides them.

- Saved text, text the user is typing, credentials and access boundaries survive a change, a failure and a migration.
- Commit finished, verified work locally. Branches, pushes and pull requests need no go-ahead once the checks the change needs have passed. A red `main` is acceptable in this one-person project and is fixed forward.
- A new dependency or a schema migration is the agent's decision when it earns its place. A migration opens an existing database without losing data and comes with a test from the previous schema on real-shaped data, including backup restore.
- A release (a version change, a tag, new release notes, the Oracle release scripts) is the user's alone: an agent never starts one, even with a go-ahead. The PreToolUse hook in `.claude/settings.json` and `.githooks/pre-push` refuse these steps unless the user set `UIMORI_ALLOW_RELEASE=1` for the session or the push. Do not bypass or weaken them.
- Get the user's go-ahead before a deployment, a message to anyone outside this repository, or a change under `.claude/`. A disagreement between agents goes to the user.

## Product intent

- A constraint on what the helper, a tool or a model runtime may do stays only if it protects something concrete of the user's: saved data, text being typed, paid generation, credentials. Prefer a recoverable outcome (execute, or return a correction and continue) over failing a run, and prefer changing a contract document over adding a refusal for its sake.
- A test earns its place by what it protects; [CHECKS](docs/dev/CHECKS.md#which-tests-to-keep) lists what to keep and what to delete.
- The app feels like one app through shared tokens and controls. How a screen looks and feels is the user's call: in a report, name the screens and states they should look at themself.

## Defaults

The rest of this file and the documents it links are defaults. When following one would make the result worse, take the better path and say in the report which default you left and why.

- Justify new infrastructure against this single-user, self-hosted app's actual needs.
- Keep provider and storage details out of unrelated application policies and UI code.
- For asynchronous provider and storage operations, account for cancellation, late responses, duplicate effects, and unknown outcomes.
- Choose verification with [CHECKS](docs/dev/CHECKS.md).

## Delegation

When a piece of work goes to another worker:

- Scope each brief to one deliverable: a few files and one verification. The worker returns when it is done, and the next deliverable goes to a fresh worker rather than a longer brief, because every turn rereads the worker's whole context.
- Give each worker the outcome, ownership boundaries, and expected verification. Put the relevant facts and section anchors in the brief instead of asking it to read whole reference documents; workers already receive this file.
- Ask workers to batch independent reads, searches and edits in one message, to start verification with `npm run check:changed`, and to leave full suites to integration.
- Ask for a fixed return: changed files, checks run with their results, and open issues.
- The coordinating agent owns cross-cutting decisions, integration, and final acceptance. Continue non-overlapping work while workers run. Inspect their changes and evidence, reuse checks that still apply, and verify integration where needed.

## References

Read only the references needed for the task:

- [README](README.md) and [README.ko](README.ko.md): product overview and usage in English and Korean. When changing one, update the other to match.
- [CODE-MAP](docs/dev/CODE-MAP.md): feature contracts, entry points, and owning user/dev documents.
- [UI-PRINCIPLES](docs/dev/UI-PRINCIPLES.md): read before changing app-owned UI, layout, motion, visible copy, or loading/error/empty states. Start with its working checklist.
- [THEME-AUTHORING](docs/THEME-AUTHORING.md): read when creating or changing themes and their public styling contract.
- [CHECKS](docs/dev/CHECKS.md): which checks a change needs.
- [UIMORI-VERIFY](.agents/skills/uimori-verify/SKILL.md): the order and judgment calls of a browser verification run.
- [DEVELOPMENT](docs/dev/DEVELOPMENT.md): setup, verification runners, commands, and troubleshooting.
- [ORACLE-RELEASE](docs/dev/ORACLE-RELEASE.md): read when preparing or performing an authorized Oracle deployment.

Update the owning document when behavior changes. Keep plans and execution history out of standing instructions.

User guides live directly under `docs/*.md`, are packaged into `dist/docs` for the helper's `guide.read`, and describe app behavior only for users and the runtime helper—keep internal source paths, test listings, and `구현 참고` sections out of them. Agent-facing documents under `docs/dev/` (including [TOOL-CONTRACTS](docs/dev/TOOL-CONTRACTS.md), [HELPER-TOOLS](docs/dev/HELPER-TOOLS.md), [RISU-COMPAT](docs/dev/RISU-COMPAT.md), [PROVIDERS-AND-CODEX](docs/dev/PROVIDERS-AND-CODEX.md), and [APP-INVARIANTS](docs/dev/APP-INVARIANTS.md)) name the function or constant a constraint is about. Entry files per feature live in CODE-MAP and are not repeated. Name a test only when it is the evidence that lets the document leave a behavior out, or when it cannot be found from the source file's name, such as a cross-cutting regression test or a browser spec case ID. In source code, omit comments except for the rare external-system constraints enforced by `scripts/check-comments.mjs`.
