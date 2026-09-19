# Acceptance evidence

[ACCEPTANCE.json](ACCEPTANCE.json) describes milestone requirements and includes historical annotations; it is not current execution evidence. [CURRENT](CURRENT.md) links implemented contracts and recorded results. [BETA-PLAN](BETA-PLAN.md) owns current beta scope and progress.

Use [QUALITY](../docs/QUALITY.md#verification) to select checks and [DEVELOPMENT](../docs/DEVELOPMENT.md) to run them. This document explains what different evidence can establish.

| Evidence | Supported claim |
| --- | --- |
| Scripted mock provider | Application behavior with controlled outputs, such as storage, scheduling, cancellation, and tool handling |
| Loopback fake provider | HTTP/SSE transport, decoding, and adapter behavior for the exercised responses |
| Live provider smoke | Actual round trips through the tested endpoint, model, and adapter version |
| Model quality evaluation | Meaning, factual consistency, translation, or writing quality on the evaluated samples and conditions |
| Browser, native OS, or physical device run | Behavior in the environment actually exercised; browser emulation alone does not establish physical-device behavior |

Match each completion claim to the tested source, inputs, environment, result, and remaining gaps. A local pass does not establish live service compatibility or model quality. A successful request does not establish literary quality, and automated judging does not settle user preference.

Link the relevant reports instead of duplicating result ledgers. Distinguish failures, blocked checks, and unrun work from passing evidence. Historical results remain useful within their original scope; a specification, implementation, or test count alone does not show that an acceptance condition has been met.
