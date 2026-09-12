# 브라우저 검사 전수 점검 · 2026-09-09

`tests/*browser.spec.ts` 45개 파일의 테스트 본문과 fixture/호출/assertion 흐름을 읽고 판단했어요. 제품 변경은 이 문서 범위 밖이에요.

## 실행 경계

- 기본 기능은 대표 mobile 412px/desktop 2560px를 사용해요. 단일 환경에서 의미 있는 기능은 중복 복제하지 않아요. draft/CAS/중복 명령/읽기 위치/focus/접근 행동/넘침은 기본이에요.
- `tests/fixtures/visual-review.ts`의 `NR_VISUAL_REVIEW=1`에서 추가 폭 sweep, 정확한 정렬/크기/아이콘 형태, 성공 PNG를 실행해요. 실패 trace/reporter는 공통 실행기 소관이에요. 일부 기존 PNG 이름의 360은 유지했지만 기본 기능 폭은 412px예요.
- 일부 제목의 six widths/compact/screenshots 표현은 runner case 식별을 보존하기 위해 남겼어요. 실제 범위는 코드 조건을 기준으로 해요. P01의 prompt-owned 제목과 달리 assertion은 현재 workspace/Run snapshot을 확인해요.
- self-host는 별도 조건이에요. 합성 검사는 live provider 품질/OAuth/요금/실기기/운영 배포 증거가 아니에요.

## 통합과 제거

| 원래 검사 | 결정 | 남는 증거 |
| --- | --- | --- |
| PLR01 picker | LIMG02 흡수 | bot/module 제외, persona/none, 폴더/keyboard/Escape |
| PLR04 기본 본문 가시성 | PLR03 흡수 | 모든 역할 가시성 뒤 저장 AST/preview 이름 |
| PKUI02 역할·prompt 분리 | PKUI01 흡수 | 현재 역할, prompt/library 탐색, relatedIds와 lore/지침 저장 |
| DEL04 구형 kind POST 반복 | 기존 단위/통합 검사로 통합 | library-organization.test.ts의 old standalone content kinds are rejected at creation and archive restore; UI 삭제는 유지 |
| PLR03 preview 접기 반복 | 제거 | PUNI02 snapshot input/result 보존 |
| UI08 임의 15회 Tab | common-dialog 경계 검사로 통합 | Shift+Tab containment/Tab 복귀/닫기 후 opener focus; IME/caret 유지 |
| PRUI01 외부 prompt 소속 fixture | 구형 가정 제거 | 역할별 조합/template draft 보호 |
| PMUI01 고정 검토일 | 날짜 형식 검사 | 검토 metadata/옵션 저장 |

## 파일별 현재 case 또는 계약 그룹

### `tests/model-pricing-browser.spec.ts`

PRICEUI412·PRICEUI2560은 공식 요금·Flex 표시, 직접 입력의 무료 0/미확인 빈칸 구분, 저장·재조회·공식 복원과 잘못된 입력을 확인해요. PRICECOST01은 합성 비용 응답으로 공급자 보고 비용과 추정 금액의 분리, 캐시 항목·부분합·미확인 및 본문 안내를 412/2560px에서 확인해요. `npm run verify:pricing`으로 실행하며 실제 계산·저장·전송은 pricing 단위·통합 검사 소관이에요. 실제 청구액의 증거는 아니에요.

### `tests/activity-browser.spec.ts`

ACTUI01 수락 이후 경과/접기/다음 작업/만료, ACTUI04 수락 이전 타이머, ACTUI02 보조 병렬 작업/연결 불확실, ACTUI03 실패 잔류/취소 만료/탐색, ACTUI05 오래된 실패 역전을 각각 유지해요. 응답별 TURNUI와 대상 상태가 달라요.

ACTUI06은 30개 밖 누적 알림·일괄 확인·새 오류와 회차·새로고침 보존, ACTUI07은 원문/hash별 번역 성공 정리·상세 조회 성공/실패의 확인 경계, ACTUI08은 과거 조회의 진행 상태가 최신 reader에서 제거된 뒤 부활하지 않는 경계를 확인해요. 모바일·데스크톱 알림 목록 PNG를 함께 남겨요.

- 유지: `ACTUI01 elapsed time, collapse, next task and completion expiry`
- 유지: `ACTUI04 sending timer starts before admission and continues after accepted request`
- 유지: `ACTUI02 auxiliary concurrency, mobile bounds and connection uncertainty`
- 유지: `ACTUI03 failure persists, cancellation expires and chat navigation does not replay completion`
- 유지: `ACTUI05 old failure does not replace a later completion or cancellation`

