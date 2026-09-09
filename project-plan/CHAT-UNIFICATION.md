# 메인·도우미 대화와 재요청 통일

## 확정한 사용자 경험

- 메인과 도우미는 같은 입력창 구성과 키보드 규칙을 사용한다. 도우미의 권한·대상 선택과 메인의 집필 옵션처럼 기능에 필요한 차이는 유지한다.
- 사용자 요청은 말풍선으로 표시하고 답변·진행 상태·오류는 그 밖에 표시한다.
- 실패 요청은 그 자리에서 다시 요청하거나 편집해서 다시 요청한다. 편집은 하단의 새 요청 초안을 덮어쓰지 않는다.
- 재요청이 접수되면 대화에는 최신 시도를 표시한다. 이전 실패는 작업 기록에서 확인하며 새로고침해도 대화에 다시 나타나지 않는다.
- 접수 여부를 모르는 요청은 같은 요청 키로 확인한다. 불확실한 공급자 실행을 자동으로 다시 보내지 않는다.

## 구현·검증 경계

기존 실행 기록을 삭제하거나 과거 snapshot을 수정하지 않고 시도 사이의 연결과 읽기 projection으로 대화를 구성한다. 서버는 재요청 대상의 소유권·상태·중복을 검사하고 도우미의 명시 권한 계약을 유지한다.

검증은 새 DB와 loopback fixture를 사용한다. 공통 입력창과 재요청의 모바일·데스크톱 동작, 초안 보호, 접수 응답 유실, 새로고침 후 표시를 확인한다. 실제 공급자 호출·창작 품질·실기기 검증은 포함하지 않는다.

별도 작업트리에서 구현한다. 생성 시 포함된 다른 스레드의 탐색 UI 변경은 보존하며, 기준 diff와 새 파일 사본은 `output/chat-unification/`에 둔다. 다른 스레드와의 병합·통합은 후속 작업이다.

## 결과

구현 완료. 메인·도우미는 `ChatComposer`/`ComposerInput`, 요청 편집은 `RequestMessage`, 실패 표시는 `RetryFailure`를 공유한다. 한글 조합 중 Enter를 보호하며 Enter 설정, 자동 높이, 전송·취소 버튼 모양을 통일했다. 실패 요청 편집 중에는 하단 입력창과 초안을 유지한다.

메인 재요청은 기존 `command.retryOf`를 사용한다. 원래 head가 그대로면 같은 분기에 예약하고, 이후 원문이 생겼다면 원래 parent에서 분기한다. `reader`는 원래 요청의 순서와 이전 시도의 대체 여부를 계산하고 `core/reader-conversation.ts`가 원문과 진행·실패 요청을 합친다. 독립 실패가 여러 개 있어도 재시도 중·성공 후 순서를 유지하며 5개 원문 페이지와 장면 번호는 보존한다.

도우미는 새 작업 snapshot의 `retryOf`/`requestGroupId`와 메시지의 최신 작업 projection으로 같은 요청을 묶는다. 이전 작업·메시지는 보관하고 작업 기록에서 확인한다. 다른 대화·성공 작업·이미 대체된 시도의 재요청은 거부하며 같은 요청 키는 동일 작업을 반환한다. 이전 선택 원문과 편집 대상은 다시 검증하고 권한은 새 요청에서 계산한다.

### 검증

