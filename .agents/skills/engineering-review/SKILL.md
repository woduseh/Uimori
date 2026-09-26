---
name: engineering-review
description: Review Uimori architecture, module boundaries, refactoring plans, or maintainability and slop audits. Use for 구조 검토, 설계 리뷰, 리팩터링 검토, or requests to reduce structural complexity. Not for routine bug fixes, copy/style edits, general code explanations, UI motion polish, or runtime model prompts unless a structural review is explicitly requested.
---
# Engineering review

Reduce the cost of understanding, changing, and operating correct software. Review actual behavior and dependencies, not conformity to a pattern catalog. Keeping the current design is a valid outcome.

## Scope and working mode

Follow the current task and [AGENTS.md](../../../AGENTS.md) for authorization, autonomy, and delegation; this skill adds no approval checkpoint. For review-only requests, inspect and report without editing project files. When implementation is requested, carry the authorized changes through verification and completion rather than stopping at recommendations. Do not infer permission to merge, push, deploy, or operate on live data from a review request.

Preserve behavior unless the task authorizes changing it. Uimori is a single-user, self-hosted creative-writing app: weigh abstractions and infrastructure against actual maintenance and operating costs. Personal use is not a reason to weaken data preservation, credential handling, or necessary access boundaries.

## Find the relevant evidence

1. Identify the requested target: a change, module, feature, or repository-wide audit. Establish the current revision and relevant working-tree changes. Resolve routine details from the repository; ask only for missing information that materially changes the outcome.
2. If the owner is unclear, use [CODE-MAP](../../../docs/CODE-MAP.md) to find entry points and read the relevant feature contract. Reuse context already read; do not load every document or scan the whole repository for a local change.
3. Trace the affected path from callers through policy/calculation, state ownership, external effects, and consumers. Inspect the code and applicable tests, not just filenames. Before declaring code dead, check registrations, indirect calls, imports, and supported external contracts.
4. Expand along observed dependencies and plausible failure paths. For a repository-wide request, map the major areas and inspect representative paths in each before narrowing deeper work; report uninspected areas rather than implying exhaustive coverage.

## Select the lenses that matter

Use the relevant rows, not a mandatory all-items checklist. Name concrete failure or maintenance costs rather than simply declaring a SOLID violation.

| Lens | Questions and decision criteria |
| --- | --- |
| Ownership, cohesion, and locality | Which rules change together, and who owns their state? Keep related rules near each other; separate independently changing concerns. Look for scattered policy, hidden global dependencies, and cycles that obstruct local reasoning. Many callers alone do not make a stable shared utility a problem. |
| Information hiding and abstraction | What implementation decision does a boundary hide? Prefer a direct function or module when sufficient. Add or retain an adapter, strategy, interface, or shared owner when it isolates a real variation or important boundary. One implementation can still justify a boundary; repeated syntax alone does not justify merging different rules. |
| Data and invariants | What must remain true before and after a change? Identify the authoritative representation and prevent contradictory states with suitable types, constructors, and storage constraints. Distinguish persisted facts from derived views; review migration and atomicity when stored data changes. A status enum alone does not enforce valid transitions or required results. |
| Effects, state, and concurrency | Keep calculations separable from I/O where useful. Identify allowed transitions and the owner of each write. For asynchronous paths, examine cancellation, late responses, duplicate submissions, ordering, and partial completion. Do not add automatic retries without establishing safety for duplicate effects; a timeout can leave the external outcome unknown. |
| Errors and observability | Distinguish expected absence, rejected input, operational failure, and unknown outcome. Preserve actionable diagnostics without exposing secrets or unnecessary manuscript content. Do not disguise failures as success with empty defaults or silent fallbacks; avoid duplicate logging at every layer. |
| Performance and resource cost | Identify the relevant workload and cost: algorithmic growth, I/O round trips, repeated serialization, model calls/tokens, allocations, or UI updates. Measure the suspected bottleneck or label the claim as a hypothesis. Add caching, batching, parallelism, or queues only with justified benefit and clear invalidation, ordering, or capacity semantics. |
| Verification and maintenance | Which observable behavior would distinguish a correct change from a plausible mistake? Reuse checks at the affected boundary. Prefer assertions about outcomes and invariants over incidental implementation shape. Remove tests only after identifying obsolete behavior or redundant coverage and checking what protection remains. |

## Choose the smallest coherent improvement

- Explain the current problem with a file/symbol reference and a concrete consequence. Separate demonstrated defects, maintenance risks, and unmeasured hypotheses. Prioritize by impact and likelihood; do not manufacture findings to fill a quota.
- Consider leaving the code as-is and the simplest local repair before proposing a larger abstraction or reorganization. Discuss alternatives only when their tradeoffs materially affect the choice. Prefer the smallest cohesive fix, not the fewest changed lines or a repository-wide rewrite.
- Keep shared business knowledge under one owner, but allow similar-looking code to remain separate when it represents different rules. Avoid forwarding layers, factories, event buses, frameworks, and compatibility scaffolding that add no current value. Do not prescribe a folder topology or pattern by default.
- Check what a proposed deletion or simplification protects. Remove redundant internal validation only when the relevant invariant is established and preserved; retain checks at untrusted input, persistence, and external-effect boundaries where needed. Do not delete recovery paths or compatibility behavior merely because a search or one test did not exercise them.
- Keep changes within the agreed concern. Clean up code, tests, and the owning documentation made obsolete by that change; report independent improvements separately. Do not silently modify vendored snapshots or add a second source of truth for contracts, code maps, or verification commands.

## Verify and finish

Use [DEVELOPMENT](../../../docs/DEVELOPMENT.md) as the source of truth for check selection, commands, evidence reuse, and completion. Choose checks from the affected behavior and plausible failures, not from a desire to run every suite. Reuse still-applicable results; rerun affected checks after subsequent changes or new evidence of risk.

For a behavior-preserving refactor, compare meaningful outputs and side effects, not only type-check success. For a performance claim, compare equivalent workloads and correctness before and after; do not present a synthetic fixture as live-provider or production proof. If a check is blocked, report what ran and what remains unverified, and complete independent work. Do not claim a pass or weaken checks to obtain one.

Report the scope and meaningful findings or completed changes, with file/symbol locations, the consequence, the selected remedy and important tradeoffs. Include actual verification and remaining uncertainty. Keep the report proportional to the task; no mandatory scorecard, diagram, finding count, or new report file. If no worthwhile change is supported, say so and finish.