### `tests/agent-collaboration-browser.spec.ts`

AGENTUI01 불완전 초안/undo/JSON 왕복, AGENTUI02 실제 로컬 preview API의 저장 옵션 전달과 번역 역할 분리를 유지해요.

- 유지: `AGENTUI01 collaboration stays editable through incomplete drafts, undo and JSON round trips at 412px`
- 유지: `AGENTUI02 saved collaboration options reach the real preview API and translation stays separate on desktop`
- 추가: `AGENTUI03`은 412/2560px에서 공통 스위치와 복수 선택의 모양·긴 라벨·가로 넘침, Space 조작과 독립 선택, 저장/재조회 및 boolean 미지정 버튼 제거를 검사해요.

### `tests/archive-compact-browser.spec.ts`

ACOM01 네이티브 선택/백업 행동, ACOM02 늦은 파일 읽기/선택 취소, ACOM03 상태 실패/점유 DB/쓰기 실패의 파일 보존, ACOM04 저장 성공 뒤 조회 실패의 중복 가져오기 방지를 유지해요. 입력/지우기 1px 정렬은 시각 검토예요.

- 유지: `ACOM01 backup choices and native file selection stay compact across desktop and mobile widths`
- 유지: `ACOM02 stale file reads cannot replace a later selection or restore a cleared draft`
- 유지: `ACOM03 status failure and occupied data block import, while a failed write keeps the selected file and local error`
- 유지: `ACOM04 an accepted import clears its file once even when the following library refresh fails`

### `tests/auxiliary-recovery-browser.spec.ts`

번역/상태 실패의 안전한 원인 표시와 현재 설정 상태 재생성을 유지해요. 일반 retry와 다른 진단/설정 계약이에요.

- 유지: `auxiliary failures show separate safe causes and recreate status with current settings`

### `tests/browser.spec.ts`

F02/F03/F05 다중 context/tab, 중복 명령/설정 CAS, source job 귀속/재연결/직접 SQLite 증거를 유지해요. 별도 F05는 나중 원문 선택 중 이전 보조 재시도, 마지막 F03/F05는 실 HTTP 역순 reader 응답이에요.

- 유지: `F02 F03 F05 two contexts and two tabs keep commands, snapshots, source jobs and reconnection isolated`
- 유지: `F05 failed auxiliary result retries independently while a later source is selected`
- 유지: `F03 F05 an older real HTTP response cannot hide a newly committed source`

### `tests/chat-prompt-options-browser.spec.ts`

조건부 창작 옵션의 초안/명시 적용/재조회와 경쟁 저장 CAS 뒤 초안 보존을 유지해요. preset CRUD와 다른 current workspace 투영 계약이에요.

- 유지: `chat creative options preserve drafts, apply explicitly and fit desktop/mobile`
- 유지: `creative option CAS conflict preserves draft and server profile`

### `tests/chat-settings-browser.spec.ts`

CSUI01 7개 섹션 접근/무쓰기, CSUI02 Back/리사이즈/명시 폐기, CSUI03 키보드/즉시 저장 읽기 설정을 유지해요. 6폭 반복은 기본 412/2560으로 줄였어요.

- 유지: `CSUI01 chat settings list and seven details fit six widths with accessible navigation and no writes`
- 유지: `CSUI02 section changes, browser Back and resizing preserve chat setting drafts until explicit discard`
- 유지: `CSUI03 keyboard navigation and clean browser Back keep immediate reading preferences without model calls`

### `tests/current-settings-browser.spec.ts`

CURRENTUI01 현재 prompt control 변경 시 조합의 유효값/기본값 보정과 새 채팅 선택 UI를 유지해요.

- 유지: `CURRENTUI01 saved creative combinations follow current prompt controls without revision choices`

### `tests/deletion-browser.spec.ts`

DEL01 자료 취소/CAS/참조 방어, DEL02 prompt/조합, DEL03 선택 채팅 URL/reader 정리, DEL04 persona/module UI 삭제, DEL05 모델 후 프로바이더, DEL06 현재 branch 삭제를 유지해요. DEL04의 구형 kind API 반복만 기존 library-organization 단위/통합 검사로 통합했어요.

- 유지: `DEL01 library cancel, stale revision, dependent bot and actual deletion at mobile width`
- 유지: `DEL02 prompt combinations and presets have deletion and removed prompt does not reappear`
- 유지: `DEL03 deleting selected chat clears reader and URL while preserving another chat`
- 유지: `DEL04 personas and modules remain deletable from their own categories`
- 유지: `DEL05 model is deleted before its connection and settings lists stay current`
- 유지: `DEL06 deleting the displayed branch returns to the default branch`

