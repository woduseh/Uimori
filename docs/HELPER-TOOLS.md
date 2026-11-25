# 도우미 도구

Uimori의 도우미는 대화와 서재에서 창작과 설정을 보조하는 에이전트예요. 사용자의 질문에 답하는 것에 그치지 않고, 내부 앱 도구와 격리된 데이터 작업 공간을 활용해 필요한 자료를 부분 조회·검색하고, 장면이나 설정을 수정할 수 있어요.

## 도우미가 할 수 있는 일

- **원고와 서재 자료 부분 조회·검색**: 봇·페르소나·모듈·프롬프트 프리셋의 전체 본문을 무리하게 불러오지 않고 필요한 필드와 구간만 검색하고 읽어요(`data.search`, `data.read`). 개요 트리(`outline.read`)와 지식 베이스(`knowledge.search`)도 페이지 단위로 나누어 조회해요.
- **읽기 전용 SQL 집계**: `db.query`로 봇 목록, 대화 기록, 장면 번호, 모델 사용량과 도우미 실행 통계를 직접 조회·집계할 수 있어요.
- **저장된 장면 편집**: 현재 채팅의 저장된 장면에서 문구를 검색(`scene.search`)하고, 변경 전 텍스트와 일치 횟수를 검증해 단일 또는 여러 장면을 수정해요(`scene.patch`, `scene.patchMany`). 원문과 번역문을 동시에 갱신하거나 이전 원문 버전으로 복원(`scene.restore`)할 수도 있어요.
- **서재 자료 및 프리셋 관리**: 봇·페르소나·모듈의 속성이나 로어북, 프롬프트 템플릿 블록을 수정 번호 기반으로 변경하고(`resource.patch`), 새 사본을 복제(`resource.clone`)하거나 채팅 전용 로어 재정의(`chat.lore`)를 관리해요.
- **설정·진단과 작업 제어**: 역할별 모델과 프롬프트, 자동 번역과 번역 결과 언어, 새 채팅 기본값(거절 뒤 자동 다시 생성, 로어 컨텍스트 포함), 채팅별 모델·프롬프트 고정, 호출 한도와 이야기 UI 설정을 확인·변경하고(`settings.read/update`, 여러 설정을 한 번에 저장하거나 하나도 저장하지 않음), 테마 목록을 확인해요(`theme.list`). 실행 중이거나 완료된 작업의 상태를 진단하고(`task.inspect`), 취소(`task.cancel`)하거나 재시도(`task.retry`)하며, 날짜별 사용량을 집계해요(`usage.read`).
- **다음 요청 미리보기와 장면별 로어 확인**: 실제로 보내지 않고 다음 집필 요청을 조립해서, 쓰일 모델·프롬프트·페르소나, 예상 입력 토큰과 한도, 들어갈 로어, 빠진 프롬프트 블록과 이유, 조립된 메시지 본문을 보여줘요(`chat.preview`). 이미 저장된 장면을 쓸 때 작가 모델이 실제로 받은 로어 항목도 확인해요(`scene.lore`). "왜 이 설정을 무시했지?" 같은 질문에 추측 대신 근거로 답할 수 있어요.
- **다음 장면 요청과 번역 요청**: 사용자가 장면을 써 달라고 하면 입력창에서 보낸 것과 같은 방식으로 다음 장면을 요청하고(`scene.request`), 번역이나 재번역을 요청해요(`scene.translate`). 둘 다 유료 모델 호출이라 명시적으로 요청했을 때만 실행해요. 작업을 예약만 하고 끝날 때까지 기다리지 않으며, 결과는 채팅과 읽기 화면에 나타나요. 이미 진행 중인 요청이 있으면 새로 보내지 않아요.
- **채팅 변수 확인·수정**: `{{getvar::이름}}`이나 스크립트가 쓰는 Risu 변수의 현재 값, 봇·페르소나·모듈·프롬프트 프리셋의 기본값, 이 채팅에서 바꾼 값인지를 보여주고(`chat.variables.read`), 요청한 변수만 바꾸거나 기본값으로 되돌려요(`chat.variables.update`). 채팅의 요청이 대기 중이거나 실행 중일 때는 바꾸지 않아요.
- **채팅 설정 정리**: 창작 옵션을 이 채팅의 고정값으로 저장하거나 일부 옵션만 고정·해제하고(`options.fix`), 장면에 이름을 붙이고(`scene.title`), 원작 참고 설정 중 요청한 항목만 바꾸고(`chat.guide.update`), 저장된 모델의 온도·최대 출력·추론 수준 같은 생성 설정을 바꿔요(`model.parameters.read/update`). 모델 생성 설정은 그 모델을 쓰는 모든 채팅에 적용되고, 연결 정보·자격 증명·단가는 그대로 둬요.
- **모델 등록과 삭제**: 이미 있는 연결에 새 모델을 등록하고(`model.register`), 쓰지 않는 모델을 지워요(`model.delete`). 역할이나 조언자로 지정됐거나 채팅에 고정된 모델은 지우지 않고 어디서 쓰는지 알려 줘요. 연결, 자격 증명, 엔드포인트는 설정 화면에서만 바꿀 수 있어요.
- **채팅 구성과 정리**: 채팅에 첨부한 페르소나와 모듈, 로어 컨텍스트, Risu 작가 노트를 확인하고 바꿔요(`chat.profile.read/update`). 장면을 작가 모델에게서 숨기거나 그 장면의 요청문을 끄고 고치고(`scene.context.update`), 책갈피를 추가·수정·삭제하고(`chat.bookmark`), 봇별 채팅 폴더, 채팅 고정과 새 채팅의 기본 페르소나를 정리해요(`chat.organize`). 서재 폴더를 만들고 이름·순서를 바꾸거나 없애고 자료를 옮겨요(`library.organize`). 폴더를 없애면 안의 자료는 맨 위로 옮겨지고 지워지지 않아요. 작가 노트, 요청문, 책갈피를 고치거나 지우면 변경 카드에서 작업 전 글과의 차이를 확인할 수 있어요. 아주 긴 글을 통째로 바꾸면 차이는 생략돼요.
- **새 채팅 만들기와 채팅 삭제**: 새 채팅 화면처럼 봇을 골라 새 채팅을 만들어요(`chat.create`). 페르소나를 정하지 않으면 봇이나 폴더의 기본 페르소나로, 첫 메시지를 정하지 않으면 봇의 첫 메시지로 시작하고, 첫 메시지 없이 빈 채팅으로 만들 수도 있어요. 이름을 정하지 않으면 봇 이름으로 만들고 이야기가 시작되면 제목 모델이 이름을 다시 붙여요. 만든 채팅으로 화면을 옮기지는 않고, 결과 카드에서 열 수 있어요. 채팅 삭제(`chat.delete`)는 채팅 목록의 삭제와 같아서 되돌릴 수 없으므로 확인 카드로 물어요. 이 대화가 속한 채팅은 대화와 진행 중인 작업까지 지워지므로 도우미가 지우지 않아요.
- **옵션 프리셋**: 창작·번역 프롬프트의 옵션 프리셋을 보고(`prompt.combination.list`), 지금 값이나 정한 값을 새 프리셋으로 저장하고(`prompt.combination.save`), 이름과 값을 고치고(`prompt.combination.update`), 프롬프트 설정의 기본값으로 적용하고(`prompt.combination.apply`), 지워요(`prompt.combination.delete`, 확인 카드). 한 채팅에만 적용할 때는 입력창 메뉴처럼 그 값을 채팅 고정값으로 저장해요(`options.fix`).
- **Risu 코드 확인**: 봇·페르소나·모듈·프롬프트 프리셋의 CBS, Lua 트리거, 구조화 트리거, 정규식, 로어 키를 실행하지 않고 검사해요(`code.diagnose`, `code.cbs`). 문법 오류, 없는 이미지 이름, 컴파일되지 않는 정규식, Uimori가 지원하지 않거나 무시하는 로어 지시문·Lua 함수·트리거 효과·프리셋 블록을 필드 경로와 줄·칸 위치로 알려 주고, 변수와 토글을 어디서 읽고 쓰는지 찾아요(`code.references`). 표본 글에 한 단계의 정규식을 차례로 적용해 스크립트마다 바뀐 부분을 보거나(`code.regex`), 첫 메시지를 저장 전 수정안이나 다른 토글 값으로 렌더링해 볼 수 있어요(`code.preview`). 이 확인은 아무것도 저장하지 않고 모델도 부르지 않아요. 도우미는 [Risu Lua 트리거 API](RISU-LUA-API.md), [실행 순서](RISU-RUNTIME-INTEROP.md), [프리셋 필드](RISU-PRESET-FIELDS.md)와 CBS 함수 목록(`CBS-REFERENCE`)을 읽고 Uimori가 지원하는 범위 안에서 코드를 고쳐요.
- **앱 사용 설명서 읽기**: 도우미는 Uimori의 사용 설명서를 찾아 읽을 수 있어요(`guide.read`). 기능이 있는지, 어디에 있는지, 앱이 스스로 하는 동작이 무엇인지 물으면 설명서를 확인하고 답해요.
- **이야기 UI 블록**: 장면의 화면 블록을 쓰거나 고칠 때는 본문 모델이 받는 이야기 UI 참고문을 먼저 읽어요. 고친 블록이 변환에 실패하면 쓴 그대로 저장되고, 도우미는 저장 결과에서 사유를 확인해 다시 고칠 수 있어요. 답변 안에서는 장면용 화면을 미리 보여 주거나, 인물 관계도·차트처럼 Markdown으로 그리기 어려운 것을 보여 줄 때만 `<a2ui>` 블록을 써요. 답변의 화면은 읽기 전용이라 버튼 선택을 보내지 않고, 카드 그림(`{{img::이름}}`)은 나오지 않아요. 답변을 복사하면 원문 편집에 붙여 넣을 수 있는 `<a2ui>` 원형이 복사돼요.
- **실시간 웹 검색과 모델 단가 갱신**: Responses, Anthropic, Codex와 Gemini 4(AIS, Vertex) 환경에서 실시간 웹 검색으로 최신 정보를 찾고 출처 링크를 제공해요. 공식 출처(HTTPS URL 및 확인일)가 확인된 모델과 판단 프로바이더의 토큰 단가도 갱신해요(`model.pricing.update`). 단가는 사용자가 알려 주거나 도우미가 직접 읽은 공식 출처에서만 가져오고, 바뀐 단가는 앞으로의 호출에만 적용돼요. 가격이 없을 때 실행돼 비용이 미확인으로 남은 지난 호출에는 요청하면 지금 가격을 적용해 추정 비용을 채울 수 있어요(`model.pricing.backfill`, 또는 단가를 저장하면서 함께). 판단 호출도 같은 판단 프로바이더·모델의 단가로 채우며, 이미 가격이 기록된 호출은 그대로 두고 다시 실행해도 바뀌는 것이 없어요.
- **Vertex 위치 관리**: Google Vertex 연결의 현재 위치를 확인하고(`vertex.location.read`), 모델 하나를 여러 위치에 짧게 시험해 응답 시간을 비교하고(`vertex.location.compare`), 사용자가 요청하면 연결의 위치를 바꿔요(`vertex.location.update`).
- **콘텐츠 이미지와 삽화 도구**: 서재에 저장된 콘텐츠 이미지와 CHARX 에셋을 조회하고(`image.read`), 외형 프로필(`illustration.profiles.*`)과 삽화 컷 생성·재렌더링·배치(`illustration.cut.*`, `illustration.generate`)를 제어해요. 전역, 봇, 채팅별로 쓸 삽화 프리셋도 골라요(`illustration-preset.select`).
- **Linux 데이터 작업 공간 (`data.exec`)**: Linux runner가 켜져 있으면 격리된 컨테이너에서 bash, ripgrep, jq, Python을 사용해 대규모 검색과 가공을 수행하고 CLI(`uimori call`, `uimori apply`)로 앱 도구를 다뤄요. 채팅을 내보내면 독자 화면의 번역문도 읽기 전용 파일로 함께 받고, 최근 장면의 원문·번역문 반복 표현을 찾는 `tools/repetition.py` 같은 기본 스크립트를 그대로 쓰거나 고쳐 쓸 수 있어요. 셸 호출 시간은 도우미 작업 시간 제한 안에서 원하는 만큼 정할 수 있어요.