- `npm run quality:full`: PASS, 단위·통합 1,710 PASS / 1 SKIP. SKIP은 기본 비활성인 설치 Codex preflight다. 로그: `output/chat-unification/quality-full-final.log`.
- 검증 도구: PASS. `output/tooling/2026-09-09T16-19-16-561Z-910c21a7/summary.json`.
- 마지막 하단 입력창 표시 수정 후 `npm run quality`와 새 `npm run build`: PASS. 빌드 로그: `output/chat-unification/build-final.log`.
- `npm run verify:chat-unification`: 14/14 PASS, cleanup PASS. `output/playwright/chat-unification-2026-09-09T16-26-52-642Z-006547d8/summary.json`.
- 관련 브라우저 범위: 한글 조합·줄바꿈, 입력창 크기, 도우미 대화·작업·선택 원문·초안, 메인/도우미 재요청, 응답 유실 후 동일 요청 확인, 복수 실패 위치, 요청 편집, 오류 상세. 390px·1440px 도우미 PNG를 직접 확인했다.
- 전체 `verify:redesign`은 10분 timeout으로 FAIL이며 전체 통과를 주장하지 않는다. 복사된 탐색 UI와 기존 테스트의 `봇의 채팅 목록` 선택자 불일치가 남았다. 당시 발견한 이번 작업의 도우미 메뉴 선택자와 실패 상세 접근 검사는 수정 후 위 14개 묶음에서 통과했다. 전체 시도 증거: `output/playwright/redesign-2026-09-09T16-06-54-659Z-c33fc5fd/summary.json`.
- 최초 sandbox 빌드와 임시 검증 폴더 rename의 EPERM은 실패 로그를 보존하고 승인된 새 실행으로 재검증했다. 차단된 실행은 PASS에 포함하지 않았다.

실제 모델·실기기 검증, 다른 스레드 변경과 병합·커밋·배포는 수행하지 않았다. 다음 통합 시 생성 시점부터 포함된 탐색 변경과 이번 `web/main.tsx`의 입력창·대화 목록 변경을 구분해 병합하고 전체 탐색 회귀를 갱신해야 한다.

## 메인 병합 (2026-09-10)

사용자 요청으로 `a350748`의 탐색 UI와 충돌 없이 통합하고 main을 `024f9f8`로 fast-forward했다. 작업 구현 커밋은 `1ae82fd`다. 아래 검증은 병합된 메인 checkout에서 다시 실행했다.

- `quality:full`: PASS, 1,710 PASS / Codex preflight opt-in 1 SKIP. `output/chat-unification/merge-quality-full.log`.
- `verify:chat-unification`: 14/14 PASS. `output/playwright/chat-unification-2026-09-09T16-31-47-246Z-3833cdb9/summary.json`.
- `verify:navigation`: 24/24 PASS. `output/playwright/navigation-2026-09-09T16-31-45-590Z-04da68ef/summary.json`.
- 기존 작업트리 검증 로그·화면·실패 기록을 메인의 같은 output 경로에 복사하고 주요 파일 해시가 같은지 확인했다. 전체 redesign의 과거 timeout 기록은 그대로 보존한다.
- 작업트리 파일과 Git 등록, `codex/chat-unification` 임시 브랜치를 제거했다. `git worktree list`에는 main만 남았다. Windows 프로세스 잠금 때문에 내용이 없는 `C:\Users\wodus\.codex\worktrees\da27\uimori` 폴더 자체는 남았다.
- 원격 push와 배포는 하지 않았다.

## 진행 표시·작업 기록 통일 (2026-09-10)

사용자 요청으로 앞선 작업에서 남은 차이를 정리했다. 입력창·요청 편집·실패 표시에 이어 **진행 표시와 작업 기록**을 공유한다.

### 확정한 사용자 경험

- 진행·완료·실패·확인 필요는 메인과 도우미가 같은 도상 네 개와 같은 문장 위치를 쓴다. 도상 어휘는 `web/ui-icons.ts`의 `RunningIcon`·`DoneIcon`·`IssueIcon`·`UncertainIcon`이다.
- 모든 턴은 상태 행을 가진다. 실패한 턴도 상태 행을 유지하고, 실패 카드는 그 아래에서 다시 시도·오류 상세·작업 기록을 제공한다.
- 요청 처리 중에는 회전 도상과 경과 시간을 상태 행과 입력창 위 상태줄에 함께 보여준다. 두 표시는 같은 갱신 간격을 사용하므로 서로 다른 초를 보여주지 않는다.
- 작업 기록은 양쪽 모두 대화 흐름 밖의 모달이다. 항목마다 상태·시각·모델 호출 수·소요 시간·오류를 보여주고 이전 작업을 페이지로 더 불러온다.
- 저장된 답변이 있으면 스트림 버퍼를 함께 표시하지 않는다. 실패·부분 종료에서 같은 본문이 두 번 보이지 않는다.
- 도우미도 현재 전역 도우미 모델을 패널에서 확인하고 눌러서 모델 설정으로 이동한다.
- 기능에 필요한 차이는 유지한다. 메인의 원고 렌더링·장면 번호·번역 보기·삽화·포크와 도우미의 권한 대상·가정 장면 카드·말투 설정은 그대로다.