### `tests/evaluation-browser.spec.ts`

EVALUI01 desktop 저장/재연결/역할 선택, EVALUI02 mobile opt-in/해제를 유지해요. canvas 문자 측정과 고정 최소 폭만 시각 검토이며 containment는 기본이에요.

- 유지: `EVALUI01 desktop preset evaluation opt-in persists selected story roles after reconnect without model calls`
- 유지: `EVALUI02 mobile 412px evaluation controls save only for opted-in presets and can be disabled`

### `tests/lazy-panels-browser.spec.ts`

LAZY01 entry script 지연/JSON network 증거, LAZY02 settings 지연 중 원문/초안, LAZY03 chunk 실패의 지역 오류, LAZY04 library 실패 뒤 탐색, LAZY05 자료 API 실패 뒤 prompt 탐색을 유지해요. 실패 대상과 복구 경로가 달라요.

- 유지: `LAZY01 library entry defers settings and prompt authoring scripts`
- 유지: `LAZY04 failed library keeps desktop and mobile navigation available`
- 유지: `LAZY05 unavailable library data keeps prompt navigation usable`
- 유지: `LAZY02 delayed settings keep the reader and composer draft available`
- 유지: `LAZY03 failed settings script stays local and preserves unsent text`

### `tests/library-browser.spec.ts`

LIBUI01 분류/폴더와 내용 revision/소속 채팅 분리, LIBUI02 다른 탭 갱신/이동 CAS, LIBUI03 prompt 폴더/초안, LIBUI04 자료 종류/장착 역할 분리, LIBUI05 저장 성공 뒤 summary 실패를 유지해요.

- 유지: `LIBUI01 library folders move and classify without changing revisions or owned chats`
- 유지: `LIBUI02 mobile folder deletion refreshes another page and stale moves require review`
- 유지: `LIBUI03 prompts have independent folders and unsaved edits survive a cancelled navigation`
- 유지: `LIBUI04 role selection creates a chat with the selected persona and module without reclassifying them`
- 유지: `LIBUI05 accepted folder creation closes even when the summary refresh fails`

### `tests/library-compact-browser.spec.ts`

LCOM01 목록 행동/접근성/넘침, LCOM02 빈 종류/폴더/검색별 복구, LCOM03 선택/검색/보기 저장/resize/focus를 유지해요. 1px 정렬과 고정 y 위치만 시각 검토예요.

- 유지: `LCOM01 compact library keeps row actions aligned across mobile and desktop widths`
- 유지: `LCOM02 empty categories hide unused tools while empty folders and searches retain recovery`
- 유지: `LCOM03 selection replaces list tools and retains search and saved view across resizing`

### `tests/library-images-browser.spec.ts`

LIMG01 업로드/해제/기존 이미지/불변 revision, LIMG02 picker 키보드/폴더/중첩 Escape/채팅 미생성, LIMG03 취소/실패 뒤 저장, LIMG04 현재 공유 이름/이미지와 과거 증거, LIMG05 갱신 후 단일 선택을 유지해요. PLR01 bot 제외를 LIMG02에 흡수했어요.

- 유지: `LIMG01 representative image upload, unset and existing inline selection preserve immutable revisions`
- 유지: `LIMG02 persona folder picker supports keyboard selection and nested Escape without creating a chat`
- 유지: `LIMG03 cancelled and failed portrait uploads cannot change a saved draft or leave saving blocked`
- 유지: `LIMG04 shared module references show current names and portraits while preserving archived evidence`
- 유지: `LIMG05 quick persona selection shows one current selection after its image changes`

### `tests/library-usability-browser.spec.ts`

LUSE01 bot 목록 정보/생성/채팅 진입은 기본 412px, LUSE02 추가 360px 배치는 시각 검토로 옮겼어요. LUSE03 빈 persona/module 폴더의 맞는 생성 초안/무저장을 412px에서 유지해요.

- 유지: `LUSE0${index + 1} mobile ${width}px library starts with readable rows and creates a bot into a chat`
- 유지: `LUSE03 empty persona and module folders explain their roles and offer the matching creation action`

### `tests/loading-browser.spec.ts`