## 안전장치와 확인

- **확인이 필요한 작업**: 되돌릴 수 없는 삭제(서재 자료, 채팅, 옵션 프리셋, 삽화 컷, 글꼴, 팔레트, 모델)는 실행하지 않고 답변 아래의 확인 카드로 물어요. 여러 자료를 한꺼번에 고치는 작업과 채팅 전용 로어 삭제는 바로 하고, 변경 확인 줄에서 되돌릴 수 있어요. **설정 → 역할별 모델**의 **유료 생성 전에 확인**을 켜면 다음 장면 요청, 번역 요청, 삽화 생성과 다시 그리기도 같은 방식으로 묻고, 작업 다시 시도는 다시 하는 작업이 이런 유료 생성일 때만 물어요(도우미 작업을 다시 시도할 때는 묻지 않아요). 삽화 생성 카드에는 그릴 장수가 나오고, 한 번에 10장까지 예약해요. 확인하면 입력창에 진행 요청이 들어가고, 보낸 요청에서만 그 작업이 실행돼요. 거절하면 아무 요청도 보내지 않아요.
- **명시적 수정 요청 시에만 저장**: 사용자가 검토나 추천, 제안을 요청한 경우에는 저장하지 않고 검토 내용만 안내해요. 실제 수정을 명시적으로 요청했을 때만 저장 도구를 실행해요.
- **수정 번호(Revision) 및 해시 기반 충돌 방지**: 자료나 장면을 수정할 때 항상 변경 전 수정 번호와 텍스트 해시를 검증해요. 다른 화면이나 외부에서 먼저 내용이 바뀌었다면 저장을 차단해 덮어쓰기 사고를 막아요.
- **미저장 편집기 초안 보호**: 기기 편집기에 아직 저장되지 않은 초안이 열려 있는 자료도 도우미가 고칠 수 있어요. 도우미가 고치는 것은 저장본이고 초안은 편집기에 그대로 남아요. 편집기는 저장본이 바뀌었다고 알리고, 그 상태로 저장하면 덮어쓰지 않고 바뀐 저장본을 먼저 보여 줘요. 초안을 먼저 저장했다면 도우미의 저장은 수정 번호가 맞지 않아 거절되고, 도우미는 새 저장본을 다시 읽어요. [저장하지 않은 입력이 있을 때](EDITING.md#편집기에서-도우미에게-묻기)
- **편집 중인 위치**: 편집기에서 도우미를 부르면 지금 보는 영역과 항목, 칸, 선택한 글, CBS 오류 위치가 함께 가서 도우미가 위치를 찾는 단계를 건너뛰어요. 이 위치는 참고 정보일 뿐 도우미가 고칠 수 있는 범위를 넓히거나 좁히지 않아요. [편집기에서 도우미에게 묻기](EDITING.md#편집기에서-도우미에게-묻기)
- **읽기 전용 조회와 격리된 작업 공간**: SQL 조회와 정규식 검색은 읽기 전용 연결로, 짧은 시간 제한 안에서만 실행돼요. Linux runner에는 앱 데이터베이스, 앱 환경 변수, 자격 증명이 연결되지 않고 전용 작업 공간 볼륨만 공유해요. 인터넷에는 앱과 분리된 전용 네트워크로 나갈 수 있어서 스크립트가 자료나 패키지를 내려받을 수 있지만, 작업 공간의 원고도 외부로 보낼 수 있다는 점은 알아 두세요.
- **영수증 기반 추적과 불확실한 재실행 방지**: 도우미의 저장은 트랜잭션 내에서 고유 영수증(`receiptId`)을 남겨요. 응답이 중간에 끊겨도 완료된 저장은 기록에 남으며, 불확실한 외부 쓰기나 실패한 작업을 자동으로 재실행하지 않아요.
- **작업 중 지침 추가와 작업 되돌리기**: 작업 진행 중에는 **현재 작업에 추가**로 새 지침을 보낼 수 있고, 작업이 끝난 뒤 답변 아래의 변경 카드에서 그 작업이 바꾼 서재 자료, 장면, 플롯, 작가 노트를 작업 전 상태로 되돌릴 수 있어요. [도우미 변경 되돌리기](EDITING.md#도우미-변경-되돌리기)

## 관련 문서

- [전체 기능과 사용 안내](USAGE.md)
- [자료 편집과 저장 동작](EDITING.md)
- [서재 안내](LIBRARY.md)
- [작업 진단과 실행 내역](DIAGNOSTICS.md)
- [사용량 보고와 단가 안내](USAGE-REPORT.md)
- [도우미 첨부 파일](HELPER-ATTACHMENTS.md)
- [삽화와 외형 프로필](ILLUSTRATIONS.md)
- [원작 참고와 메모](STORY-GUIDE.md)
- [Risu Lua 트리거 API](RISU-LUA-API.md), [Risu 실행 순서](RISU-RUNTIME-INTEROP.md), [Risu 프리셋 필드](RISU-PRESET-FIELDS.md)

---

## 도구 동작 세부 안내 (English)

아래는 도우미가 도구를 부르거나 사용자 질문에 답할 때 참고하는 동작 세부 사항과 적용 범위예요.

### General tool discovery, CLI and results

Behavior the descriptions leave out:

- The helper's scope (chat or library) only orders discovery results: it breaks ties between equally ranked candidates and, in a library helper, lists chat operations last in the catalog. It never hides an operation, because a library helper reaches chat operations by passing `chatId`.
- The frozen story reads `story.search` and `story.read` are listed only in a read-only outline review. Other tasks find scenes with `chat.read`, `scene.search` and `scene.read`, which read the live chat and number only the visible scenes, so one task never sees two numberings of the same story.
- The helper request data already carries, as of the task start, the chat's title and revisions, its settings, effective main model and prompt, original-work reference state, folder, author notes and the latest scene with the guards a `scene.patch` needs, a reader selection with the same guards, the target intent of a selected outline item, and the date `usage.read` counts as today. The model is told to use these instead of reading them again.
- A candidate that covers every query word ranks ahead of partial matches, and partial matches stay in the list instead of emptying it.
- BM25 length normalization is deliberately mild, so a long description of a complex operation is not ranked below a short one for its length alone.

### Stored content images

Behavior the descriptions leave out:

- There is no separate cap on how many images a task or a call may read. The context and transport budgets are the limit.
- Viewed pixels live only in the running task's memory; stored events, attempts and continuation state hold references and metadata. A context compaction shows the pending pictures to the summarizing model once and then releases them.
- Each connection type sends the picture in its own provider image format. Only a model known to be text-only is refused before the read.

Outside these operations:

- Images in an unsaved editor draft, the image versions an older chat still pins, and attachments on a helper message ([도우미 첨부](HELPER-ATTACHMENTS.md)). `image.list` and `image.read` use the current saved library content.

### Illustration appearance profiles

Outside these operations:

- The shared default profiles of a bot or persona. They are library data, saved through `resource.patch` at `source.appearanceProfilesPath`. `illustration.profiles.save` never writes them: editing an inherited profile stores a chat-local override. [인물 외형과 참고 이미지](ILLUSTRATIONS.md#인물-외형과-참고-이미지) describes how a chat inherits and restores the defaults.

### Work with generated illustrations

Outside these operations:

- Generators, queueing, limits and how the Reader shows illustrations. See [장면 삽화 생성](ILLUSTRATIONS.md).

### Conversation history and task results

Behavior the response types leave out:

- A receipt without a compact outcome is counted in `unrecordedOperations`. Its changes are unknown; they are not reconstructed from tool arguments or message text.
- An outcome confirms a commit that happened, not the target's current state. For `scene.request` and `scene.translate` it confirms that the work was queued, not that it finished.
- `usage.toolExecutions` counts recorded `tool.finished` events, so a callback interrupted before it finished is not counted.
- `usage.latestInputEstimate` is the last stored local estimate. It is not a percentage and says nothing about a native agent's current context.
- `usage.latestInputParts` splits that estimate into the request parts the runtime measured before sending, and `usage.latestInputExecution` says whether a provider tool loop or a native agent ran it. The composer indicator draws a budget bar only for the provider loop, marks automatic compaction at 85%, and lets the user trigger manual compaction for provider-loop conversations (refused while a task or compaction is active or on native Codex).
- A change entry is the net difference between a target's state when the task first touched it and its state after the task's last write to it, however many calls wrote it. It is not the target's current state: a later user edit does not change the entry. A target whose net change is empty has no entry.
- Library resources, scene originals, translations and titles, the outline and author notes carry a diff. Settings (`chat.options`, `chat.variables`, `chat.storyGuide`, model, theme and global settings) and chat-only lore carry only the action and target. Illustration, scene request and translation request operations record no change entry; their outcome stays in `results`.
- A resource entry compares the authored native source, images, kind, loading and related items, not the projections regenerated from them, and list items (lore, prompt blocks, translation terms) are aligned by content, so removing one entry does not show every later entry as changed.
- `location` is structured data named in the UI language using the editor, reader, and outline section labels. Names the user wrote pass through unchanged, and a path with no display name is shown as an identifier. An entry recorded with an earlier Korean string keeps it and is shown as stored.
- An entry whose text was removed has `textRemoved` and no `location`, `diff` or `anchor`: `deleted` after the scene or resource was deleted, `expired` outside the retention in [도우미 변경 기록](DELETION.md#도우미-변경-기록). A target the task deleted is listed without an anchor.
- One response carries at most 200,000 characters of diff text; later diffs come back as omitted for size.

Outside these routes:

- A second undo history. Turn rollback reads the same records; the editor's resource undo and draft protection keep their own contracts.

### Rolling back a helper task

Behavior the types leave out:

- A unit is one target: one resource, one scene (its original and translation together), the outline of a chat or the author notes of a chat. A scene's translation is not rolled back apart from its original, because an earlier translation belongs to the earlier original. `changeTargetIds` names the change entries a unit covers; a scene unit can also cover a hidden translation record with no entry, kept so that a source-only edit can give back the translation it made stale.
- Covered are library resources, scene originals and translations, the outline, author notes and chat-only lore. A chat-only lore unit is one lore field of one chat: rollback brings back the override that field had before the task, or removes the one the task added, so a removed override comes back. Scene titles, settings, chat variables, the original-work reference, illustrations and requested scenes or translations come back as `not-covered` with `other-domain`. A resource the task created or deleted is `not-covered` with `created` or `deleted`; deletion also removes the baseline, so a deleted resource cannot come back through rollback.
- `changed-since` means the target differs from the state the task left (`changed-after-task`) or someone else saved it between two writes of the task (`changed-during-task`). The comparison covers the whole target, so any later edit of a chat's outline or notes blocks the rollback of that chat's outline or notes. For library content it covers the card source and the package settings (`contentPackageSettings`: portrait image, modules, lore activation, image handoff) in full, because a restore writes the whole saved model back; the change entries show only the owner-set part of those settings (the lore selection mode and the enabled image-handoff ranges that exist on both sides), so lore activation or handoff ranges that appear or vanish with a card edit do not add entries; a record whose result hash covers only the card state is compared by that hash and by those settings being the same as in its baseline. Outline and notes are compared by content and tree position, not by IDs, because a rollback writes them back as new nodes and notes; an earlier task can therefore still be rolled back after a later one.
- A rolled-back unit stays `restored`: repeating the request, also after a lost response, writes nothing again, even if the target was edited after the rollback.
- `touches` names what a restore would write so the client can stop or warn before an unsaved draft is overwritten. The server cannot see unsaved editor input. A resource restore goes ahead under an unsaved resource editor, because it writes the saved revision and the editor keeps its draft as a conflict ([저장하지 않은 입력이 있을 때](EDITING.md#편집기에서-도우미에게-묻기)); scenes, the outline and notes still wait for their editors.
- A scene restore saves the original first and then the earlier translation against the restored original, through the same `editSource` and `editTranslation` as the Reader. Translation illustration placement is not restored, which the unit reports as the notice `translation-images-not-restored`.
- An outline node or a note the task deleted is created again with a new ID, and a restored note carries the author `도우미 변경 되돌리기`. A restored imported memory takes its origin from the stored note it replaces. A restore through the outline save is refused when a node the task created has been written since.
- The outline save checks every operation against the tree as it stands, and a parent must be a larger level than its children. An outline restore therefore runs in three saves: it moves each node whose parent or level changed to the top, removes the nodes the task added and sets the earlier levels; then it creates the deleted nodes again; then it moves each node back under its parent and position and restores titles, intents, pins and related nodes. The intermediate saves only change the plan of nodes whose final plan also differs, so a scheduled scene is cancelled exactly when its final path, children or related nodes differ from the current ones, as with any outline save.

### Plan mode

- The refusal uses the classification that decides whether the dispatcher records a receipt and a change, so there is one list. The receipt refusal is the backstop for a save that does not pass the tool gate, such as `uimori apply` inside `data.exec`; a plan task therefore records no change and has nothing to roll back.
- Discovery still lists the operations that write, so a plan can name the operation and arguments it would use.
- Carrying out a plan is an ordinary request that refers to it. The server keeps no link between the plan and the request that runs it, and a retry keeps the mode of the task it retries.

### Confirmation before deletion or paid generation

- The runtime cannot pause a tool call for an answer: an HTTP provider loop and a native Codex turn both expect the result. So a held call is refused without effect, the task finishes its turn, and the owner's next request carries the grant. Everything is in the database (the event, the task snapshot and a `confirmation.used` event), so a reload or a restart loses nothing, and declining is just a request without the grant.
- A confirmation is bound to the conversation, the chat the call acts on, the operation and its exact arguments, revision guards included. A grant is consumed when the confirmed call is dispatched, even if the save then fails, and a replay of the same call identity does not consume it twice.
- The granted request lists the confirmed calls in `source.confirmedCalls`, because the next task does not see the earlier tool calls and must repeat the arguments exactly.
- Only a confirmation required by the conversation's latest task can be granted (`CONFIRMATION_UNAVAILABLE` otherwise), so a grant never revives an old request. A retry keeps the grants of the task it retries.
- A plan-mode request cannot carry a grant (`HELPER_PLAN_CONFIRMATIONS`): plan mode refuses every write, so the grant would be spent on a task that cannot run the call, and the arguments are released as soon as that later task exists. The composer therefore switches to apply mode when the owner confirms a held call, and switching to plan mode removes the pending grants; the card offers the confirmation again.
- The same call identity can be held again in a later task, for example after a granted call failed. Each holding task is answered on its own: its `grantedBy` names only a task after it, so an earlier grant neither marks the new hold as granted nor hides it, and the client keys a decline by task and confirmation.
- Deletions that turn rollback cannot undo are always held. Changes that rollback can undo, such as a `resource.patchMany` over many resources, run at once and are reviewed and undone in the change review strip. With paid-generation confirmation on, `task.retry` is held only when the retried task generates paid output: a writing run, a translation or picture job, or an illustration, not a helper task. The confirmation setting is copied into the task at admission, like the task timeout, and the helper's own `settings.update` cannot change it.
- The results view does not expose the held call's arguments.

### Choice question cards and `@` target references

- `helper.ask` is a read-only tool available in both `apply` and `plan` modes. Like confirmations, it never blocks an open provider loop: it records a durable question event and ends the turn cleanly; the UI renders clickable options on the latest task and submits the chosen label as the next ordinary user message.
- `@` target references store only `{ kind, id }` pointers in the task snapshot—never mutable titles or prose—and resolve live metadata on read and in `source.referencedTargets`, so deleted scenes and resources drop cleanly.

### Linux data workspace

Behavior the descriptions leave out:

- A command runs without stdin, so it cannot prompt.
- `uimori export` with a `scope` and neither `id` nor `all` only rewrites the catalog of that scope from the saved data.
- Translation copies under `chats/<id>/translations/` are written once, at the first export of the chat. They are neither apply nor refresh targets, and a repeated export or a later translation save leaves them unchanged. `originalSha256` in `translations.json` is the hash of the original as exported, so a working original with another hash means the copy translates the earlier text.
- In the result of a resource apply, `changedPaths` lists where the saved model differs from the previous saved model, and `normalizedPaths` where it differs from the submitted file, which is what the save normalized. Each list holds at most twenty paths, `changesTruncated` and `normalizationTruncated` mark omissions, and neither list counts the automatic package revision of content.
- Before any export, the workspace already holds `usage/recent.jsonl`: the 500 most recent model attempts across all chats, with role, model id, status, token counts and cost. Like the rest of the workspace, a script can send it out through the runner's network.
- A task's directory is removed when the task ends, so working copies and `outputFile` logs do not outlive it.

Outside these operations:

- Background work. A command's children are stopped through its process group; a process that deliberately leaves the group is not a supported way to keep work running.
- Merging. `uimori refresh` does not merge a draft with the latest saved data and writes nothing to the database.
- Cleanup after a crash. A process crash can leave task directories behind for manual cleanup.

### Search and partial reads

Behavior the descriptions leave out:

- Search reads raw authored fields. It does not execute native CBS or Lua and does not infer facts from scripts.
- Each resource is searched through one authored representation: the native `card` and `module` of a bot, persona or module, and the `program` and `values` of a prompt preset. Derived copies of the same text, such as `content.text` and `package.body`, are not fields, so one passage yields one hit.
- Within a bot, persona or module, fields are searched in this order: description, personality and scenario; lorebook entries; other fields; extensions and assets. The order decides which matches reach the first page.
- A library result carries `metadata.category`: the kind for a bot, persona or module, and `main` or `translation` for a prompt preset, whose kind is `prompt`.
- In `scope:"chats"`, a scene inherited through a fork appears under every chat whose ancestry contains it, numbered within that chat. The source ID and `chatId` together identify a result, which is why `chatId` travels in the ref and into a narrowing search.
- An excerpt is at most 2,000 UTF-16 units. The `following` text of the first two excerpts uses only the page budget left after the page is filled, so it never changes which items a page holds or its `nextOffset`, and it stops before the next excerpt of the same field. An answer often sits just past the matched phrase, and this saves the `data.read` round that would continue the excerpt. A `data.read` batch and a field directory page each stop at about 16,000 serialized characters; `nextIndex` and the directory's `nextOffset` report what was left out.

Outside these operations:

- The editor target. [자료 편집과 저장 흐름](EDITING.md#자료-편집과-저장-흐름) describes how a saved reference or an unsaved draft is captured at admission, and the target is context, not a permission boundary ([도우미와 과거 가정 장면](USAGE.md#도우미와-과거-가정-장면)). The prompt library card action **도우미에게 묻기** sets a saved reference for the next request without changing the scope of the library conversation; opening a prompt editor, leaving the prompt library or clearing the target removes it.
- Reader selections. **도우미에게 물어보기** sends the whole selected passage as the task's `selection`, not as a search result, and keeps it whole across later turns.

### Editing saved scenes

Behavior the descriptions leave out:

- Saving an original compiles any `<a2ui>` Story UI blocks before storage, so the stored text differs from the submitted text when it holds an `<a2ui>` block. The receipt's `expectedTextHash` is the hash of the stored text, and `storyUiFailures` lists the blocks that were saved as written because they did not compile. `scene.restore` passes stored fences through unchanged, and rollback does not compile.
- `scene.read` returns stored text before any CBS display transformation as well as before HTML rendering.
- A regex `scene.search` ignores zero-width matches.
- A whole-chat `scene.search` reads only scenes the selected chat owns. `excludedScenes` counts the rest of its ancestry: scenes inherited from a fork parent, and disabled scenes unless `includeDisabled` is set.
- Translation reads use the same completed-result projection as the Reader, so an earlier completed translation stays readable while a new attempt is pending. The identity of that displayed result is distinct from the latest revision, which is what a save conflict checks.

Outside these operations:

- Saving a `translation` together with an original edit keeps that reviewed translation current. It does not make arbitrary original edits semantically safe for translation reuse.
- Older text that a task still pins is not exposed as an editing archive.
- Automatic retranslation, scene titles and persistent writing options.
- Unsaved Reader drafts. Scene tools neither read them nor track them across tabs, and when a helper edit changes the saved base of a draft, the existing conflict UI keeps the draft and asks for reconciliation. See [도우미 본문 편집](EDITING.md#도우미-본문-편집).

### Read-only SQL

Behavior the descriptions leave out:

- A query that names `sqlite_master`, `sqlite_schema` or a `PRAGMA` is answered with the view schema instead of an authorization error. Production tasks spent whole rounds trying those before finding the schema call, and the answer exposes nothing beyond what a call without `sql` returns; the tables behind the views stay unreadable.
- `agent_messages.request` is the request stored with the scene's run, or the edited request text when the scene has one, and is NULL when the request is disabled for that scene. It does not reproduce what native scripts later projected from that request.
- A row set also stops at about 16,000 serialized characters, so `truncated` can be true below the row limit.
- An integer outside JavaScript's safe range is returned as a decimal string, and a binary value as its byte count without the bytes.

Outside these operations:

- Native Codex tool callbacks stay serialized; the concurrent group of adjacent read-only calls applies only to the HTTP provider tool loop.

### Discovering and executing app operations

Behavior the descriptions leave out:

- An explicit `chatId` runs that one call against the named chat and leaves the conversation's default scope unchanged. For an operation that consumes story or reference context, ancestry or a writing head (`writing` in `helperToolTraits`), the host prepares a writing snapshot of that chat at call time. A call without `chatId` keeps the task's original reservation.
- `data.search` and `data.read` address bot, persona and module fields by the editing path that resource operations take, such as `/package/nativeRisu/module/lorebook/0/key`. A `paths` filter or a ref written in the older source-relative form (`/module/lorebook/0/key`) is read as the same field. Search kind `prompt` is editing kind `prompt-preset`; an `editTarget` carries the editing kind together with the path.
- A prompt-preset overview carries the native Risu name as `nativeName`. A name longer than 200 UTF-16 units appears as `nativeNamePreview` with its length and exact read path instead.
- A `target` is the item's indexed path at the revision that was read. It is not a persistent ID, and array positions do not identify entries across revisions.
- Toggle reconciliation keeps a stored choice index that is still valid, even when reordering the choices changed what it means. `preset.validate` reports such changes against the retained previous save.
- `preset.validate` does not lint CBS by running the pinned RisuAI evaluator, because that evaluator tolerates some incomplete tags, reparses dynamic expressions and can write variables.
- `image.update-metadata` targets the content that owns the image. `prompt-workspace` always targets `current`, whatever `id` the call passes, as `resource.save` does.
- A task's request data carries `source.knownOperations`: a bounded set of definitions for the operations the request points to (a reader selection, an editor target, a selected outline item or `@` targets) and the operations that earlier tasks of the conversation already called, so a task can call them without an `app.tools` round. The definitions come from the running build, never from a stored result. A review or plan task receives only the operations it may run, and schemas that were looked up but never called are not carried. The selection is fixed when the task is admitted and sits in the request data rather than changing the tool list.
- The `nextRead` of a `HELPER_READ_TOO_LARGE` result names a provider tool, so the model can invoke it unchanged in the next round: `app.call` with nested `name` and `arguments` for every app operation, including `data.search` and `data.read`, and `data.exec` for shell output.

Outside these operations:

- Complete models. Bounded pages and compact receipts apply to helper reads and results only; UI, backup and export views keep returning complete models, and stored chat-lore undo and conflict data stay complete.
- Replacing arbitrary objects or a root with `resource.patch`. `set` takes a scalar or an array of scalars, apart from the three whole values its description names.
- A history of library resources. One previous save is retained per resource, and cloned presets are not kept synchronized; see [도우미를 통한 본문과 자료 편집](EDITING.md#도우미를-통한-본문과-자료-편집).
- Independent-scene generation and editing. There is no `artifact.generate` operation and no artifact editing; `artifact.read` only reads saved revisions. A different story direction uses `chat.fork` and then normal chat writing, which `scene.request` can send. Forking does not start generation.
- New device-local artifact edit drafts. Drafts saved earlier stay readable and copyable in the artifact card, and they are removed only together with their conversation's local recovery data.
- Sending a recovered request automatically after a reload.

### 도우미 대화와 과거 분기

seed 대화문은 역할·본문·첨부만 담아요. 이전 모델 시도·사용량·도구 실행·변경 영수증은 옮기지 않으므로 다시 실행하지 않고, 이어지는 작업은 필요한 자료의 현재 저장 상태를 새로 읽어요.

### Activity and additions to a running task

What the recorded states mean:

- A `delivered` addition was placed into the execution input. It does not show that the model followed it.
- The call limits are observable host boundaries on model requests and tool callbacks. They are not a money cap and do not measure native Codex internal sampling.
- Activity records explain execution, not model reasoning or the quality of an answer.

- An addition is text only. The task keeps its model, captured materials and read-only review mode.
- On HTTP providers an addition does not interrupt a tool that is already running; only calls that have not started are skipped.
- Pending and unconfirmed additions are never replayed, neither automatically nor by a retry. A retry of the unchanged request carries the delivered additions.

### Original-work reference and authored notes

- `context.read` returns the settings, not a generated brief. A previously generated brief is not a source of story facts. Its `storyGuide` section can be read alone, without the summary and notes.
- Neither a helper answer nor an automatic brief creates a branch ledger.
- **Risu 작가 노트** is not an event log or proof of what a character knows. [이야기 기억과 컨텍스트·메모](USAGE.md#이야기-기억과-컨텍스트메모) separates it from **메모·정정**.

### Risu code checks

Behavior the descriptions leave out:

- The checks read the saved revision. Unsaved editor input is not checked; save it first.
- Each check covers the one resource it names. A bot's attached modules, the chat's prompt preset and chat variables can add regex scripts, triggers, toggles or values that the check does not see.
- `code.regex` and `code.preview` run the same CBS, regex and Lua evaluation that chats use, on a copy, so functions such as `{{random}}` can give a different result on each call.
- The `lua` section of `code.diagnose` only compiles each chunk. A chunk that compiles can still fail when it runs, for example when it calls a function that does not exist.
- The compatibility section lists what Uimori refuses or ignores. Something it does not list can still behave differently from RisuAI.
- Deprecated card and preset fields are not reported: saving already removes them.

### App guides

- `CBS-REFERENCE` is built from the CBS function list of the running evaluator when the guides are first read after the app starts, so it matches the version that evaluates the code.
- The guides are Korean prose with English identifiers, and the helper may think in either language. Search therefore matches by section, not by line, falls back to the sections that hold only some of the words, and attaches guidance that an empty or partial result is no evidence that a feature is absent. There is no translation or synonym table: the description tells the model to query with the Korean wording of the user or the interface, and the guide list carries the Korean titles to choose from.
- The helper contract tells the model to check the guides before it says the app lacks a feature. It exists because a production helper answered that thought summaries were not a feature: its tools and settings showed none, and the display is interface behavior that no tool controls.

### Web search and model pricing

Behavior the descriptions leave out:

- `source.currentDateUtc` in the helper request is the UTC date on which the task was created, not the date of each model request. `source.usageDate` is the same moment as a date in the calendar `usage.read` counts in, so "today's cost" asked early in the morning does not land on the previous day.

- Gemini 4 helpers on Google AI Studio and Vertex use `web.search` as a read-only provider-facing tool. Each invocation makes a separately recorded and billed search-only request to the **same configured Gemini model and connection**, then returns grounded text and verified source URLs to the helper. The separate request counts against the task's model-call budget and receives only the search query, not the full private conversation or library content. The helper decides when to search, including during read-only review.
- Grounded responses can include Google Search Suggestions. Uimori does not keep or display them; only the source links are returned to the helper and shown to the user.
- A separate search costs an additional Gemini invocation and any Google Search grounding fee. Lack of a performed search or verified source must not be presented as grounded evidence.

Outside these operations:

- Adapter support does not establish that a particular model or account searched successfully or that a result is current. The adapter tests are synthetic; they are not live-search, provider-account or billing evidence.
- Search-tool fees can be absent from token-rate estimates. See [추가 집계 규칙과 단가 소급 적용](USAGE-REPORT.md#추가-집계-규칙과-단가-소급-적용).
- The original-work reference step has its own search capability, `storyGuideWebSearchCapability`, which also covers Gemini and Vertex. See [Original-work reference](STORY-GUIDE.md).

### Requesting the next scene or a translation

- A chat whose run is already queued or running returns `SCENE_REQUEST_BUSY` before the conflict checks, so the helper reports it instead of sending the request again.
- With `helperConfirmPaidGeneration` on, both operations first wait for the owner's [confirmation](#confirmation-before-deletion-or-paid-generation).

Outside these operations:

- Reference images and lore-selection reset are composer-only.

### Next request preview, scene lore and chat variables

Behavior the descriptions leave out:

- In a `chat.preview` list, lore, excluded prompt blocks and compiler warnings appear on the first page only.
- Image and file parts of a previewed message appear as `[image]` and `[file]` placeholders.
- Without a main model, or when preparation fails, `chat.preview` returns only the preview metadata and its error.
- A `chat.variables.update` that changes nothing writes nothing and still checks both guards.

### Fixed options, scene names, original-work reference and model parameters

Outside these operations:

- Connections, credentials, execution mode, service tier and cache options stay outside `model.parameters.update`.

### Settings, diagnostics and task control

Behavior the descriptions leave out:

- After `settings.update` commits, the helper also publishes a `settings.updated` event on its own conversation. The browser refreshes open settings from that event, which is how a library helper with no selected chat updates them.
- In a helper task's tool diagnostics, `elapsedMs` covers one call's dispatch and result preparation, including the time it waited on its worker or provider, and excludes the time it waited for a sibling read to finish. `queueMs` is the time a native Codex tool call waited behind the previous call before dispatch. Calls can overlap, so summed times are not wall time.
- A save that changes nothing can still write a receipt, so it can appear in `committedEffects`.

Outside these operations:

- Unsaved settings and editor drafts keep their existing conflict behavior.
- What the recorded attempt and tool diagnostics cover, how long they are kept and what stays unknown for older tasks is documented in [문제 확인과 실행 상세](DIAGNOSTICS.md#진단-기록과-해석).

### Illustration presets

`illustration-preset.list` and `illustration-preset.guide` inspect presets, while reading, saving, undoing and deleting a preset go through the `resource.*` operations with `kind: illustration-preset` under their revision and receipt contract. A helper save neither selects a preset nor generates an image. [Illustrations](ILLUSTRATIONS.md#삽화-프리셋) documents what a preset holds, what stays outside it, when an edit takes effect, selection priority and portability.

### Bounded composition reads

Behavior the descriptions leave out:

- A writing whose scene is not in the chat's current history is returned as unavailable, without a reference. It is never matched to another scene.
- When an `outline.read` result does not fit the model's input budget, the refusal carries a `nextRead` for the same range with a smaller `limit`, not a library search.

Outside these operations:

- `coverage` reports what one response returned. It never certifies that a review was complete.
- `knowledge.search` with `mode: browse` is reachable through the same `app.tools` and `app.call` gateways, including in a read-only review. See [폴더를 따라 탐색](LORE-CONTEXT.md#폴더를-따라-탐색).

### Token budgets and isolated read processes

- The continuation of a page read without a limit carries no limit, so one page's measured length does not become a fixed character default.
- The isolated data, SQL and regex worker keeps its character pages, memory and time limits and IPC size guards, and does not tokenize. The host applies the token budgets to what it returns.
- Shell command and output byte limits and exact completed mutation receipts are separate from these token budgets.
