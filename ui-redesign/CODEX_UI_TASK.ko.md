# Codex 작업 지시 — Uimori M1-local UI/UX 개편

> 보관된 2026-09-06 착수 지시예요. 아래 명령형 문장은 당시 요청이며 이 파일을 읽는 것만으로 재구현을 시작하지 않아요. 후속 [REDESIGN](../project-plan/REDESIGN.md)과 현재 AGENTS.md·[CURRENT](../project-plan/CURRENT.md)를 우선해요. 구형 DB 보존/migration 요구와 fixture-only 제약은 현행 계약이 아니에요. 실제 구현·검증은 [UI-RESULTS](../project-plan/UI-RESULTS.md)를 확인해요.

현재 저장소의 기존 M1-local 동작을 유지하면서 사용자용 UI를 개편해줘. 색상/CSS 장식만 바꾸거나 새 데모 페이지만 만들지 말고 **실제 앱의 주요 사용 경로를 새 셸로 옮겨 구현·검증**하는 작업이야.

## 읽을 자료와 기준

1. 현재 저장소 AGENTS.md, project-plan/CURRENT.md, package.json, 실제 git 상태.
2. ui-redesign/UI_REDESIGN.md, UI_ACCEPTANCE.json, SOURCE_MAP.json.
3. ui-redesign/uimori-ui-prototype.html과 desktop-chat.png, mobile-chat.png, desktop-library.png.

이 검토의 baseline은 main `87548d15c41fa0adb74284a1873c9d28e1dfe8ee`다. 현재 코드가 달라졌으면 차이를 확인하고 유효한 부분에 적용해. 시안은 합성 데이터만 가진 디자인 참고이며 생산 코드·실제 공급자·완료된 E2E가 아니다. 시안의 임시 데이터와 비활성 버튼을 제품에 그대로 복사하지 마.

## 제품 방향

- 익숙한 ChatGPT/Codex 계열의 좌측 탐색 + 중앙 대화/원고 + 하단 입력을 사용한다.
- 기본 사용은 봇 → 페르소나 → 창작 프리셋 → 장면 요청 → 한국어 번역 읽기다.
- 기본 원고 화면은 관리 폼과 작업 로그의 세로 나열이 아니다. 큰 hero/장식 문구도 제거한다.
- 데스크톱은 sidebar + 읽기 폭이 제한된 중앙, 필요할 때만 열리는 설정/분기 패널.
- 모바일은 sidebar를 상단에 쌓지 않고 메뉴로 숨긴 단일 열. 입력창과 읽기 화면을 우선한다.
- 메인은 창작과 필요한 자료 탐색, 보조 역할은 번역/이미지/상태를 담당한다. 로어의 자율 조회를 수동 whitelist/top-k 고정으로 바꾸지 않는다.

## 우선 구현할 것

1. main.tsx의 화면 셸을 재구성한다. LibraryPanel과 ArchivePanel을 원고 위에서 떼어 서재/설정으로 옮기고, SettingsEditor/ProfileEditor/AssetEditor는 이야기 설정에서 연다. Run/AttemptInspector는 작업 현황과 요청별 상세로 옮긴다. 제거가 아니라 재배치다.
2. Source.runId와 Run.request를 이용해 '내 요청 → 원고 → 후보/후속 상태'가 연결된 턴을 표시한다. 원고는 긴 말풍선이나 중첩 카드가 아닌 prose로 읽게 한다. Markdown/인용/목록은 안전하게 렌더하고 raw 원문·hash·보호구문·에셋/상태 채널은 보존한다.
3. reader는 자체 스크롤, composer는 하단에 둔다. scrollY 의존을 reader 기준으로 고치며, 원문↔번역 앵커와 이야기/분기별 draft/커서를 유지한다. 사용자 독서 중 토큰·번역·이미지 도착으로 강제 스크롤하지 않는다.
4. composer에서 창작 프리셋·페르소나·본문 모델을 빠르게 선택한다. 복잡한 설정은 drawer. Settings.preset과 creative.style 등 겹치는 기존 필드는 유효 동작을 확인해 제품 UI와 fixture 개발 제어를 구분한다. 과거 preset/DB migration을 임의로 삭제하지 않는다.
5. 서재는 검색 가능한 봇/자료 카드·리스트와 상세 편집으로 바꾼다. 관련 자료는 이름으로 선택하고 내부 ID는 프로그램이 다룬다. 새 이야기는 봇을 고른 후 시작하며 제목은 기본값으로 채울 수 있다. 썸네일 데이터가 없으면 중립적 placeholder로 표시한다.
6. 원문/번역 전환, 번역 실패 재시도, 후보 탐색과 새 후보 생성은 분리한다. 보기 전환에는 LLM 호출이 없어야 한다. 비용·실제 연결 유무와 실패 상태를 숨기지 않는다.