LOADUI01 bounded paging/deep link/위치, LOADUI02 CAS/다른 채팅 격리, LOADUI03 summary 후 본문 fetch, LOADUI04 offline/SSE, LOADUI05 summary 상태 무쓰기, LOADUI06 navigator, LOADUI07 긴 metadata 목록 검색/추적을 유지해요. 읽기 위치 오차는 기능 복원 검사예요.

- 유지: `LOADUI06 scene navigator jumps across bounded pages and remains usable in focus and mobile reading`
- 유지: `LOADUI01 bounded pages, previous/next, deep links and reload preserve reader position`
- 유지: `LOADUI02 same-source tabs keep CAS drafts and isolate another chat, manual translation stays local`
- 유지: `LOADUI03 large library uses summaries then fetches current content on click`
- 유지: `LOADUI04 offline edits reappear on reconnect and connected SSE sends only the changed source`
- 유지: `LOADUI05 context summary status fits mobile reader and run details without changing source or dispatching requests`
- 유지: `LOADUI07 synthetic navigation metadata covers long-list paging, search and visible-source tracking`

### `tests/lore-context-browser.spec.ts`

LCUI01 배치/order 초안과 폴더/로딩 분리, LCUI02 unsaved policy preview 무쓰기, LCUI03 응답 유실 중 일회 reset snapshot, LCUI04 더보기/chip/취소/일회 소비를 유지해요.

- 유지: `LCUI01 lore placement and invalid order drafts stay independent from folders and loading`
- 유지: `LCUI02 policy drafts survive tabs and preview reflects the unsaved policy without writing or calling models`
- 유지: `LCUI03 a lost response freezes the one-shot reset through retry and exposes the accepted run diagnostics`
- 유지: `LCUI04 rare request option stays hidden until selected and supports dismissal`

### `tests/new-story-browser.spec.ts`

NSUI01 유일 사용 가능 모델 자동 선택과 부가 옵션 접기 보존을 유지해요. no-model 안내/저장 실패와 진입 조건이 달라요.

- 유지: `NSUI01 a sole usable model reaches an empty chat on mobile and optional choices survive collapsing`

### `tests/organization-browser.spec.ts`

ORG01 소속별 폴더 해제, ORG02 desktop drag/drop/순서 저장, ORG03 터치 메뉴/삭제 확인, ORG04 비선택 채팅 활동/완료 제거를 유지해요. drag 좌표와 hover/focus/touch 가시성은 실제 조작 계약이에요.

- 유지: `ORG01 mobile navigation groups by owner and preserves chats when a folder is released`
- 유지: `ORG02 desktop compact rows support drag ordering, folder drops, collapse and persisted order`
- 유지: `ORG03 touch menu offers folder movement and ordering and keeps deletion confirmation`
- 유지: `ORG04 unselected chat and collapsed folder display compact pending activity and clear on completion`

### `tests/package-behavior-browser.spec.ts`

BUI01 typed action CAS/중복/안전 text, BUI02 JSON 오류 초안, BUI03 자동 입력/model-only action, BUI04 저장 dice 결과/재조회 무추첨을 유지해요.

- 유지: `BUI01 typed actions preserve drafts after CAS conflicts, block duplicate writes and render text safely at 412px`
- 유지: `BUI02 behavior editor validates without discarding an invalid draft or other package edits`
- 유지: `BUI03 invocation methods persist, validate automatic input drafts and show model-only actions without user buttons at 412px`
- 유지: `BUI04 a pure dice action displays its stored result safely and reload does not reroll it`

### `tests/package-editor-browser.spec.ts`

PKUI01 로어/지침/재열기/역할별 복사에 PKUI02의 역할 목록/프롬프트 분리 탐색/빈 relatedIds를 흡수했어요. PKUI03 150k native JSON 검토 초안과 persona 범위, PKUI04 240개 lore paging/search/bulk/folder/직렬화는 유지해요. flex 방향/카드 좌표/정확한 높이는 시각 검토예요.

- 유지: `PKUI04 hundreds of lore entries support folders, search, bulk move and persistent compact editing`
- 유지: `PKUI03 native JSON import remains a reviewed persona draft and preserves long content on save`
- 유지: `PKUI01 package editing preserves internal lore, instructions, unsaved work and cross-role copies`

### `tests/package-features-browser.spec.ts`

PFUI01 조건부 control/template 초안/명시 static 변환, PFUI02 두 root의 요구 모듈 1회 장착/값 보존, PFUI03 segment 검증/detach/restore의 authored control을 유지해요.