### 헤더와 재번역

- 집중 읽기 시작은 채팅 메뉴로 옮기고, 모드 중일 때만 헤더에 종료 버튼을 둔다. 모드 해제는 한 번의 조작으로 유지한다.
- 좁은 화면에서는 본문 모델 칩을 헤더에서 입력창 위로 옮긴다. 375px에서 채팅 제목이 잘리지 않고 모델은 보내기 버튼 옆에서 확인한다.
- `현재 설정으로 새 번역`의 브라우저 `confirm`을 없앴다. 메뉴 항목 이름이 범위를 말하고, 기존 번역은 새 번역이 끝날 때까지 유지되며, 진행 중 번역은 해당 턴의 작업 현황에서 취소한다. 형제 동작인 `현재 설정으로 다시 요청`과 같은 절차가 된다.

### 구현 경계

`web/TurnStatus.tsx`가 상태 행과 접히는 진단을, `web/ActivityBar.tsx`가 입력창 위 상태줄을 담당한다. `TurnActivity`와 `ActivityStatus`, `HelperPanel`이 이 둘을 공유한다. 세션에 저장하는 펼침 상태와 숨김 상태는 표시만 바꾸며 서버 작업을 취소하지 않는다.

도우미 작업의 실행 시작 시각은 `helper_tasks.started_at`에 저장한다. 이 열은 v15 DB에 없으면 추가하며 스키마 버전은 유지한다(`initHelperTaskTiming`). 대기 중 작업은 접수 시각부터의 대기 시간을, 실행·종료 작업은 시작 시각부터의 실행 시간을 보여준다.

### 검증

- `npm run quality`: PASS. 단위·통합은 Node 24에서 1,716 PASS / 1 SKIP(기본 비활성 Codex preflight). 로컬 Node 26에서는 `tests/harness.test.ts`가 BLOCKED, `tests/server.test.ts`의 F03이 SSE 첫 프레임 분할로 실패하며 둘 다 Node 24에서 통과한다.
- `npm run verify:chat-unification`: 14/14 PASS.
- `npm run verify:turn-activity`: 4/4 PASS. 변경 전 트리에서는 TURNUI03·TURNUI04가 실패했고 이번 변경으로 통과한다.
- `npm run verify:loading`: 8/8 PASS. `npm run verify:global-models`: 2/2 PASS. `npm run verify:deletion`: 19/19 PASS. `npm run verify:evaluation`: 2/2 PASS. `npm run verify:provider-management`: 15/15 PASS.
- 실기기 검증과 실제 공급자 호출은 하지 않았다. 화면 확인은 합성 fixture 모델과 1440·390px 로컬 브라우저다.

### 남은 선행 실패

아래는 변경 전 `HEAD` 트리에서 같은 명령으로 재현했고 이번 범위에서 고치지 않았다.

- `verify:activity`의 ACTUI08: 재시도한 작업의 이전 세대 알림이 새 세대와 함께 남아 `data-activity-id`가 두 개가 된다. 알림 조정 로직의 문제다.
- `verify:ui`의 UI07·UI12·UI03·UI18: 테스트가 기대하는 `봇의 채팅 목록` 탐색 이름이 현재 쓰는 `BotTreeNavigation`에 없다. 앞선 절에 기록한 선택자 불일치가 그대로 남아 있다.
- `verify:turn-activity`의 TURNUI03은 `1ae82fd` 이후 실패 턴의 진단·버튼 이름이 바뀌어 정지해 있었다. 상태 행 복원과 버튼 이름 갱신으로 이번에 되살렸다.