현재 Connection은 fixture-sse-v1이고 reasoning/genre 등 일부 제어는 schema에 없다. UI만으로 live 연결·추론 설정·미구현 기억 편집이 있는 척하지 마. 현재 지원 기능부터 연결하고, 꼭 필요한 소규모 계약 추가는 근거/범위/테스트와 함께 드러내. 이 작업에서 실제 provider adapter나 M2 전체를 자동 구현할 필요는 없다.

## 구현과 검증 루프

먼저 허용된 로컬 환경에서 현재 앱을 별도 테스트 DB로 실행하고 1440×1000, 390×844에서 원고가 있는 기본 화면/설정/서재를 캡처해. 환경상 실행할 수 없으면 근거를 남기고 가능한 정적·로컬 검증은 계속해. 사용자 원고·키를 테스트 데이터나 원격 아티팩트에 넣지 마.

UI-1 → UI-2 → UI-3 순서로 진행하되 매 단계 재계획만 하고 멈추지 마. 첫 번째로 셸·원고·입력창이 실제 현재 API에 붙은 상태를 완성해. 자동 검증과 직접 screenshot/DOM 확인을 함께 하고 눈에 보이는 레이아웃·대비·클리핑 문제를 수정해.

Windows11, 현재 Node/npm/lockfile을 유지해. 새 router/store/design system을 한꺼번에 도입하지 마. 기존 도구와 작고 명확한 컴포넌트를 우선하고, 접근성 있는 Dialog/Tab/Popover 동작은 재사용해. production 앱 안에 전역 test reset API를 추가하지 마.

다음은 반드시 보존한다:
- expected revision·idempotency·원문 불변성·분기 ancestry·후보 보존.
- 원문과 번역/상태/이미지의 job/source 귀속 및 개별 실패/재시도.
- 서버 소유 실행. 탭 닫기/화면 이동이 생성 취소가 되지 않음.
- 실제 적용되는 역할별 설정. 보조 disabled인데 비용 호출이 생기지 않음.
- 기존 인증·비밀키·URL/에셋 권한·export/import 보안 경계.

검증에는 UI_ACCEPTANCE의 필수 항목과 기존 M0/M1-local을 연결해. 기존 DOM 구조와 label에 결합된 테스트는 새 접근 가능한 경로로 고쳐도 되지만, 데이터·분기·저장 assertion을 없애거나 테스트를 skip해서 녹색으로 만들지 마.

좁은 반복 검사를 거친 뒤 최종 코드에서 `npm run check`, `npm run build`, `npm run verify -- --milestone M0`, `npm run verify -- --milestone M1-local`을 실제 실행해. 명령이 달라졌다면 이유와 확인된 동등 명령을 기록해. HMR 등 개발 루프를 보완하는 경우에도 실제로 동작하는지 확인하고 없는 명령을 문서에 쓰지 마.

실제 휴대폰 IME/키보드/백그라운드 동작과 live 모델은 별도 검증으로 남겨도 로컬 UI 작업은 완료할 수 있다. 브라우저 viewport 에뮬레이션을 실제 폰 통과라고 표시하지 마.

## 완료 기준과 보고

- 일상 동작에서 source ID/revision/hash/job 설정을 다루지 않고 이야기를 시작·읽기·이어쓰기 가능.
- 긴 원고와 실행 기록이 있어도 입력창·현재 작업 상태를 찾기 쉽고, 관리/개발 UI가 기본 원고 위에 쌓이지 않음.
- 데스크톱/모바일 원고·번역·서재·설정·실패 상태의 실제 앱 screenshot과 기능 검증 증거 제공.
- 수정 파일·기존 동작 보존·새로 필요한 최소 기능·실제 실행한 검사·미실행/차단·현재 앱 실행법을 구분해 보고.

로컬 편집·허용된 의존성 준비·임시 테스트 정리는 진행해. 사용자 데이터 삭제/마이그레이션, 추가 권한, 미승인 유료 호출, 원격 push·외부 배포는 이 지시의 범위가 아니야. 원격 preview는 사용자가 배포처와 접근 방식을 승인한 별도 작업으로 남겨.