- 유지: `PFUI01 option drafts survive tabs and validated authoring preserves templates until explicit static conversion`
- 유지: `PFUI02 required module appears once and keeps chat options after another requiring root is removed`
- 유지: `PFUI03 generic source segment drafts validate before save and keep authored controls across detach and restore`

### `tests/package-navigation-browser.spec.ts`

PNAV01 section 이동의 검색/caret/초안, PNAV02 keyboard/resize/focus/접기, PNAV03 containment를 유지해요. 추가 폭 sweep만 시각 검토예요.

- 유지: `PNAV01 mobile section navigation preserves lore search, caret and unapplied drafts until explicit save`
- 유지: `PNAV02 desktop keyboard navigation and mobile resizing retain fields, expanded details and visible focus`
- 유지: `PNAV03 package navigation uses one mobile column and desktop side-by-side panels without overflow`

### `tests/package-request-browser.spec.ts`

PREQUESTUI01 제안 저장/재조회/1회 소비/취소, PREQUESTUI02 전달 뒤 수정 receipt 해제/다른 제안 소비 방지를 유지해요.

- 유지: `PREQUESTUI01 generic controls reserve a proposal, survive reload, consume once and cancel at 412px`
- 유지: `PREQUESTUI02 editing a staged proposal clears its receipt and cannot consume a different stored request`

### `tests/product-browser.spec.ts`

P01 최신 package/조합의 Run snapshot, P04 수동 모델/프로바이더 권한/역할 라우팅/native provider 옵션, P09/P10/P13 fork 본문/anchor/번역/이미지/draft/후손, P06/P11 품질 메모/실제 다운로드/점유 restore를 유지해요. PMUI 설정 화면과 다른 실행 snapshot/bytes 증거예요.

- 유지: `P01 packages use latest settings and prompt-owned creative choices replace prior values`
- 유지: `P04 manual model IDs and distinct main/translation routing preserve connection authority after catalog failure`
- 유지: `P09 P10 P13 fork from a completed scene preserves long prose and annotations with independent settings tabs and descendants`
- 유지: `P06 P11 quality notes preserve source and export/backup downloads reject restore into an occupied DB`
- 유지: `P04 Vertex settings use service-account references and persist distinct main and translation presets without execution`
- 유지: `P04 named and custom providers save native options from mobile settings without model execution`

### `tests/prompt-actions-browser.spec.ts`

PAUI01 동일 preset 수정/복사/삭제, PAUI02 저장/적용 scope, PAUI03 block 이동/삭제/undo의 template draft/focus를 유지해요.

PAUI04는 양방향 블록 드래그·실행 취소·저장/재조회, PAUI05는 412/2560px 계층 정렬·펼침 아이콘·상위 도구 배치와 접힘 뒤 초안 보존을 확인해요.

- 유지: `PAUI01 editing updates the same prompt while copy and deletion stay in the named management menu`
- 유지: `PAUI02 saving and applying retain distinct scopes with compact actions on desktop and mobile`
- 유지: `PAUI03 block tools preserve pending template drafts, focus and undo through move and delete`

### `tests/prompt-editor-browser.spec.ts`

NUI01 native AST import/역할/history/저장 조합 왕복을 유지해요. 단일 text 편집이나 preview로 대체할 수 없어요.

- 유지: `NUI01 native prompt import, draft preservation, roles, history and saved combinations`

### `tests/prompt-library-refinements-browser.spec.ts`

PLR02 각 자료 종류 card/list 수정 진입을 유지해요. PLR03에 PLR04의 각 역할 기본 본문 가시성을 흡수해 저장 AST/preview trace 이름까지 확인해요. PLR03의 중복 preview 접기는 PUNI02에 맡겼고 PLR01은 LIMG02로 흡수했어요.

- 유지: `PLR02 every package category is editable from card and list controls`
- 유지: `PLR03 creation displays and saves role defaults and preview uses block names`

### `tests/prompt-redesign-browser.spec.ts`

PRUI01 선택적 template draft 안전 검사를 유지해요. 앞선 감사에서는 역할 기준 조합으로 단순화했지만, 현재 계약은 같은 프리셋 소속과 같은 옵션 정의를 모두 요구해요. 서로 다른 프리셋이 동일한 control ID·정의를 사용해도 조합을 표시·적용하지 않는 경계와 본문만 수정했을 때 같은 소속 조합을 유지하는 경계를 함께 확인해요. CURRENTUI01은 정의가 바뀐 이전 조합의 목록 제외와 직접 적용 거부를 확인해요.

- 유지: `PRUI01 optional template draft safety and reusable role-owned combinations`

