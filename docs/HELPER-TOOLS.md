# 도우미 도구

Uimori의 도우미는 대화와 서재에서 창작과 설정을 보조하는 에이전트예요. 사용자의 질문에 답하는 것에 그치지 않고, 내부 앱 도구와 격리된 데이터 작업 공간을 활용해 필요한 자료를 부분 조회·검색하고, 장면이나 설정을 수정할 수 있어요.

## 도우미가 할 수 있는 일

- **원고와 서재 자료 부분 조회·검색**: 봇·페르소나·모듈·프롬프트 프리셋의 전체 본문을 무리하게 불러오지 않고 필요한 필드와 구간만 검색하고 읽어요(`data.search`, `data.read`). 개요 트리(`outline.read`)와 지식 베이스(`knowledge.search`)도 페이지 단위로 나누어 조회해요.
- **읽기 전용 SQL 집계**: `db.query`로 봇 목록, 대화 기록, 장면 번호, 모델 사용량과 도우미 실행 통계를 직접 조회·집계할 수 있어요.
- **저장된 장면 편집**: 현재 채팅의 저장된 장면에서 문구를 검색(`scene.search`)하고, 변경 전 텍스트와 일치 횟수를 검증해 단일 또는 여러 장면을 수정해요(`scene.patch`, `scene.patchMany`). 원문과 번역문을 동시에 갱신하거나 이전 원문 버전으로 복원(`scene.restore`)할 수도 있어요.
- **서재 자료 및 프리셋 관리**: 봇·페르소나·모듈의 속성이나 로어북, 프롬프트 템플릿 블록을 수정 번호 기반으로 변경하고(`resource.patch`), 새 사본을 복제(`resource.clone`)하거나 채팅 전용 로어 재정의(`chat.lore`)를 관리해요.
- **설정·진단과 작업 제어**: 모델 역할, 새 채팅 기본값, 채팅별 모델·프롬프트 고정, 호출 한도와 이야기 UI 설정을 확인·변경하고(`settings.read/update`), 테마 목록을 확인해요(`theme.list`). 실행 중이거나 완료된 작업의 상태를 진단하고(`task.inspect`), 취소(`task.cancel`)하거나 재시도(`task.retry`)하며, 날짜별 사용량을 집계해요(`usage.read`).
- **다음 요청 미리보기와 장면별 로어 확인**: 실제로 보내지 않고 다음 집필 요청을 조립해서, 쓰일 모델·프롬프트·페르소나, 예상 입력 토큰과 한도, 들어갈 로어, 빠진 프롬프트 블록과 이유, 조립된 메시지 본문을 보여줘요(`chat.preview`). 이미 저장된 장면을 쓸 때 작가 모델이 실제로 받은 로어 항목도 확인해요(`scene.lore`). "왜 이 설정을 무시했지?" 같은 질문에 추측 대신 근거로 답할 수 있어요.
- **다음 장면 요청과 번역 요청**: 사용자가 장면을 써 달라고 하면 입력창에서 보낸 것과 같은 방식으로 다음 장면을 요청하고(`scene.request`), 번역이나 재번역을 요청해요(`scene.translate`). 둘 다 유료 모델 호출이라 명시적으로 요청했을 때만 실행해요. 작업을 예약만 하고 끝날 때까지 기다리지 않으며, 결과는 채팅과 읽기 화면에 나타나요. 이미 진행 중인 요청이 있으면 새로 보내지 않아요.
- **카드 변수 확인·수정**: `{{getvar::이름}}`이나 스크립트가 쓰는 Risu 변수의 현재 값, 봇·페르소나·모듈·프롬프트 프리셋의 기본값, 이 채팅에서 바꾼 값인지를 보여주고(`chat.variables.read`), 요청한 변수만 바꾸거나 기본값으로 되돌려요(`chat.variables.update`). 채팅의 요청이 대기 중이거나 실행 중일 때는 바꾸지 않아요.
- **채팅 설정 정리**: 창작 옵션을 이 채팅의 고정값으로 저장하고(`options.fix`), 장면에 이름을 붙이고(`scene.title`), 원작 참고 설정 중 요청한 항목만 바꾸고(`chat.guide.update`), 저장된 모델의 온도·최대 출력·추론 수준 같은 생성 설정을 바꿔요(`model.parameters.read/update`). 모델 생성 설정은 그 모델을 쓰는 모든 채팅에 적용되고, 연결 정보·자격 증명·단가는 그대로 둬요.
- **실시간 웹 검색과 모델 단가 갱신**: 지원 프로바이더(Responses, Anthropic) 및 Codex 환경에서 실시간 웹 검색으로 최신 정보를 찾고 출처 링크를 제공해요. 공식 출처(HTTPS URL 및 확인일)가 확인된 모델의 토큰 단가도 갱신해요(`model.pricing.update`).
- **Vertex 위치 관리**: Google Vertex 연결의 현재 위치를 확인하고(`vertex.location.read`), 모델 하나를 여러 위치에 짧게 시험해 응답 시간을 비교하고(`vertex.location.compare`), 사용자가 요청하면 연결의 위치를 바꿔요(`vertex.location.update`).
- **콘텐츠 이미지와 삽화 도구**: 서재에 저장된 콘텐츠 이미지와 CHARX 에셋을 조회하고(`image.read`), 외형 프로필(`illustration.profiles.*`)과 삽화 컷 생성·재렌더링·배치(`illustration.cut.*`, `illustration.generate`)를 제어해요.
- **Linux 데이터 작업 공간 (`data.exec`)**: Linux runner가 켜져 있으면 격리된 컨테이너에서 bash, ripgrep, jq, Python을 사용해 대규모 검색과 가공을 수행하고 CLI(`uimori call`, `uimori apply`)로 앱 도구를 다뤄요. 채팅을 내보내면 독자 화면의 번역문도 읽기 전용 파일로 함께 받고, 최근 장면의 원문·번역문 반복 표현을 찾는 `tools/repetition.py` 같은 기본 스크립트를 그대로 쓰거나 고쳐 쓸 수 있어요. 셸 호출 시간은 도우미 작업 시간 제한 안에서 원하는 만큼 정할 수 있어요.

## 안전장치와 확인

- **명시적 수정 요청 시에만 저장**: 사용자가 검토나 추천, 제안을 요청한 경우에는 저장하지 않고 검토 내용만 안내해요. 실제 수정을 명시적으로 요청했을 때만 저장 도구를 실행해요.
- **수정 번호(Revision) 및 해시 기반 충돌 방지**: 자료나 장면을 수정할 때 항상 변경 전 수정 번호와 텍스트 해시를 검증해요. 다른 화면이나 외부에서 먼저 내용이 바뀌었다면 저장을 차단해 덮어쓰기 사고를 막아요.
- **미저장 편집기 초안 보호**: 기기 편집기에 아직 저장되지 않은 초안(dirty draft)이 열려 있는 자료는 도우미가 수정할 수 없어요. 사용자가 편집기에서 먼저 저장해야 도우미를 통한 수정이 가능해요.
- **읽기 전용 조회와 격리된 작업 공간**: SQL 조회와 정규식 검색은 읽기 전용 연결로, 짧은 시간 제한 안에서만 실행돼요. Linux runner에는 앱 데이터베이스, 앱 환경 변수, 자격 증명이 연결되지 않고 전용 작업 공간 볼륨만 공유해요. 인터넷에는 앱과 분리된 전용 네트워크로 나갈 수 있어서 스크립트가 자료나 패키지를 내려받을 수 있지만, 작업 공간의 원고도 외부로 보낼 수 있다는 점은 알아 두세요.
- **영수증 기반 추적과 불확실한 재실행 방지**: 도우미의 저장은 트랜잭션 내에서 고유 영수증(`receiptId`)을 남겨요. 응답이 중간에 끊겨도 완료된 저장은 기록에 남으며, 불확실한 외부 쓰기나 실패한 작업을 자동으로 재실행하지 않아요.
- **작업 중 지침 추가와 직전 수정 되돌리기**: 작업 진행 중에는 **현재 작업에 추가**로 새 지침을 보낼 수 있고, 자료가 잘못 수정되었을 때는 **마지막 자료 수정 되돌리기**로 직전 저장본을 복원할 수 있어요.

