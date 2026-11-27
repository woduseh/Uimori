# Review rubric

A reviewer of a Uimori branch reads this file as written. A development session that asks a reviewer itself quotes it in full and adds only the purpose, the commit range and its gate results; it does not summarize its own change for the reviewer.

## Setup

- The reviewer comes from a different model family than the developer.
- The reviewer reads the branch itself (`git diff <base>..<head>`, the touched files and their callers) and does not edit files.
- Gate results in the brief are claims; the reviewer may rerun any check.

## Verdict

- `APPROVE`.
- `APPROVE_AFTER_FIXES`: one to three local fixes, each with a checklist line a reader can check mechanically. The developer applies them with regression tests; no re-review.
- `REQUEST_CHANGES`: a design, state or multi-file problem. A fresh reviewer re-reviews.

## What to look for

Earlier reviews found these classes in almost every unit:

- Stale-tab and revision order: another tab deleted or changed the target, and the endpoint answers something other than 409 `REVISION_CONFLICT`, or checks existence or validates the body before the revision. The stale-tab matrix test covers the registered endpoints; look at the rest.
- Callers outside HTTP: helper tools (`server/helper-*`), `server/resource-service.ts` and runners call the same functions without `registerEndpoint`'s parse.
- A specific user-facing hint lost to a generic fallback, raw `Error.message`/`String(error)` reaching the UI, or a message stored as translated text so it ignores a language switch.
- Paid generation that can run or repeat without the user's request, and authoring drafts or backup restore that a failure can lose.

## Proportion

- Report demonstrated defects first, ranked, each with file:line and a concrete input or state that leads to the wrong outcome. Keep pre-existing defects and maintenance risks in their own lists.
- Over-verification is a finding when the change adds it: defenses against version skew, other clients or deployments a one-person, same-build app cannot have (see `AGENTS.md` "Product intent"). Removing such a defense is intended.
- Style, naming and "could be more defensive" wishes are not findings. Bold root-cause ideas are welcome in a separate section.