### `tests/prompt-unified-browser.spec.ts`

PUNI01 하나의 AST/접기 초안/복합 message text 변환 방어, PUNI02 단일 block 파일 import/preview input-result 접기 보존을 유지해요.

- 유지: `PUNI01 structured editor preserves one AST; folding keeps drafts and complex messages cannot become plain text`
- 유지: `PUNI02 file import edits one block and folded preview retains its snapshot`

### `tests/prompt-workspace-browser.spec.ts`

PWS01 새 채팅에도 적용되는 현재 옵션/profile 무변경, PWS02 번역 retry 정책/main 옵션 독립성을 유지해요.

- 유지: `PWS01 current options apply globally without changing chat profiles`
- 유지: `PWS02 translation policy and prompt options save in the independent workspace`

### `tests/provider-compact-browser.spec.ts`

PCUI01 빈 프로바이더/모델 진입, PCUI02 목록/menu/search 복구를 유지해요. PCUI03 등록 요청 초안 폐기는 등록 보조 기능 제거(2026-09-09)와 함께 삭제했어요. 6폭을 기본 2폭으로 줄이고 icon/tab 정밀 정렬은 시각 검토로 옮겼어요.

- 유지: `PCUI01 empty connections and empty models each expose one relevant starting action`
- 유지: `PCUI02 compact provider lists align at six widths and retain accessible menus and search recovery`

### `tests/provider-management-browser.spec.ts`

PMUI01 template/manual/catalog 오류, 02 clone/CAS, 03 최신 프로바이더/비활성, 04 늦은 readiness, 07 cached catalog/draft, 08 Vertex JSON/credential ref, 09 invalid focus/오래된 확인, 11 provider별 파라미터, 12 미지원 선택 교정, 13 늦은 test token, 14 불확실 key, 15 강제 Google tier, 10 합성 Codex login, 16 endpoint 정책/stale 응답을 유지해요. 검토일 고정 문자열만 날짜 형식으로 바꿨어요.

- 유지: `PMUI01 mobile template registration selects the connection, reports catalog failure honestly and saves manual options`
- 유지: `PMUI02 connection clone requires review and stale edits retain their draft and CAS revision until explicit reload`
- 유지: `PMUI03 model edits use the latest connection without changing role IDs; deactivation blocks new runs and keeps the selection`
- 유지: `PMUI04 a delayed readiness response cannot replace the currently selected connection status`
- 유지: `PMUI07 quick setup selects a cached catalog model and keeps drafts across workspace pages`
- 유지: `PMUI08 Vertex JSON upload validates locally and saves only the returned credential reference`
- 유지: `PMUI09 invalid hidden model fields receive focus and old deactivation confirmation cannot follow another draft`
- 유지: `PMUI11 reviewed provider options are visible and round-trip without generation, including GPT Flex and Fable`
- 유지: `PMUI12 changing the model preserves unsupported choices until the user explicitly replaces them`
- 유지: `PMUI13 response tests are explicit and late results stay with the original model settings token`
- 유지: `PMUI14 an uncertain response test reuses its key until an explicit new test follows a completed result`
- 유지: `PMUI15 a forced Google service tier is shown and conflicting saved choices require an explicit correction`
- 유지: `PMUI10 Codex subscription login preserves drafts and saves a connection and model without generation`
- 유지: `PMUI16 endpoint guidance checks server policy before saving and ignores a stale draft response`

### `tests/provider-registration-browser.spec.ts`

등록 보조 기능 제거(2026-09-09)와 함께 삭제했어요. PMUI05·PMUI06은 더 이상 없어요.

### `tests/response-actions-browser.spec.ts`

RACOM01 touch/keyboard/닫기/넘침은 기본 412/2560, 추가 폭은 시각 검토예요. TSKUI01 실제 run/job/attempt 표시 검사는 기본이며 PNG만 opt-in이에요.

- 유지: `RACOM01 source footer stays compact and its menu supports touch, keyboard and dismissal at six widths`
- 유지: `TSKUI01 task overview screenshots wait for real run, job and attempt data on mobile and desktop`

### `tests/run-retry-browser.spec.ts`

실패 Run 요청 수정/draft 보호/불확실 재수락 key를 유지해요. 보조 retry/fork와 별도 명령 계약이에요.

- 유지: `failed request edit, draft protection and uncertain retry reuse one admission`

### `tests/self-host-browser.spec.ts`

기존 NR_SELF_HOST_BROWSER=1의 HTTPS 세션/접근 해제 격리를 유지해요. 일반 redesign과 별도 환경 전제이며 실제 배포/휴대폰 증거가 아니에요. PNG만 visual opt-in이에요.