## 관련 문서

- [전체 기능과 사용 안내](USAGE.md)
- [자료 편집과 저장 동작](EDITING.md)
- [서재 안내](LIBRARY.md)
- [작업 진단과 실행 내역](DIAGNOSTICS.md)
- [사용량 보고와 단가 안내](USAGE-REPORT.md)
- [도우미 첨부 파일](HELPER-ATTACHMENTS.md)
- [삽화와 외형 프로필](ILLUSTRATIONS.md)
- [원작 참고와 메모](STORY-GUIDE.md)
- [도구 상세 계약](TOOL-CONTRACTS.md)

---

## 기술 명세 (English)

아래 내용은 에이전트와 기여자를 위한 기록이에요. 도구의 인자·한도·결과 같은 계약은 모델이 받는 도구 설명과 입력 스키마, 그리고 테스트에 있어요. 여기에는 그 코드가 말해 주지 않는 것만 적어요.

The helper's provider-facing tools are `app.tools` and `app.call`, plus `data.exec` when `UIMORI_SHELL_ROOT` configures the Linux runner; `server/helper-runtime.ts` assembles them for each request. Everything else, including `data.search`, `data.read` and `db.query`, is an app operation registered in `server/helper-app-tools.ts` and reached through those gateways or the `uimori call` CLI. [CODE-MAP](CODE-MAP.md) lists the entry points per feature, and each section below names the files that define and test its operations.

Constraints on changing the helper's tools:

- A new capability is an app operation, not another provider tool. [Model tool contracts](TOOL-CONTRACTS.md#mutations) gives the reason for the `app.tools` and `app.call` indirection.
- An explicit outline review is read-only. `data.exec` is not offered, and both discovery and `app.call` use the `reviewAllowed` allowlist in `helperToolTraits`, which is narrower than the set of read-only operations.
- Safety does not depend on the order of calls. Discovery and confirmation rereads are optional steps; revision checks, unsaved-draft protection and uncertain-write handling are enforced where a save happens.
- For non-Codex helper and advisor requests without an authored prompt, `core/provider-messages.ts` sends unchanged `history` and `catalog` in a first user-content block so that follow-up requests share a prefix (`tests/provider-reference-context.test.ts`). No context is dropped or promoted to system instructions. A shared prefix is not a measured cache hit; anchors and actual reuse are covered in [model cache settings](MODEL-PARAMETERS.md#캐시-위치자동-배치유지-시간).
- A Codex helper registers the same tools as native dynamic tools and runs one task in one thread and turn; see [App Server 통신 및 턴 라이프사이클](CODEX.md#app-server-통신-및-턴-라이프사이클).

Outside the helper's tools:

- The writer, advisors and translation jobs have their own source-scoped tools, described in [Model tool contracts](TOOL-CONTRACTS.md#read-tools). They do not inherit the helper's live cross-chat SQL access.
- Conversation summarization reads its complete selected source prefix, not keyword search hits.

## General tool discovery, CLI and results

`app.tools`, `app.call`, `chat.list` and `chat.read` are defined in `server/helper-app-tools.ts`, together with the search behind `app.tools`. The `uimori` CLI is `runner/uimori.mjs`, and `server/helper-shell.ts` types its flags. The descriptions, the input schemas and the CLI's `--help` text are the contract the model receives. `tests/helper-discovery.test.ts`, `tests/helper-tool-contracts.test.ts` and `tests/tool-contract-portability.test.ts` enforce discovery: representative queries, paging, review filtering, the area index and the error that sends a library helper to `chat.list`. `tests/helper-cli.test.ts` and `tests/helper-shell.test.ts` enforce the CLI flags, and `tests/helper-shell-runtime.test.ts` and `tests/helper-activity.test.ts` how a failed shell command is reported. This section records only what those files do not state.

Behavior the descriptions leave out:

- The helper's scope (chat or library) only orders discovery results: it breaks ties between equally ranked candidates and, in a library helper, lists chat operations last in the catalog. It never hides an operation, because a library helper reaches chat operations by passing `chatId`.
- A candidate that covers every query word ranks ahead of partial matches, and partial matches stay in the list instead of emptying it.
- BM25 length normalization is deliberately mild, so a long description of a complex operation is not ranked below a short one for its length alone.

Constraints on changing these operations:

- Operation names, descriptions and schema field text, including parameter descriptions, are the text discovery ranks on, with a few per-operation synonyms in the same file. Rewording them changes ranking; [Model tool contracts](TOOL-CONTRACTS.md#names-descriptions-and-parameters) says how to write them.
- The CLI carries no copy of any schema. Its flags are typed against the operation's own input schema when the call reaches the app.

## Stored content images

`image.list`, `image.read`, `illustration.image.list` and `illustration.image.read` are defined in `server/helper-image-tools.ts`, which also prepares the picture that `illustration.cut.read` sends. The descriptions and input schemas there are the contract the model receives, and `tests/helper-image-tools.test.ts` and `tests/helper-image-runtime.test.ts` enforce it, including the 2 MiB limit, reads made inside `data.exec` and compaction. This section records only what those files do not state.

Behavior the descriptions leave out:

- `illustration.cut.read` has no `mode` and always sends the picture at the `full` size.
- There is no separate cap on how many images a task or a call may read. The context and transport budgets are the limit.
- Viewed pixels live only in the running task's memory; stored events, attempts and continuation state hold references and metadata. A context compaction shows the pending pictures to the summarizing model once and then releases them.
- `providerImagePart` in `core/provider-image-reference.ts` decides how each connection type receives the picture. Only a model that `imageInputSupported` knows to be text-only is refused before the read.

Constraints on changing these operations:

- `prepareHelperImage` is the single place that decodes, resizes and hashes a picture for these reads. The transport sends the prepared bytes as they are.

Outside these operations:

- Images in an unsaved editor draft, the image versions an older chat still pins, and attachments on a helper message ([도우미 첨부](HELPER-ATTACHMENTS.md)). `image.list` and `image.read` use the current saved library content.

## Illustration appearance profiles

`illustration.profiles.read` and `illustration.profiles.save` are defined in `server/helper-illustration-profiles.ts`, and the image discovery they rely on (`illustration.image.list`, `illustration.image.read`) in `server/helper-image-tools.ts`. The descriptions and input schemas there are the contract the model receives. `tests/helper-tool-contracts.test.ts`, `tests/helper-illustration-references.test.ts` and `tests/illustration-profiles.test.ts` enforce it, including chat targeting from the library, all-or-nothing batches and the wrong-scope error that points to the library resource. Those files leave out only the boundary below.

Outside these operations:

- The shared default profiles of a bot or persona. They are library data, saved through `resource.patch` at `source.appearanceProfilesPath`. `illustration.profiles.save` never writes them: editing an inherited profile stores a chat-local override. [인물 외형과 참고 이미지](ILLUSTRATIONS.md#인물-외형과-참고-이미지) describes how a chat inherits and restores the defaults.

### Work with generated illustrations

`illustration.scene.read`, `illustration.cuts.list`, `illustration.cut.read`, `illustration.cut.redraw`, `illustration.cut.revise` and `illustration.cut.delete` are defined in `server/helper-illustration-cuts.ts`, `illustration.generate` in `server/helper-illustration-generation.ts`, `illustration.cuts.place` in `server/helper-illustration-placement.ts`, `illustration.references.save` in `server/helper-illustration-references.ts`, and `illustration.continuity.read` and `illustration.continuity.save` in `server/illustration-continuity.ts`. `server/helper-illustration-workflow.ts` dispatches the ones that save. Renders are followed with `task.list` and `task.inspect` from `server/helper-task-tools.ts`. The descriptions and input schemas in those files are the contract the model receives. `tests/illustration-storyboard.test.ts`, `tests/helper-illustration-cuts.test.ts`, `tests/helper-illustration-references.test.ts`, `tests/illustration-continuity.test.ts`, `tests/helper-task-tools.test.ts` and `tests/helper-tool-contracts.test.ts` enforce it, including the guards, all-or-nothing reservation and what an illustration task inspection withholds. This section records only what those files do not state.

Constraints on changing these operations:

- These operations add no generation, deletion or layout path of their own. `illustration.generate`, `illustration.cut.redraw` and `illustration.cut.revise` reserve render jobs in the normal illustration queue, where the ordinary prompt preparation and content check apply. `illustration.cut.delete` uses the existing illustration deletion, and placement saves the scene's existing illustration layout.

Outside these operations:

- Generators, queueing, limits and how the Reader shows illustrations. See [장면 삽화 생성](ILLUSTRATIONS.md#구현-참고).

## Conversation history and task results

`GET /api/helper/conversations` and `GET /api/helper/tasks/:id/results` are registered in `server/helper-routes.ts`; the results view is built in `server/helper-task-results.ts` with the shape `HelperTaskResultsView` in `core/helper.ts`. Its `changes` come from the change record in `server/helper-changes.ts`, diffed by `core/text-diff.ts`. `tests/helper-workspace.test.ts` enforces the list's scope filters and deletion ownership and, for results, the recorded targets, no-op outcomes, rollback, survival of payload cleanup, usage fields and withheld private data. `tests/helper-changes.test.ts` enforces the net change per task, retried and failed operations, the deletion and retention paths and asset cleanup, `tests/helper-shell.test.ts` the scene saved by `uimori apply`, and `tests/text-diff.test.ts` the diff and its limits. This section records only what those files do not state.

Behavior the response types leave out:

- A receipt without a compact outcome is counted in `unrecordedOperations`. Its changes are unknown; they are not reconstructed from tool arguments or message text.
- An outcome confirms a commit that happened, not the target's current state. For `scene.request` and `scene.translate` it confirms that the work was queued, not that it finished.
- `usage.toolExecutions` counts recorded `tool.finished` events, so a callback interrupted before it finished is not counted.
- `usage.latestInputEstimate` is the last stored local estimate. It is not a percentage and says nothing about a native agent's current context.
- `usage.latestInputParts` splits that estimate into the request parts the runtime measured before sending, and `usage.latestInputExecution` says whether a provider tool loop or a native agent ran it. The composer indicator (`web/HelperContextUsage.tsx`) draws a budget bar only for the provider loop, marks automatic compaction at `HELPER_COMPACTION_INPUT_RATIO` from `core/helper.ts`, the same constant `server/helper-runtime.ts` compacts at, and `HUSAGE01` checks it.
- A change entry is the net difference between a target's state when the task first touched it and its state after the task's last write to it, however many calls wrote it. It is not the target's current state: a later user edit does not change the entry. A target whose net change is empty has no entry.
- Library resources, scene originals, translations and titles, the outline and author notes carry a diff. Settings (`chat.options`, `chat.variables`, `chat.storyGuide`, model, theme and global settings) and chat-only lore carry only the action and target. Illustration, scene request and translation request operations record no change entry; their outcome stays in `results`.
- A resource entry compares the authored native source, images, kind, loading and related items, not the projections regenerated from them, and list items (lore, prompt blocks, translation terms) are aligned by content, so removing one entry does not show every later entry as changed.
- `location` is data, not display text. `web/helper-change-location.ts` names it in the UI language with the labels the resource editor, the reader and the outline use; the resource sections come from `web/resource-sections.ts`, which the editors also use to open an anchor. Names the user wrote pass through unchanged, and a path the client has no name for is shown as an identifier. An entry recorded with the earlier Korean string keeps it and is shown as stored.
- An entry whose text was removed has `textRemoved` and no `location`, `diff` or `anchor`: `deleted` after the scene or resource was deleted, `expired` outside the retention in [도우미 변경 기록](DELETION.md#도우미-변경-기록). A target the task deleted is listed without an anchor.
- One response carries at most 200,000 characters of diff text; later diffs come back as omitted for size.

Constraints on changing these routes:

- Record an outcome inside the `operation` callback of `server/helper-workspace.ts` so that it commits or rolls back with its mutation and receipt. The same holds for a change entry, which also makes a replayed operation record nothing twice.
- Every helper save of a recorded domain goes through `server/helper-changes.ts`: `withHelperChange` around scene, scene title, outline and note saves, `recordHelperResourceChange` from `applyHelperResourceMutation`, and `recordHelperAction` for action-only entries, which `recordHelperTaskResult` calls for settings targets. The `uimori apply` scene save wraps its direct `store.editSource` in `withHelperChange` as well. A new save path for these domains uses them instead of writing `helper_changes`.
- The stored baseline is the full pre-change state (the editable resource model, scene text, outline nodes, note list) for a later turn rollback. A deletion path that removes a target must also call the matching `forgetHelper*Changes`.
- The results view exposes no resource bodies, pricing notes or source URLs, connection data, request bodies, arbitrary tool arguments, endpoint credentials or raw provider usage payloads.
- `kind=all` only lists: it creates and migrates nothing.

Outside these routes:

- A second undo history. Nothing restores from a change baseline yet; resource undo and draft protection keep their own contracts.

## Linux data workspace

`data.exec` is defined in `server/helper-data-tools.ts`, with its input schema in `core/main-shell.ts`. The contract the model receives is that description and schema together with the text the workspace gives it: `INDEX.md` (written by `server/helper-shell.ts`), `GUIDE.md` (`server/helper-shell-guide.ts`), the `uimori --help` usage (`runner/uimori.mjs`) and the help of the bundled `tools/repetition.py` (`server/helper-shell-scripts.ts`). They state the workspace layout, on-demand export, apply and refresh, CLI syntax, limits and results. `tests/helper-shell.test.ts`, `tests/helper-shell-runtime.test.ts`, `tests/helper-runner.test.ts` and `tests/helper-cli.test.ts` enforce that contract, including receipts, revision conflicts, unknown outcomes and the termination of child processes. This section records only what those files do not state.

Behavior the descriptions leave out:

- A command runs without stdin, so it cannot prompt.
- `uimori export` with a `scope` and neither `id` nor `all` only rewrites the catalog of that scope from the saved data.
- Translation copies under `chats/<id>/translations/` are written once, at the first export of the chat. They are neither apply nor refresh targets, and a repeated export or a later translation save leaves them unchanged. `originalSha256` in `translations.json` is the hash of the original as exported, so a working original with another hash means the copy translates the earlier text.
- In the result of a resource apply, `changedPaths` lists where the saved model differs from the previous saved model, and `normalizedPaths` where it differs from the submitted file, which is what the save normalized. Each list holds at most twenty paths, `changesTruncated` and `normalizationTruncated` mark omissions, and neither list counts the automatic package revision of content.
- Before any export, the workspace already holds `usage/recent.jsonl`: the 500 most recent model attempts across all chats, with role, model id, status, token counts and cost. Like the rest of the workspace, a script can send it out through the runner's network.
- A task's directory is removed when the task ends, so working copies and `outputFile` logs do not outlive it.

Constraints on changing these operations:

- The runner's only path to the app is the Unix sockets in the shared workspace volume. Its `runner-egress` network holds neither the app nor the proxy, and the two services share nothing but that volume. [저장과 운영](SELF-HOST.md#저장과-운영) describes the deployment.
- The `uimori` CLI is an adapter to the dispatcher behind `app.call` and has no storage code of its own. A call made through it keeps the task scope, editor-draft protection, revision checks, save effects and operation identity of the same call through `app.call`.
- `uimori apply` adds no save path. A resource file is saved as a helper `resource.save`, with the existing helper undo provenance and receipt attribution. A scene file goes through the existing source save and the post-commit handling described in [Editing saved scenes](#editing-saved-scenes).
- Scene apply and refresh use the current-chat ancestry check of the app scene operations.
- After an apply has committed, a projection or reader-notification failure is a warning on the saved result, never a failed save.
- Exported translation copies come from the Reader's completed-result projection (`core/translation-display.ts`), the one that scene translation reads use.
- The 24-hour maximum of `timeoutMs` is a sanity cap for the timer. The task deadline and cancellation are what bound a shell call.

Outside these operations:

- Background work. A command's children are stopped through its process group; a process that deliberately leaves the group is not a supported way to keep work running.
- Merging. `uimori refresh` does not merge a draft with the latest saved data and writes nothing to the database.
- Cleanup after a crash. A process crash can leave task directories behind for manual cleanup.

## Search and partial reads

`data.search` and `data.read` are defined in `server/helper-data-tools.ts` and executed by `server/helper-data-worker.ts`; `editor.read` is defined in `server/helper-app-tools.ts`. The descriptions and input schemas there are the contract the model receives: scopes and their default, filters, pattern matching, output modes, limits, references, paging and the `editTarget` a result can carry. `tests/helper-data-tools.test.ts` enforces that contract against the real data process, `tests/helper-data-runtime.test.ts` enforces it through the helper loop, and `tests/helper-resource-editing.test.ts` covers `editor.read`. [Model tool contracts](TOOL-CONTRACTS.md#pagination-and-results) owns the two `data.read` continuations (`nextIndex` and `nextOffset`), the rule that a failed ref stays local to its batch entry, and the absence of an exact total in search results. This section records only what those files do not state.

Behavior the descriptions leave out:

- Search reads raw authored fields. It does not execute native CBS or Lua and does not infer facts from scripts.
- Each resource is searched through one authored representation: the native `card` and `module` of a bot, persona or module, and the `program` and `values` of a prompt preset. Derived copies of the same text, such as `content.text` and `package.body`, are not fields, so one passage yields one hit.
- Within a bot, persona or module, fields are searched in this order: description, personality and scenario; lorebook entries; other fields; extensions and assets. The order decides which matches reach the first page.
- A library result carries `metadata.category`: the kind for a bot, persona or module, and `main` or `translation` for a prompt preset, whose kind is `prompt`.
- In `scope:"chats"`, a scene inherited through a fork appears under every chat whose ancestry contains it, numbered within that chat. The source ID and `chatId` together identify a result, which is why `chatId` travels in the ref and into a narrowing search.
- An excerpt is at most 2,000 UTF-16 units. A `data.read` batch and a field directory page each stop at about 16,000 serialized characters; `nextIndex` and the directory's `nextOffset` report what was left out.

Constraints on changing these operations:

- Both operations run in the isolated read-only data process described under [Read-only SQL](#read-only-sql).
- The `conversation` scope reads the saved helper messages. Do not keep a second transcript for it.
- Search does not reproduce effective context. The discovered `knowledge.read` and `chat.lore` operations own that contract.

Outside these operations:

- The editor target. [로컬 복구 저장소](EDITING.md#로컬-복구-저장소-indexeddb) describes how a saved reference or an unsaved draft is captured at admission, and the target is context, not a permission boundary ([도우미와 과거 가정 장면](USAGE.md#도우미와-과거-가정-장면)). The prompt library card action **도우미에게 묻기** sets a saved reference for the next request without changing the scope of the library conversation; opening a prompt editor, leaving the prompt library or clearing the target removes it.
- Reader selections. **도우미에게 물어보기** sends the whole selected passage as the task's `selection`, not as a search result. `tests/helper-workspace.test.ts` and `tests/helper-browser.spec.ts` enforce how it is kept whole and reused in later turns.

## Editing saved scenes

`scene.read`, `scene.search`, `scene.patch`, `scene.patchMany`, `scene.versions` and `scene.restore` are defined in `server/helper-scene-tools.ts`, and the `chat.read` scene index in `server/helper-app-tools.ts`. The descriptions and input schemas there are the contract the model receives: arguments, limits, guards, paging and what each result is for. `tests/helper-scene-tools.test.ts` and `tests/helper-scene-runtime.test.ts` enforce that contract, including its error codes and all-or-nothing saves. The helper discovers these operations through `app.tools` and runs them through `app.call`; discovery adds no provider-facing tools. This section records only what those files do not state.

Behavior the descriptions leave out:

- `scene.read` returns stored text before any CBS display transformation as well as before HTML rendering.
- A regex `scene.search` ignores zero-width matches.
- A whole-chat `scene.search` reads only scenes the selected chat owns. `excludedScenes` counts the rest of its ancestry: scenes inherited from a fork parent, and disabled scenes unless `includeDisabled` is set.
- Translation reads use the same completed-result projection as the Reader (`core/translation-display.ts`), so an earlier completed translation stays readable while a new attempt is pending. The identity of that displayed result is distinct from the latest revision, which is what a save conflict checks.

Constraints on changing these operations:

- A search result never authorizes a save. Regex search runs in the isolated read-only data process and its result is advisory; `scene.patch` checks the live guarded text before saving.
- Scene tools add no save path of their own. The existing source and translation save paths own revision checks, preservation, job invalidation and illustration placement, and HTTP and helper edits share post-commit cancellation of superseded jobs and reader notification. Translation images and in-flight translation attempts follow the same invalidation rules.
- A source edit makes old translation jobs stale and leaves saved execution inputs unchanged.
- The existing summary source-hash checks decide whether an earlier summary is still usable; scene editing does not author a replacement summary.
- A search sends the model neither a search index nor full scene bodies.

Outside these operations:

- Saving a `translation` together with an original edit keeps that reviewed translation current. It does not make arbitrary original edits semantically safe for translation reuse.
- Older text that a task still pins is not exposed as an editing archive.
- Automatic retranslation, scene titles and persistent writing options.
- Unsaved Reader drafts. Scene tools neither read them nor track them across tabs, and when a helper edit changes the saved base of a draft, the existing conflict UI keeps the draft and asks for reconciliation. See [도우미 본문 편집](EDITING.md#도우미-본문-편집).

## Read-only SQL

`db.query` is defined in `server/helper-data-tools.ts` and executed by `server/helper-data-worker.ts`. Its description and input schema are the contract the model receives. Called without `sql`, it returns the view names, their columns, example queries and path guidance from the running database, so this document lists no views, columns or examples. `tests/helper-data-tools.test.ts` enforces the views, the rejection of writes and of tables outside the views, the row and cell bounds, the timeout and cancellation; `tests/helper-data-runtime.test.ts` enforces unknown-column recovery and the concurrent read group. This section records only what those files do not state.

Behavior the descriptions leave out:

- `agent_messages.request` is the request stored with the scene's run, or the edited request text when the scene has one, and is NULL when the request is disabled for that scene. It does not reproduce what native scripts later projected from that request.
- A row set also stops at about 16,000 serialized characters, so `truncated` can be true below the row limit.
- An integer outside JavaScript's safe range is returned as a decimal string, and a binary value as its byte count without the bytes.

Constraints on changing these operations:

- `data.search`, `data.read`, `db.query` and a regex `scene.search` each run in a short-lived child process with a read-only connection, bounded memory and a three-second deadline; cancellation kills it. This keeps a pathological query or regular expression from blocking the server's event loop, so do not move this work into the server process.
- That process keeps nothing between calls: no file mirror, polling service, persistent pool or background scheduler, and it adds no migration, setting or package dependency. Task-local files belong to the [Linux data workspace](#linux-data-workspace).
- The server supplies the database path. Neither a path nor credentials are tool arguments.
- `db.query` never writes. Saves go through app operations so that revision checks and save effects apply.
- When one HTTP provider response contains adjacent `data.search`, `data.read` or `db.query` calls, they run concurrently, at most `Math.min(4, availableParallelism())` at a time. Only these three operations, which each run in their own data process, form a concurrent group; every other call is a sequential boundary, so no read passes an app mutation ([Execution boundaries](TOOL-CONTRACTS.md#execution-boundaries)). The cap is a small heuristic, not tuned to workload or container memory.

Outside these operations:

- Native Codex tool callbacks stay serialized; the concurrent group applies only to the HTTP provider tool loop.

## Discovering and executing app operations

The gateways `app.tools` and `app.call`, the operation index and the discovery ranking are defined in `server/helper-app-tools.ts`, together with the chat, chat-lore, library-folder, context, outline, notes and artifact operations. The `resource.*`, `theme.list`, `theme.guide`, `illustration-preset.*`, `preset.validate` and `image.update-metadata` operations are defined in `server/helper-resource-tools.ts`. The descriptions and input schemas in those two files are the contract the model receives: arguments, limits, paging, guards and what each result is for. `server/helper-runtime.ts` dispatches the operations and classifies their errors. `tests/helper-discovery.test.ts`, `tests/helper-tool-contracts.test.ts`, `tests/helper-resource-editing.test.ts`, `tests/helper-resource-inspection.test.ts`, `tests/helper-resource-undo.test.ts`, `tests/resource-clone.test.ts`, `tests/helper-lore-read.test.ts`, `tests/risu-preset-diagnostics.test.ts` and `tests/helper-compaction.test.ts` enforce that contract, including patch failure details, all-or-nothing saves, receipts, error recovery modes and what compaction keeps exact. This section records only what those files do not state. The outline operations are covered in [도우미 도구 계약](OUTLINE.md#도우미-도구-계약-outlineread-outlinewrite) and the theme operations in [도우미 도구 호출 계약](THEME-AUTHORING.md#도우미-도구-호출-계약).

Behavior the descriptions leave out:

- An explicit `chatId` runs that one call against the named chat and leaves the conversation's default scope unchanged. For an operation that consumes story or reference context, ancestry or a writing head (`writing` in `helperToolTraits`), the host prepares a writing snapshot of that chat at call time. A call without `chatId` keeps the task's original reservation.
- `data.search` and `data.read` address bot, persona and module fields by the editing path that resource operations take, such as `/package/nativeRisu/module/lorebook/0/key`. A `paths` filter or a ref written in the older source-relative form (`/module/lorebook/0/key`) is read as the same field. Search kind `prompt` is editing kind `prompt-preset`; an `editTarget` carries the editing kind together with the path.
- A prompt-preset overview carries the native Risu name as `nativeName`. A name longer than 200 UTF-16 units appears as `nativeNamePreview` with its length and exact read path instead.
- A `target` is the item's indexed path at the revision that was read. It is not a persistent ID, and array positions do not identify entries across revisions.
- Toggle reconciliation keeps a stored choice index that is still valid, even when reordering the choices changed what it means. `preset.validate` reports such changes against the retained previous save.
- `preset.validate` does not lint CBS by running the pinned RisuAI evaluator, because that evaluator tolerates some incomplete tags, reparses dynamic expressions and can write variables.
- `image.update-metadata` targets the content that owns the image. `prompt-workspace` always targets `current`, whatever `id` the call passes, as `resource.save` does.
- The `nextRead` of a `HELPER_READ_TOO_LARGE` result names a provider tool, so the model can invoke it unchanged in the next round: `app.call` with nested `name` and `arguments` for every app operation, including `data.search` and `data.read`, and `data.exec` for shell output.

Constraints on changing these operations:

- `helperToolTraits` in `server/helper-app-tools.ts` is the one policy for read or write classification, outline-review availability and writing-snapshot needs. Metadata reads, renames, lore operations and outline navigation stay out of its `writing` set, so an explicit `chatId` does not prepare a snapshot they would not use.
- Each definition in `server/helper-resource-tools.ts` declares whether the operation reads or mutates and which resources a mutation targets. Draft protection, operation receipts, undo tracking and resource update events all use that declaration; a new resource mutation declares its targets there instead of in a second list. The declaration is stripped from the schema the model receives.
- Resource operations add no save path. Revision checks, final validation, regenerated projections and the single retained undo belong to `saveResource` in `server/resource-service.ts`, which the editor also uses, and `resource.clone` shares `cloneResource` with `POST /api/resources/clone` and library list copies. See [동시성 제어와 멱등성 보장](EDITING.md#동시성-제어와-멱등성-보장).
- The `editTarget` hints of `data.search` and `data.read` and the validation of `resource.patch` read the same `server/helper-native-protected-fields.json` and `server/helper-resource-path-policy.json`: protected field names, preset paths and JSON Pointer limits. Change them together. The limits apply to the full editing path, including the native-content prefix.
- Model arguments never carry mutation identity. The host derives it from the task and the provider call ID and passes it separately; a new call ID is a new operation. Authorization and the shape of the final reply are stated once in the helper contract (`CONTRACT` in `server/helper-runtime.ts`), not per operation. See [Mutations](TOOL-CONTRACTS.md#mutations) and [Names, descriptions and parameters](TOOL-CONTRACTS.md#names-descriptions-and-parameters).
- The provider tool list stays fixed throughout a continuation; see [Provider continuation state](TOOL-CONTRACTS.md#provider-continuation-state).
- Native tool history keeps the `app.call` envelope, `name` and `arguments`, as the provider sent it. Read or write classification, compaction and the activity view use the inner operation.
- `HELPER_READ_TOO_LARGE` replaces only a read result that cannot fit the selected model's input budget; the result is withheld, not truncated. The dispatcher adds no fixed per-read or per-round token cap: accumulated reads go through context compaction. A result that carries a confirmed write is never replaced.
- Composer recovery lives in `web/helper-recovery.ts`, enforced by `tests/helper-recovery.test.ts`, `tests/helper-recovery-browser.spec.ts` and `tests/helper-browser.spec.ts`. A read failure is not an empty store and must not overwrite the saved draft, selection, outline selection or unacknowledged request. An accepted request is cleared only while the stored value is still that request, and a cleanup or view-refresh failure after acceptance is not a failed send. See [로컬 복구 저장소](EDITING.md#로컬-복구-저장소-indexeddb).
- Conversation creation, conversation copy and project creation share `web/helper-pending-request.ts` for request identity, storage precedence and matched cleanup; see [새 도우미 세션 생성](#새-도우미-세션-생성).

Outside these operations:

- Complete models. Bounded pages and compact receipts apply to helper reads and results only; UI, backup and export APIs keep returning complete models, and stored chat-lore undo and conflict data stay complete.
- Replacing arbitrary objects or a root with `resource.patch`. `set` takes a scalar or an array of scalars, apart from the three whole values its description names.
- A history of library resources. One previous save is retained per resource, and cloned presets are not kept synchronized; see [도우미 부분 수정 및 문자열 치환 알고리즘](EDITING.md#도우미-부분-수정-및-문자열-치환-알고리즘).
- Independent-scene generation and editing. There is no `artifact.generate` operation and no `PATCH /api/helper/artifacts/:id` route; `artifact.read` and `GET /api/helper/artifacts/:id?revision=N` only read saved revisions. A different story direction uses `chat.fork` and then normal chat writing, which `scene.request` can send. Forking does not start generation.
- New device-local artifact edit drafts. Drafts saved earlier stay readable and copyable in the artifact card, and they are removed only together with their conversation's local recovery data.
- Sending a recovered request automatically after a reload.

## 새 도우미 세션 생성

생성 요청의 임시 보관은 `web/helper-pending-request.ts`가 맡고, 대화 복사와 프로젝트 생성도 같은 함수를 써요. 저장소 순서, 재시도 키 재사용, 다른 탭 요청과의 분리, 새로고침이나 보관 실패 때 보내지 않는 동작은 `tests/helper-pending-request.test.ts`, `tests/helper-sessions-browser.spec.ts`, `tests/helper-workspace-browser.spec.ts`가 확인해요. 여기에는 그 밖의 것만 적어요.

- 처음 보낸 요청이 확정 거절(408·429를 뺀 4xx)되면 보관한 요청을 지워요. 복원해서 다시 보낸 요청은 거절되어도 남기고 성공했을 때만 지워요.
- 보관할 자리를 만들려고 다른 초안이나 설정을 삭제하지 않아요.
- `sessionStorage`에만 보관된 요청은 탭을 닫으면 복구되지 않을 수 있어요.

## 도우미 대화와 과거 분기

사용자에게 보이는 동작은 [도우미와 과거 가정 장면](USAGE.md#도우미와-과거-가정-장면)이 안내해요. `helper_seed_messages`는 과거 분기 대화와 **대화 복사**(`server/helper-workspace.ts`의 `copy`)가 함께 쓰는 대화문 저장소이고, 읽기·이력·수정·삭제는 `tests/helper-workspace.test.ts`가 확인해요.

seed 대화문은 역할·본문·첨부만 담아요. 이전 모델 시도·사용량·도구 실행·변경 영수증은 옮기지 않으므로 다시 실행하지 않고, 이어지는 작업은 필요한 자료의 현재 저장 상태를 새로 읽어요.

## Activity and restoring the last resource edit

An addition to a running task (**현재 작업에 추가**) is `steer` in `server/helper-runtime.ts`, the call limits are the constants in `core/helper.ts`, the activity view is `server/helper-activity.ts`, and **마지막 자료 수정 되돌리기** is `server/helper-resource-undo.ts` with `web/HelperResourceUndo.tsx`. `tests/helper-workspace.test.ts`, `tests/helper-activity.test.ts`, `tests/helper-resource-undo.test.ts` and `tests/helper-browser.spec.ts` enforce how an addition is delivered, the limits, the bounded activity projection and when an edit can be restored. The limit values are listed in [실행 한도와 주요 정책 요약](CODEX.md#실행-한도와-주요-정책-요약), and the rules for restoring a batch in [도우미 서재 자료 편집과 일괄 처리](EDITING.md#도우미-서재-자료-편집과-일괄-처리). This section records only what those files do not state.

What the recorded states mean:

- A `delivered` addition was placed into the execution input. It does not show that the model followed it.
- The call limits are observable host boundaries on model requests and tool callbacks. They are not a money cap and do not measure native Codex internal sampling.
- Activity records explain execution, not model reasoning or the quality of an answer.

Constraints on changing this behavior:

- An addition is text only. The task keeps its model, captured materials and read-only review mode.
- On HTTP providers an addition does not interrupt a tool that is already running; only calls that have not started are skipped.
- Pending and unconfirmed additions are never replayed, neither automatically nor by a retry. A retry of the unchanged request carries the delivered additions.
- Call limits are an internal policy, not a conversation setting. A task runs under the limits and the timeout captured in its snapshot at admission, and its deadline is timed from the start of execution.
- `applyHelperResourceMutation` is the only writer of the `resource.edited` event that the shortcut reads. `app.call` resource saves and native `uimori apply` both pass through it and must keep doing so.
- The unsaved-editor block is a check of the editors mounted in the open app. The server does not see unsaved input, so other devices are protected by revision checks alone.
- A view refresh that fails after a confirmed restore is reported as a refresh failure, not as a failed restore.

Outside the restore shortcut:

- Created and deleted resources, saves that changed nothing, and an undo issued by the model.
- Rolling back a whole task, and falling back to an older edit when the latest one cannot be restored.
- Saves without a `resource.edited` event. They stay editable through the resource editors, and no shortcut is reconstructed for them.

## Original-work reference and authored notes

[Original-work reference](STORY-GUIDE.md) owns the **원작 참고** settings, the automatic pre-writing step and the absence of dedicated question or preview endpoints. The helper reads the settings as `storyGuide:{revision,config}` in `context.read` (`server/helper-context.ts`, checked by `tests/story-guide-routes.test.ts`), and its contract in `server/helper-runtime.ts` says how to answer original-work questions.

- `context.read` returns the settings, not a generated brief. A previously generated brief is not a source of story facts.
- Neither a helper answer nor an automatic brief creates a branch ledger.
- **Risu 작가 노트** is not an event log or proof of what a character knows. [이야기 기억과 컨텍스트·메모](USAGE.md#이야기-기억과-컨텍스트메모) separates it from **메모·정정**.

## Web search and model pricing

Helper web search is decided per adapter protocol by `helperWebSearchCapability` in `core/helper-web-search.ts`. The Responses, Anthropic and Codex encoders (`core/openai-protocol.ts`, `core/anthropic-protocol.ts`, `core/codex-protocol.ts`) turn it into provider search, and `tests/helper-web-search.test.ts` enforces which requests may search, how search continuations are preserved and how citations become links. `model.pricing.read/update` are defined in `server/helper-pricing-tools.ts` and `vertex.location.read/compare/update` in `server/helper-vertex-location-tools.ts`. The descriptions and input schemas there are the contract the model receives, enforced by `tests/helper-pricing-tools.test.ts` and `tests/helper-vertex-location-tools.test.ts`. Pricing rules (units, unknown versus free, catalog pricing, frozen prices) are in [비용 계산과 단가 관리](USAGE-REPORT.md#비용-계산과-단가-관리) and [모델 요금과 추정 비용](MODEL-PRICING.md), and the Codex search modes in [실행 한도와 주요 정책 요약](CODEX.md#실행-한도와-주요-정책-요약). This section records only what those files do not state.

Behavior the descriptions leave out:

- `source.currentDateUtc` in the helper request is the UTC date on which the task was created, not the date of each model request.

Constraints on changing these operations:

- An adapter without search support reports search as unavailable. It does not fall back to another search service.
- `vertex.location.compare` sends each location through the connection test runner in `server/provider-connection-test.ts`. That is why a comparison is recorded like a response test and a replayed operation sends nothing new. Keep it on that runner.

Outside these operations:

- Adapter support does not establish that a particular model or account searched successfully or that a result is current. The adapter tests are synthetic; they are not live-search, provider-account or billing evidence.
- Search-tool fees can be absent from token-rate estimates. See [구현 참고](USAGE-REPORT.md#구현-참고).
- The original-work reference step has its own search capability, `storyGuideWebSearchCapability`, which also covers Gemini and Vertex. See [Original-work reference](STORY-GUIDE.md).

## Requesting the next scene or a translation

`scene.request` and `scene.translate` are defined in `server/helper-story-tools.ts`. The descriptions and input schemas there are the contract the model receives, and `tests/helper-story-tools.test.ts` enforces it. This section records only what those files do not state.

Constraints on changing these operations:

- `scene.request` builds its run from `composerRunSnapshot` in `server/composer-run.ts` and reserves it through `store.createRunInTransaction`, so it shares the composer's snapshot and its head, settings, busy-chat and main-model checks. `scene.translate` calls the reader's `requestTranslation`. Neither adds a path of its own.
- The reservation, the helper receipt and the result target commit in one transaction, and the run's idempotency key is derived from that receipt. Work starts only after the commit and only when this call created it, so a replayed receipt never executes it again.
- A chat whose run is already queued or running returns `SCENE_REQUEST_BUSY` before the conflict checks, so the helper reports it instead of sending the request again.

Outside these operations:

- Reference images and lore-selection reset are composer-only.

## Next request preview, scene lore and card variables

`chat.preview`, `scene.lore`, `chat.variables.read` and `chat.variables.update` are defined in `server/helper-chat-state-tools.ts`. The descriptions and input schemas there are the contract the model receives, and `tests/helper-chat-state-tools.test.ts` enforces it, including that a preview writes nothing. The composer's own preview is documented in [다음 요청 미리보기](CONTEXT-LIMITS.md#다음-요청-미리보기). This section records only what those files do not state.

Behavior the descriptions leave out:

- In a `chat.preview` list, lore, excluded prompt blocks and compiler warnings appear on the first page only.
- Image and file parts of a previewed message appear as `[image]` and `[file]` placeholders.
- Without a main model, or when preparation fails, `chat.preview` returns only the preview metadata and its error.
- A `chat.variables.update` that changes nothing writes nothing and still checks both guards.

Constraints on changing these operations:

- Each read reuses a projection the app already has and computes nothing a second way. `chat.preview` runs `inspectNextRequest` in `server/request-preview.ts`, the preparation behind the composer's request preview. `scene.lore` shares `sceneRequestLore` with the reader's last-scene lore endpoint. `chat.variables.read` reads `chatVariableView`, the projection behind `GET /api/chats/:id/variables`.
- `chat.variables.update` writes through `writeChatVariables` inside the helper operation transaction, which keeps the existing revision, source-hash, busy-chat and journal checks. Its journal key is derived from the helper receipt.
- Preparation errors stay bounded to `PREVIEW_UNAVAILABLE`, because author-controlled compilation errors can contain source text.

## Fixed options, scene names, original-work reference and model parameters

`options.fix` is defined in `server/chat-options.ts`, `scene.title` and `chat.guide.update` in `server/helper-chat-state-tools.ts`, and `model.parameters.read/update` in `server/helper-model-parameter-tools.ts`. The descriptions and input schemas there are the contract the model receives, and `tests/helper-chat-settings-tools.test.ts` enforces it. Scene names are documented in [장면 이름과 목차 관리](READING-STATE.md#장면-이름과-목차-관리), the original-work reference in [Original-work reference](STORY-GUIDE.md), and how saved model settings reach reserved work in [저장과 실행](MODEL-PARAMETERS.md#저장과-실행). This section records only what those files do not state.

Constraints on changing these operations:

- Each operation saves through the function the settings UI uses and adds no checks or save path of its own: `options.fix` through `ChatOptionsStore.fixed`, `scene.title` through `setSceneTitle`, `chat.guide.update` through `storyGuide.update`, and `model.parameters.update` through `prepareModel`.
- `chat.guide.update` validates the merged configuration before the save, so an invalid value returns `STORY_GUIDE_INVALID` instead of an unknown write outcome.
- `model.parameters.update` saves a complete model. It rebuilds the saved model input from `SAVED_MODEL_KEYS`, applies the changes and hands the result to `prepareModel`, so a saved model field missing from that list is dropped by an update.
- The `setting` value recorded with a change (`chat.options`, `chat.storyGuide`, `model.parameters`) selects the settings view that the result opens in `web/main.tsx`.

Outside these operations:

- Connections, credentials, execution mode, service tier and cache options stay outside `model.parameters.update`.

## Settings, diagnostics and task control

`theme.list` is defined in `server/helper-resource-tools.ts`; `model.list`, `settings.read`, `settings.update` and `usage.read` in `server/helper-settings-tools.ts`; `task.list`, `task.inspect`, `task.cancel` and `task.retry` in `server/helper-task-tools.ts`. The descriptions and input schemas there are the contract the model receives: what each result contains and omits, which revision each setting group needs, value ranges, paging, and what a committed-effect receipt does and does not prove. `tests/themes.test.ts`, `tests/helper-settings-tools.test.ts`, `tests/usage-report.test.ts` and `tests/helper-task-tools.test.ts` enforce that contract. This section records only what those files do not state.

Behavior the descriptions leave out:

- After `settings.update` commits, the helper also publishes a `settings.updated` event on its own conversation. The browser refreshes open settings from that event, which is how a library helper with no selected chat updates them.
- In a helper task's tool diagnostics, `elapsedMs` covers one call's dispatch and result preparation, including the time it waited on its worker or provider, and excludes the time it waited for a sibling read to finish. `queueMs` is the time a native Codex tool call waited behind the previous call before dispatch. Calls can overlap, so summed times are not wall time.
- A save that changes nothing can still write a receipt, so it can appear in `committedEffects`.

Constraints on changing these operations:

- `settings.update` saves through the services the settings screens use (model workspace, chat profile, chat settings and new-chat defaults) and adds no save path of its own. Those services own the revision checks, the preservation of unrelated values and their events.
- `usage.read` returns the report that the usage page and CSV are built from (`server/usage-report.ts`), limited to the requested breakdowns, and adds no accounting rule of its own. Date ranges, cost statuses and which calls count are defined in [작업실 사용량](USAGE-REPORT.md).
- `helper_operations` is the only evidence that a helper save committed, and a receipt is attributed to a tool call by the host call identity alone. Neither is inferred from a `tool.finished` success, a tool name or a result body. Inspection reads these existing records and adds no store of its own.
- A `receiptId` identifies an existing operation record. It is not an instruction or an idempotency key for submitting another write.
- `task.cancel` and `task.retry` call the transitions that the app's own task controls use, wired in `server/app.ts`. The services behind them keep their eligibility checks, including the refusal to retry a helper task that has committed effects; `canCancel`, `canRetry` and `retryBlock` report eligibility and do not replace those checks.
- A task state change and the calling helper's receipt commit in one transaction. Aborting a controller, publishing and starting a worker happen only after it commits.

Outside these operations:

- Unsaved settings and editor drafts keep their existing conflict behavior.
- What the recorded attempt and tool diagnostics cover, how long they are kept and what stays unknown for older tasks is documented in [문제 확인과 실행 상세](DIAGNOSTICS.md#구현-참고).

## Accounting and summary preparation

This section has no model-facing operations. It covers how the host compacts a helper conversation and how a helper task's usage and timing are recorded. The compaction decision and the `input.measured`, `tool.started` and `tool.finished` events are in `server/helper-runtime.ts`, checkpoints in `server/helper-context.ts`, attempt accounting in `server/helper-workspace.ts`, the argument preview in `server/helper-diagnostics.ts`, and the usage shown for a task in `server/helper-task-results.ts`. `tests/helper-compaction.test.ts`, `tests/helper-workspace.test.ts`, `tests/helper-diagnostics.test.ts`, `tests/helper-data-runtime.test.ts` and `tests/helper-browser.spec.ts` enforce the behavior, including the exact recent turns kept through compaction, checkpoint invalidation on retry, task views that do not load the reserved snapshot, single counting of a repeated attempt completion, and paused reads in closed or hidden helper views.

Other documents own the rules:

- Compaction threshold, adoption, segments, completed-read references and failure codes: [재사용·실패·복원](CONTEXT-LIMITS.md#재사용실패복원).
- Manual conversation compaction: [수동 정리와 요약 편집](CONTEXT-LIMITS.md#수동-정리와-요약-편집).
- What a finished helper task keeps and what the browser refresh reads: [도우미 기록과 화면 전환](EXECUTION.md#도우미-기록과-화면-전환).
- Attempt and tool diagnostics, their retention and the helper usage summary: [문제 확인과 실행 상세](DIAGNOSTICS.md).
- The native Codex turn, its instructions, call limits and token usage: [App Server 통신 및 턴 라이프사이클](CODEX.md#app-server-통신-및-턴-라이프사이클).
- Reading local estimates, provider usage and preparation and compaction timings: [Evidence and metrics](HELPER-EVALUATION.md#evidence-and-metrics).

What those documents and tests leave out:

- Host compaction starts only under context pressure. Model size, cost and repeated reads of the same data do not start it earlier, because the aim is to keep exact evidence in the request for as long as it fits. The rule makes no claim about provider cost or cache reuse.
- The component estimates in `input.measured` are serialized separately for diagnosis. They do not necessarily sum to the estimate of the encoded request.
- `originalResultChars` and `providedResultChars` count the serialized JSON at the helper boundary. They are not the size of the source resource or of a shell's full output.
- `elapsedMs` on `attempt.finished` spans the host's provider request. It is neither first-token latency nor the time of one internal model call inside a native Codex turn.
- The local input estimate covers what Uimori sends. A native Codex turn adds its own tool descriptions and runtime context, so the provider-reported input can be higher.

Constraints on changing this code:

- A native Codex tool call goes through the same dispatcher as every other provider's tool call, with the same result limits, revision checks and receipts. Codex has no tool path of its own.

## Goal evaluation

[Helper goal evaluation](HELPER-EVALUATION.md) owns the evaluation cases, the oracles fixed before execution, and what scripted provider checks do and do not establish about a real model.

### Illustration presets

`illustration-preset.list` and `illustration-preset.guide` are defined in `server/helper-resource-tools.ts`. A preset is read, saved, undone and deleted through the `resource.*` operations with `kind: illustration-preset`, under their revision and receipt contract; presets have no save path of their own. `tests/helper-tool-contracts.test.ts` checks that a helper save neither selects a preset nor generates an image. [Illustrations](ILLUSTRATIONS.md#삽화-프리셋) documents what a preset holds, what stays outside it, when an edit takes effect, selection priority and portability.

### Bounded composition reads

`outline.read` and `outline.write` are defined in `server/helper-app-tools.ts`, and `server/outline-read.ts` assembles the read pages. The descriptions and input schemas are the contract the model receives: modes, sections, units, page defaults, versioned continuation and what `coverage.wholeField` means. `tests/helper-outline.test.ts` enforces that contract, including the page budget, change detection limited to the view being read, writings references and the compact write receipt. `tests/helper-compaction.test.ts` checks that coverage, version, source references and continuations stay in completed-read metadata after host compaction. [도우미 도구 계약](OUTLINE.md#도우미-도구-계약-outlineread-outlinewrite) lists the modes, limits and result fields. This section records only what those do not state.

Behavior the descriptions leave out:

- A writing whose scene is not in the chat's current history is returned as unavailable, without a reference. It is never matched to another scene.
- When an `outline.read` result does not fit the model's input budget, the refusal carries a `nextRead` for the same range with a smaller `limit`, not a library search.

Constraints on changing these operations:

- These pages are the helper's view of the outline. The browser's outline API keeps its full tree response.
- `coverage.wholeField` belongs to intent reads. `complete` on the search tools keeps its own meaning and is not replaced by it.

Outside these operations:

- `coverage` reports what one response returned. It never certifies that a review was complete.
- `knowledge.search` with `mode: browse` is reachable through the same `app.tools` and `app.call` gateways, including in a read-only review. Its contract is in [Folder navigation](TOOL-CONTRACTS.md#folder-navigation).

### Token budgets and isolated read processes

Each host read states its page defaults in its input schema, and [Units and model-facing budgets](TOOL-CONTRACTS.md#units-and-model-facing-budgets) owns the unit rules. Not stated there:

- The continuation of a page read without a limit carries no limit, so one page's measured length does not become a fixed character default.
- The isolated data, SQL and regex worker keeps its character pages, memory and time limits and IPC size guards, and does not tokenize. The host applies the token budgets to what it returns.
- Shell command and output byte limits and exact completed mutation receipts are separate from these token budgets.
