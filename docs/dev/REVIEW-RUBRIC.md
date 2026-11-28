# Review rubric

A reviewer of a Uimori branch reads this file as written. A development session that asks a reviewer itself quotes it in full and adds only the brief below; it does not summarize or justify its own change for the reviewer.

## Setup

- The reviewer comes from a different model family than the developer.
- The reviewer reads the branch itself (`git diff <base>..<head>`, the touched files and their callers) and does not edit files.
- Gate results in the brief are claims; the reviewer may rerun any check.

## Verdict

- `APPROVE`.
- `APPROVE_AFTER_FIXES`: one to three local fixes, each with a checklist line a reader can check mechanically. The developer applies them with regression tests; no re-review. If a fix turns out non-local or contested, stop and ask for a re-review or bring it to the user instead of skipping it.
- `REQUEST_CHANGES`: a design, state or multi-file problem. A fresh reviewer re-reviews.

## What to look for

Earlier reviews found these classes repeatedly:

- Stale-tab and revision order ([APP-INVARIANTS](APP-INVARIANTS.md#deletion-unused-data-reclamation-and-helper-cleanup)): a write on a deleted or stale target answers 409 `REVISION_CONFLICT` before existence or body checks and a read or selecting write answers `LIBRARY_ITEM_DELETED`, and `tests/stale-tab/` enforces that for contract endpoints. Check unconverted routes, and whether new matrix cases or exemptions probe invalid bodies and real targets.
- Trust boundaries outside HTTP: helper tools (`server/helper-*`) and runners parse model or external arguments with `parseInput` at the entry before reading fields and refuse unknown keys; services trust their typed input. Check that non-HTTP callers pass matching shapes and keep what the route adds (`Cache-Control: no-store` on refusals via `onSend`, maintenance and access gates, invalidation).
- Async and cross-tab UI races: a late response overwriting newer input, a dialog acting on stale props instead of the target it opened for, a missing cross-tab refresh, a newly created item called deleted before the list has shown it.
- User-facing errors and i18n: a specific hint lost to a generic fallback, raw `Error.message`/`String(error)` reaching the UI, a message stored as translated text so it ignores a language switch.
- Protected user data: paid generation that can run or repeat without the user's request, and authoring drafts or backup restore that a failure can lose.
- False-green or weakened tests ([CHECKS](CHECKS.md#which-tests-to-keep)): a regression test that passes with the bug present (valid input on a validation-order check, a mocked-out boundary), or a deleted browser case without another one mounting the same component.

## Proportion

- Report demonstrated defects first, ranked, each with `file:line` and a concrete input or state that leads to the wrong outcome. Keep pre-existing defects and maintenance risks in their own lists.
- Over-verification is a finding when the change adds it: defenses against version skew, other clients or deployments a one-person, same-build app cannot have (see [AGENTS.md](../../AGENTS.md#product-intent)). Removing such a defense is intended.
- Style, naming and "could be more defensive" wishes are not findings. With `APPROVE` or `APPROVE_AFTER_FIXES`, name any unverified edge or UI state the user should look at. Bold root-cause ideas are welcome in a separate section.
- When a class here shows up in two more reviews, turn it into a mechanical check and drop its line from this file.

## Brief

- Purpose: what the unit is for, in one or two sentences.
- Range: branch, `<base>..<head>`.
- Gates: each command and its result.
- User decisions: choices the user made that the reviewer should not reopen.