- 유지: `SHUI01 actual HTTPS enforces authentication, exact origin and secure browser sessions`
- 유지: `SHUI02 desktop and 412px mobile share persisted chats and live HTTPS SSE across re-entry`

### `tests/settings-compact-browser.spec.ts`

SCUI03 다중 history URL/chat 일치, SCUI01 접근/넘침, SCUI02 Back/resize/닫기의 provider/chat draft를 유지해요. 추가 폭/SVG 종류의 정확한 구분은 opt-in이에요.

- 유지: `SCUI03 multi-entry browser back keeps the address and chat consistent with clean and dirty settings`
- 유지: `SCUI01 settings list and details adapt at six widths with distinct icons and no overflow`
- 유지: `SCUI02 settings back, resize and close preserve provider and chat drafts until explicit discard`

### `tests/shared-package-browser.spec.ts`

공유 persona/이미지를 bot 역할로 시작할 때 authored opening/자동 job 없음, 큰 이미지 목록/이전 revision/portable bundle를 유지해요. 대표 이미지 선택과 다른 결과 계약이에요.

- 유지: `shared persona draft uploads an image and starts as a bot with an exact authored opening and no automatic model jobs`
- 유지: `shared package image editing pages large lists and preserves old revisions and a portable image bundle`

### `tests/source-edit-focus-browser.spec.ts`

mobile/desktop 긴 원문 편집의 가시성/저장/취소/위치/focus, 실패 뒤 초안/후속 저장을 유지해요. 읽기 복원 16px 허용 오차는 기능 검사예요.

- 유지: `C04E ${label} long source editing focuses the visible editor and restores reading after Escape, cancel and save`
- 유지: `C04E failed source save keeps the draft available and a later save restores focus without generation`

### `tests/source-segments-browser.spec.ts`

SEGMENTUI01 선언에 따른 main/hidden 펼침 무쓰기/현재 전체 번역, SEGMENTUI02 현재 module 변경 뒤 새 Run snapshot/미적용 draft를 유지해요.

- 유지: `SEGMENTUI01 package-defined source reader expands without writes and displays the current translated source`
- 유지: `SEGMENTUI02 current modules preserve unapplied segment drafts and existing Run snapshots`

### `tests/story-browser.spec.ts`

S01/S02 preview 비활성/상태 대기 중 읽기/다음 입력, S04 작가 선언/retcon/reload, S06 예약 성공/실패/취소, S06/S07 inert text/metadata paging/권한/bytes 비선로딩을 유지해요. SQLite/source hash/네트워크 JSON 증거도 유지해요.

- 유지: `S01 S02 state settings use synthetic rules, preserve readable original while waiting, then compile persisted state`
- 유지: `S04 explicit author declaration and retcon remain distinct memory after reload`
- 유지: `S06 scene commands distinguish successful original, failed original and cancelled reservation`
- 유지: `S06 S07 text presentation keeps malicious HTML inert and asset catalog transfers metadata without preloading bytes`

### `tests/turn-activity-browser.spec.ts`

TURNUI01 독립 펼침/lazy inspector/reload, TURNUI02 접힌 보조 진행/소유권, TURNUI04 pending→source 펼침, TURNUI03 source 없는 실패 진단을 유지해요. 전역 ACTUI 타이머와 달라요.

- 유지: `TURNUI01 independent response panels, lazy inspector and reload persistence`
- 유지: `TURNUI02 folded auxiliary progress updates preserve explicit expansion and ownership`
- 유지: `TURNUI04 expanded pending run preserves disclosure when its source arrives`
- 유지: `TURNUI03 failed response without source keeps inline diagnostics readable at 412px`

### `tests/ui-browser.spec.ts`

긴 원문 안전 렌더/무호출 보기, 새 채팅 부분 성공 복구, IME/caret/URL/draft, 늦은 보조/읽기 위치, command/fork 응답 유실/A→B→A 경쟁, stale SSE, no-model/모델 기억/비활성/동시 복구, composer 복원, 보관 branch, full/empty prompt import/CAS, 번역 명시 시작/직접 수정/과거 snapshot/늦은 응답, 설정 draft/keyboard, dialog focus/닫기, 전체 번역 이전 결과 보존을 각각 유지해요. UI08의 임의 15회 Tab만 common-dialog 경계 검사로 통합했어요. dialog 정확한 크기/중심/추가 reader 폭은 opt-in이에요.

- 유지: `UI01 UI02 UI04 UI05 UI09 long real sources keep composer accessible, safe prose and zero-call view changes`
- 유지: `UI03 bot-first retry saves one story and complete profile before any generation`
- 유지: `UI08 UI12 native dialog focus, composition, URL and draft selection stay local`
- 유지: `UI05 UI10 late auxiliary completion and retry preserve source and current reader position`
- 유지: `UI12 lost response reconfirms the original command and preserves a newer draft`
- 유지: `UI07 UI12 lost fork response reuses one new story and Back Forward preserves independent drafts without model calls`
- 유지: `UI07 UI12 late accepted fork cannot navigate after A B A or replace the current draft`
- 유지: `UI12 late failed SSE refresh from another story never publishes its error into the current story`
- 유지: `UI03 UI12 new story retry retains selections, uses current content and locks its pending creation`
- 유지: `UI03 UI12 failed starting profile read survives reload and recovers frozen prompt choices with current routes`
- 유지: `UI03 starting without a model explains setup and creates a chat without execution`
- 유지: `UI03 UI12 starting model choices are saved without execution, reused exactly and dropped when their connection is disabled`
- 유지: `UI03 UI12 pending starting models recover after a failed profile read without overwriting newer model choices`
- 유지: `UI02 UI04 UI12 sending a long request collapses the empty composer and preserves a later long draft on return`
- 유지: `UI07 UI09 legacy branches use one mobile selection and preserve reading without generation`
- 유지: `UI17 full writing and empty translation prompts import, save and apply without model execution`
- 유지: `UI17 prompts use latest settings and concurrent edits preserve unsaved text`
- 유지: `UI18 translation is requested only by first view click, never by restore, SSE, language or story changes`
- 유지: `UI18 source and translation edits preserve past snapshots and feed only future generation with one latest translation`
- 유지: `UI18 two-tab conflicts preserve reloadable drafts and manual translation survives held work and a late response`
- 유지: `UI settings categories retain drafts and support keyboard navigation`
- 유지: `UI common dialogs center on desktop and fill mobile without changing dismissal or focus`
- 유지: `UI whole-source translation retains completed results across retry and cancellation`

### `tests/ui-usability-browser.spec.ts`

UXUI01 composer/설정 상세 이동의 draft는 412px 기본이에요. 추가 360px/정사각 avatar/고정 composer 높이는 시각 검토예요.

- 유지: `UXUI01 compact composer, square avatar and mobile settings details preserve the draft`

## 검증과 효과의 한계

45개 파일의 case 선언 162개를 목록화했어요. 반복 등록 선언은 여러 실행 case가 되므로 runner 수와 다를 수 있어요. 독립 선언은 PLR01/PLR04/PKUI02 3개를 흡수했고 나머지는 고유 계약을 보존하면서 중복 assertion/추가 폭/PNG 비용을 줄였어요.

기존 `output/playwright/redesign-2026-09-08T14-30-18-897Z-2762315f/playwright.json`의 PUNI01/PUNI02/PLR03 오래된 진입 timeout은 합계 약 120.44초예요. 개선 후 측정이 아니며 정상 소형 case 제거만으로 같은 속도 향상을 주장할 수 없어요. 최종 실행 시간/결과는 통합 담당자가 현재 소스/빌드 일치를 확인한 실행으로 기록해요.

브라우저 변경 45개 파일과 helper의 `npx biome check --write` 및 `npx tsc --noEmit`는 통과했어요. 이 담당 작업에서는 build/browser를 재실행하지 않았으며 통합 검증에 맡겼어요. 미실행을 PASS로 해석하지 않아요.

통합 실행에서 PLR03/PUNI01/PUNI02의 신규 편집기 안 구형 선택 컨트롤이 더 발견됐어요. PLR03은 새 편집기에서 바로 역할 기본값을 검사하고, PUNI는 서재 목록의 저장된 프리셋 편집으로 진입해 API revision으로 저장을 확인하도록 고쳤어요. PUNI02의 6번/36번 메시지 부분 문자열 충돌은 정확한 이름으로 구분해요. 긴 원문 UI 검사도 원문 앵커는 보존하면서 번역은 한 본문·앵커 없음 계약으로 바꿨어요. 본문·AST·파일 import·이력·미리보기·원문 무변경 검증은 유지했고 모두 개별 재검증을 통과했어요. 최종 전체 결과는 [구현 결과](../project-plan/RUNTIME-SIMPLIFICATION-RESULTS.md)에 기록해요.
