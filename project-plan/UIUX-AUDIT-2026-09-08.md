# Uimori 데스크톱·모바일 UI/UX 실사용 감사

2026-09-08 · 개선 후보 18개 (P1 7 / P2 10 / P3 1)

일상적인 채팅보다 설정·제작·진단이 먼저 보이는 화면이 많아요. 읽기와 원문 보존은 유지하면서, 대화를 시작하고 이어 쓰는 경로를 짧게 만드는 것이 가장 큰 개선 방향이에요.

판단 기준: **Codex·ChatGPT처럼 단순하고 익숙하며 직관적으로 사용할 수 있는 경험**

[스크린샷 포함 HTML 보고서](../output/uiux-audit-2026-09-08/report.html) · [후보 JSON](../output/uiux-audit-2026-09-08/audit.json) · [실제 호출 메타데이터](../output/uiux-audit-2026-09-08/live-summary.json)

## 추가 승인 후속 검증

자동 상태 OFF 저장·새로고침 유지·실제 본문 1건 생성 후 자동 상태 작업 0개를 확인했어요(**PASS**). 추가 본문 호출은 1회이며 최초 14회와 합친 누적 시도는 15회예요. [후속 검증 보고서](UIUX-AUTO-STATUS-OFF-2026-09-08.md)

## 확인 범위

- 현재 작업 소스와 일치하는 격리 빌드를 직접 실행하고, 실제 브라우저 UI를 조작했어요. 데스크톱 1440×960, 모바일 폭 390×844·360×800을 확인했어요.
- 사용자가 등록한 Gemini 3.8 Flash의 모델 ID·연결 방식·주요 생성 설정을 확인하고, 별도 감사 DB에서 같은 모델에 실제 요청했어요. 봇·요청·원문은 이번 감사용 합성 자료예요.
- 아래 16개 사용 흐름을 탐색했어요. 모든 가능한 설정 조합이나 제품 전체의 무결함을 증명하는 검사는 아니에요.
- 개선 후보를 마련하는 범위예요. 이번 감사에서 제품 코드는 수정하지 않았고, 기존 작업 내용과 사용자의 작품·채팅은 보존했어요.

## 먼저 진행할 묶음

- 첫 묶음: C01 기본 자동 작업, C03 현재 상태, C04 수정창 초점, C09 아바타를 고치고 C02 실제 보조 실패 원인을 조사해요.
- 두 번째 묶음: C05 메시지 행동·버전, C06 작성창, C07 빠른 새 채팅, C12 대화 관리로 일상 채팅 흐름을 완성해요.
- 세 번째 묶음: C08·C10·C11·C13~C18의 서재·제작·설정을 정리하고 실제 휴대폰 키보드와 터치로 검증해요.

## 실제 모델 요청 결과

| 역할 | 공급자 호출 시도 | 결과 | 보고된 입력 / 출력 토큰 |
|---|---:|---|---:|
| 본문 | 3 | 완료 2, 취소 1 | 2,043 / 3,181 |
| 장면 상태 | 5 | 출력 검증 실패 2건 | 7,073 / 4,570 |
| 번역 | 6 | 완료 실패 1건 | 42,613 / 7,732 |
| 합계 | 14 | 응답 관측 13, 취소 1 | 51,729 / 15,483 |

실제 비용은 모든 호출에서 null이며 추정하지 않았어요. 취소 시도의 사용량은 미상이므로 토큰 합계는 보고된 값만의 합계예요. 취소가 공급자 측 실행·과금 중단을 증명하지는 않아요. 종료 전 활성 Run·보조 job·공급자 시도는 모두 0이었어요.

최초 인증 실패와 모델 미지정 상태 실패는 공급자 시도 0회여서 위 14회에 포함되지 않아요. 생성 원문은 2개이고 포크 복사 2개를 합쳐 DB source 행은 4개예요. 포크에 추가 모델 호출은 없었어요.

## 개선 후보

P1은 대화 시작·결과 신뢰·핵심 행동에 직접 영향을 주는 우선 개선, P2는 반복 마찰과 제작·모바일 배치, P3는 보조 안내예요. 순위는 이번 감사의 제안이며 제품 계약 변경을 승인한 목록은 아니에요.

### C01 · P1 · 모델 없는 자동 장면 상태 실행을 만들지 않기

- 구분: 확인된 설정 결함
- 근거: 단계 3, 5 — 새 채팅에서 본문·번역만 고를 수 있는데 settings.status 기본값은 true, routes.status는 null이에요. 첫 본문 완료 직후 MODEL_REQUIRED:status가 발생했고 공급자 시도는 0회였어요.
- 개선: 자동 상태는 준비된 모델이 있을 때만 사용하도록 하고, 처음에는 꺼진 상태 또는 명시적인 활성화 선택을 제공해요. 필요한 모델 선택을 같은 화면에서 끝내요.
- 완료 조건: 본문 모델만 선택한 새 채팅의 첫 생성이 설정 누락 오류를 만들지 않아요. 활성화할 때 필요한 모델과 적용 시점이 명확해요.
- 확인할 위치: [server/store.ts:228](../server/store.ts#L228), [core/product.ts:178](../core/product.ts#L178), [server/provider-selection.ts:11](../server/provider-selection.ts#L11), [web/NewStory.tsx:613](../web/NewStory.tsx#L613)

### C02 · P1 · 실제 Gemini의 상태·번역 완료 실패부터 조사하기

- 구분: 재현된 기능 실패 / 원인 조사 필요
- 근거: 단계 5 — 모델 지정 후 상태 작업 두 건이 OUTPUT_SCHEMA_INVALID로, 번역 한 건이 여섯 번의 tool_calls 응답 후 AUXILIARY_EXECUTION_FAILED로 끝났어요. 이 결과만으로 특정 필드·프롬프트·공급자를 원인으로 확정하지 않았어요.
- 개선: 실패한 작업의 역할별 출력 계약과 도구 종료 조건을 좁게 재현해 고쳐요. 화면에서는 원문 완료와 보조 작업 실패를 분리하고, 사용자가 할 수 있는 조치만 제시해요.
- 완료 조건: 동일한 합성 시나리오에서 상태·번역이 완결되고 원문 hash와 귀속이 유지돼요. 추가 유료 시험은 구현 후 별도 실행 범위를 정해요.
- 확인할 위치: [web/auxiliary-error.ts](../web/auxiliary-error.ts), [project-plan/AUXILIARY-RECOVERY-RESULTS.md](../project-plan/AUXILIARY-RECOVERY-RESULTS.md)

### C03 · P1 · 현재 결과와 과거 실패를 분리하기

- 구분: 확인된 UX 문제
- 근거: 단계 4, 5, 7 — 본문 완료 뒤에도 하단 대표 상태는 이전 본문 실패였어요. 실패한 요청 기록이 성공한 원문 뒤에 따로 남고, 재시도 버튼은 펼친 작업 현황에 있어요. 별도 상세 창은 기술 오류부터 보여줘요.
- 개선: 현재 생성·중지·완료를 대표 상태로 표시하고 과거 실패는 해당 메시지의 접힌 이력에 둬요. 오류 문장 바로 옆에 설정 열기·다시 시도 같은 다음 행동을 제공해요.
- 완료 조건: 실패→재시도 성공→다음 생성→중지 순서에서 대표 상태가 현재 결과와 일치해요. 과거 이력은 삭제하지 않고 해당 요청에서 확인할 수 있어요.
- 확인할 위치: [web/main.tsx](../web/main.tsx), [web/SourceReader.tsx](../web/SourceReader.tsx), [web/TurnActivity.tsx](../web/TurnActivity.tsx)

### C04 · P1 · 원문 수정창을 사용자의 시야와 초점 안에 열기

- 구분: 확인된 UI 결함
- 근거: 단계 7 — 모바일에서 원문 아래 수정 버튼을 누르면 편집 textarea가 본문 위에 생겨요. 클릭 직후 top=-1532.96px, bottom=-1246.50px, focused=false였어요. 25c는 이후 수동으로 편집창을 찾아 초점을 둔 화면이에요.
- 개선: 본문을 편집 상태로 전환하면서 입력창을 보이는 위치로 옮기고 초점을 줘요. 편집 중에는 일반 채팅 입력창을 접어 두 입력창의 충돌을 줄여요.
- 완료 조건: 긴 원문 아래에서 눌러도 수정창과 저장·취소가 바로 보여요. Escape/취소 뒤 읽던 위치가 복원되고 원문 저장 CAS는 유지돼요.
- 확인할 위치: [web/SourceReader.tsx:193](../web/SourceReader.tsx#L193), [web/SourceReader.tsx:311](../web/SourceReader.tsx#L311), [web/SourceReader.tsx:486](../web/SourceReader.tsx#L486), [web/SourceReader.tsx:754](../web/SourceReader.tsx#L754)

### C05 · P1 · 완료 메시지 수정·응답 재생성·버전 전환 제공

- 구분: 추가 기능 후보
- 근거: 단계 7, 9 — 완료된 내 요청은 읽기 전용이고 원문 수정은 생성 결과를 고치는 기능이에요. 재편집·재시도는 원문 없는 실패·취소 Run에 한정돼요. 완료 응답의 이전/다음 버전 UI는 없어요.
- 개선: 내 메시지에는 수정, 응답에는 다시 생성과 복사, 대안이 생기면 메시지 옆 버전 선택을 제공해요. 이전 메시지 수정 시 기존 전개를 보존하고 사용자는 익숙한 메시지 단위로 이동하게 해요.
- 완료 조건: 이전 요청을 수정해도 원래 전개·생성 기록을 다시 선택할 수 있어요. 새 결과와 번역·상태가 올바른 source/hash에 붙고, 진행 중 중복 생성·취소 규칙을 유지해요.
- 확인할 위치: [web/SourceReader.tsx:269](../web/SourceReader.tsx#L269), [web/SourceReader.tsx:691](../web/SourceReader.tsx#L691), [web/main.tsx:507](../web/main.tsx#L507), [web/useStory.ts:567](../web/useStory.ts#L567), [web/WorkspacePanels.tsx:177](../web/WorkspacePanels.tsx#L177)

### C06 · P1 · 채팅 입력창에서 자주 쓰는 행동을 먼저 보여주기

- 구분: 흐름 단순화 후보
- 근거: 단계 3, 4, 6, 7 — 390px에서 프리셋·창작 옵션·페르소나·더보기·모델 표기가 두 줄 이상을 차지해요. 일부 선택 문구는 10px예요. 기본 프롬프트의 창작 옵션은 빈 안내만 있는 전체 화면을 열어요. 더보기에는 로어 유지 제외라는 세부 기능이 있어요.
- 개선: 기본 입력창은 메시지·모델·보내기에 집중하고 페르소나·창작 세부 설정은 필요할 때 여는 한 곳으로 묶어요. 선택지가 없는 창작 옵션은 숨기거나 설정으로 연결해요.
- 완료 조건: 390/360px에서 메시지와 보내기를 바로 찾을 수 있고 필요한 보조 기능은 한 번의 명확한 메뉴로 접근해요. 빈 옵션 화면을 열지 않아요.
- 확인할 위치: [web/main.tsx](../web/main.tsx), [web/ComposerMore.tsx](../web/ComposerMore.tsx), [web/style.css](../web/style.css)

### C07 · P1 · 새 채팅을 봇과 모델 선택만으로 시작하기

- 구분: 흐름 단순화 후보
- 근거: 단계 2, 3 — 첫 채팅에 페르소나·모듈·프롬프트·본문 모델·번역 모델·제목을 모두 거쳐야 해요. 하나뿐인 모델도 미선택이고, 모바일 시작 버튼은 아래에 있어요.
- 개선: 사용 가능한 마지막 모델을 기본값으로 제안하고 봇 선택 후 바로 대화할 수 있게 해요. 제목은 자동 제안하되 나중에 바꾸고, 선택적 자료와 역할별 모델은 추가 설정으로 내려요.
- 완료 조건: 준비된 모델 하나와 봇 하나가 있으면 짧은 경로로 빈 채팅 입력창에 도달해요. 비활성·미지원 모델은 자동 채택하지 않고 선택 근거를 보여줘요.
- 확인할 위치: [web/NewStory.tsx](../web/NewStory.tsx), [web/pendingStory.ts](../web/pendingStory.ts)

### C08 · P2 · 간단한 봇 생성과 저장 후 다음 행동을 짧게 만들기

- 구분: 흐름 단순화 후보
- 근거: 단계 2, 16 — 모바일 첫 화면은 대표 이미지·설명에 치우치고 이름은 약 y710에 있어요. 빈 로어·패키지 편집도 저장 전에 나타나요. 저장 뒤 화면은 아래에 남고 버튼은 새 revision 저장으로 바뀌어요.
- 개선: 첫 생성은 이름·설명/지침·선택 이미지 중심으로 만들고 패키지 제작은 추가 편집으로 열어요. 저장 후 봇 요약과 채팅 시작을 같은 위치에 보여줘요.
- 완료 조건: 이름과 지침을 입력해 봇을 저장하고 채팅을 시작하는 과정에서 위아래로 되돌아갈 필요가 없어요. 고급 패키지 제작 기능은 계속 접근 가능해요.
- 확인할 위치: [web/LibraryPanel.tsx](../web/LibraryPanel.tsx), [web/AssetEditor.tsx](../web/AssetEditor.tsx), [web/package.css](../web/package.css)

### C09 · P2 · 채팅 상단 아바타의 가로 늘어남 고치기

- 구분: 확인된 CSS 결함
- 근거: 단계 4, 9, 11 — 채팅 상단의 이니셜 아바타가 긴 막대가 돼요. 390px에서 width=166.5px, height=28px, flex=1 1 0%를 확인했어요. .story-context > span 규칙이 아바타 span에도 적용돼요.
- 개선: 아바타와 이름 컨테이너를 구분해 아바타의 고정 비율을 유지하고 이름만 남는 폭을 쓰게 해요.
- 완료 조건: 이미지 없음/있음과 긴 봇 이름 모두에서 아바타가 의도한 비율을 유지해요.
- 확인할 위치: [web/main.tsx:404](../web/main.tsx#L404), [web/style.css:399](../web/style.css#L399), [web/content-picker.css:3](../web/content-picker.css#L3)

### C10 · P2 · 서재에서 자료와 새 채팅이 먼저 보이게 하기

- 구분: 목록 단순화 후보
- 근거: 단계 1, 10 — 모바일은 폴더 드롭다운과 전체 폴더 칩, 검색·정렬·카드/목록·선택·개수가 연이어 나와요. 카드 하나가 왼쪽 좁은 열을 차지하며 새 채팅은 화면 아래에 걸려요. 목록은 더 빠르지만 관리 버튼이 제목 폭을 줄여요.
- 개선: 모바일은 전체 폭의 간단한 목록을 기본으로 하고 새 채팅을 주 행동으로 둬요. 정렬·다중 선택·보기는 목록 메뉴, 폴더 선택은 한 곳으로 합쳐요.
- 완료 조건: 390px에서 첫 자료와 새 채팅 행동이 첫 화면에 보여요. 정리 기능은 메뉴에서 일관되게 접근하고 검색·선택 상태가 보존돼요.
- 확인할 위치: [web/LibraryPanel.tsx](../web/LibraryPanel.tsx), [web/library.css](../web/library.css)

### C11 · P2 · 페르소나·모듈의 쓰임을 화면에서 설명하기

- 구분: 용어·안내 후보
- 근거: 단계 10 — 빈 페르소나·모듈 화면은 자료를 만들거나 폴더에서 옮기라는 공통 안내예요. 봇 상세에는 봇으로 새 채팅·페르소나로 사용·모듈로 추가가 동시에 보여 역할 차이를 알아야 해요.
- 개선: 페르소나는 내가 맡을 인물, 모듈은 대화에 더할 설정·지침처럼 일상 표현을 곁들여요. 빈 상태에 짧은 예시와 해당 역할의 만들기 행동을 제공해요.
- 완료 조건: 처음 보는 사용자가 역할 설명만으로 원하는 분류와 적용 결과를 구분할 수 있어요. 기존 공통 패키지의 다중 역할 사용은 유지해요.
- 확인할 위치: [web/LibraryPanel.tsx](../web/LibraryPanel.tsx), [docs/LIBRARY.md](../docs/LIBRARY.md)

### C12 · P2 · 채팅 이름 변경과 이어가기의 의미를 명확히 하기

- 구분: 대화 관리 후보
- 근거: 단계 9 — 기존 채팅 제목을 바꾸는 UI는 없고, 관리 메뉴에서 아래로 이동이 가장 강한 버튼이에요. 상단 포크는 즉시 사본을 만들고 첫 장면으로 이동했어요.
- 개선: 메뉴에 이름 변경을 제공하고 순서 이동은 보조로 둬요. 포크는 여기까지 새 채팅으로 이어가기라는 뜻을 드러내고, 생성 후 마지막 복사 장면과 원본으로 돌아가기 경로를 보여줘요.
- 완료 조건: 이름을 바꾸기 위해 새 채팅을 만들 필요가 없어요. 사본 생성 후 어느 대화에서 이어 쓰는지 명확하고 원본이 보존돼요.
- 확인할 위치: [web/BotNavigation.tsx:615](../web/BotNavigation.tsx#L615), [web/NewStory.tsx:674](../web/NewStory.tsx#L674), [server/chat-fork.ts](../server/chat-fork.ts)

### C13 · P2 · 채팅 설정을 일상 선택과 제작·진단으로 나누기

- 구분: 설정 구조 후보
- 근거: 단계 5, 7 — 일반 채팅 설정에 장착 패키지 v1, UTF-16 한도, PromptProgram, 표시 상태 모델과 상태 확인 모델, 서로 다른 저장 영역이 함께 나와요.
- 개선: 일상 화면은 인물·대화 방식·모델·번역/상태 사용만 보여줘요. 문맥 한도·역할별 실행·상태 정의는 고급 설정으로 묶고 저장 범위와 다음 생성 적용을 한 번에 설명해요.
- 완료 조건: 표시용 장면 상태와 사실 상태/기억의 차이를 짧은 설명으로 구분해요. 사용자는 무엇이 저장됐는지 알 수 있고 진행 중·과거 Run 설정은 바뀌지 않아요.
- 확인할 위치: [web/ProfileEditor.tsx](../web/ProfileEditor.tsx), [web/WorkspacePanels.tsx](../web/WorkspacePanels.tsx)

### C14 · P2 · 프롬프트의 기본 지침 편집을 앞에 두기

- 구분: 제작 흐름 후보
- 근거: 단계 12 — 새 프롬프트는 9개 블록부터 보여주고 지침 본문은 블록 이름·종류·역할·정렬 뒤에 있어요. backgroundLore, postEverything, Current input 같은 내부 명칭이 기본 화면에 나와요.
- 개선: 기본 제작에서는 이름·역할·지침 본문과 미리보기를 먼저 보여줘요. 기존 AST 전체 구성은 고급 모드에서 그대로 편집하고, 두 모드가 표현하지 못하는 부분을 명확히 표시해요.
- 완료 조건: 짧은 지침은 내부 슬롯을 몰라도 만들 수 있어요. 고급 모드를 왕복해도 블록·조건·캐시·출처가 손실되지 않아요.
- 확인할 위치: [web/PromptEditor.tsx](../web/PromptEditor.tsx), [web/PromptComposer.tsx](../web/PromptComposer.tsx), [core/prompt-program.ts](../core/prompt-program.ts)

### C15 · P2 · 로어의 본문보다 불필요한 배치 설정이 먼저 나오지 않게 하기

- 구분: 제작 흐름 후보
- 근거: 단계 16 — 새 로어 기본은 필요할 때 읽기인데 고정 포함 때의 배치·묶음·순서와 기술 설명이 본문 전에 보여요. 모바일에서는 목록·분류와 이 필드를 지나야 본문에 도달해요.
- 개선: 이름·검색 설명·본문을 먼저 놓고, 고정 포함을 고를 때 관련 배치를 펼쳐요. 작은 화면은 로어 목록과 선택한 로어 편집을 단계로 나눠요.
- 완료 조건: 자동 로어 작성에 사용하지 않는 배치 필드를 입력할 필요가 없어요. 기존 배치값을 숨긴다는 이유로 삭제하거나 실행 계약을 바꾸지 않아요.
- 확인할 위치: [web/LoreEditor.tsx](../web/LoreEditor.tsx), [web/package.css](../web/package.css), [docs/LORE-CONTEXT.md](../docs/LORE-CONTEXT.md)

### C16 · P2 · 모바일 설정의 탐색 영역과 안내를 줄이기

- 구분: 모바일 배치 후보
- 근거: 단계 14, 15 — 모바일 모델 편집 첫 화면에서 설정 탐색이 세 줄, 모델/연결 탭과 새로고침, 목록으로, 적용 안내가 이어지고 하단 저장 버튼까지 겹쳐 실제 입력란이 화면 밖이에요.
- 개선: 설정 홈→선택한 상세의 구조로 바꾸거나 탐색을 한 줄 선택으로 줄여요. 반복 안내는 접고 현재 편집 제목과 저장 상태를 고정해요.
- 완료 조건: 390/360px의 모델 편집 첫 화면에 핵심 입력란이 보여요. 저장·취소는 찾기 쉽고 키보드가 열려도 입력란을 가리지 않아요.
- 확인할 위치: [web/WorkspacePanels.tsx:219](../web/WorkspacePanels.tsx#L219), [web/ProviderManagement.css](../web/ProviderManagement.css), [web/product.css](../web/product.css)

### C17 · P2 · 버튼 강조·작은 문구·편집 초점을 일관되게 정리하기

- 구분: 시각 우선순위·접근성 위험
- 근거: 단계 7, 9, 12, 16 — 채팅 메뉴는 아래로 이동, 프롬프트 블록은 삭제까지 짙은 녹색이에요. 미저장 확인은 초안 버리고 이동이 가장 강하게 보이고, 모바일 작성창의 보조 선택 문구는 10px예요. 원문 편집 자동 초점 누락은 직접 확인했어요.
- 개선: 주 행동 하나에 강조를 쓰고 파괴적 행동은 별도 의미의 스타일로 구분해요. 작은 선택 문구와 아이콘 버튼의 읽기·눌림 영역을 점검하고 편집 시작/종료 초점 규칙을 공통화해요.
- 완료 조건: 삭제·버리기와 저장·전송이 시각적으로 구분돼요. 실제 터치·키보드·스크린리더에서 동작 이름, 초점 이동, 가림 여부를 별도 확인해요.
- 확인할 위치: [web/style.css](../web/style.css), [web/product.css](../web/product.css), [web/SourceReader.tsx](../web/SourceReader.tsx)

### C18 · P3 · 데이터 관리에서 사용자와 서버 관리자 절차를 구분하기

- 구분: 안내 개선 후보
- 근거: 단계 15 — 모바일 데이터 관리에 SQLite·빈 DB·NR_DB 경로와 서버 종료 절차가 바로 나와요. 현재 DB에 자료가 있어 복원이 불가능한 이유는 긴 설명 안에 있어요.
- 개선: 백업 받기와 복원을 나누고 현재 화면에서 가능한 일과 관리자 준비가 필요한 일을 명시해요. 서버 경로 등 세부 절차는 관리자 안내로 연결해요.
- 완료 조건: 사용자가 백업 범위와 복원 전제를 이해할 수 있어요. 빈 DB 조건을 유지하며 기존 자료를 지우는 우회 동작을 추가하지 않아요.
- 확인할 위치: [web/WorkspacePanels.tsx](../web/WorkspacePanels.tsx), [docs/SELF-HOST.md](../docs/SELF-HOST.md)

## 직접 밟은 흐름과 화면

| 단계 | 사용 흐름 | 판정 |
|---:|---|---|
| 1 | 처음 진입·빈 서재 | 개선 필요 |
| 2 | 봇 생성·저장 후 채팅 시작 | 개선 필요 |
| 3 | 새 채팅 설정 | 개선 필요 |
| 4 | 실제 본문 생성·실패 후 재시도 | 생성 성공 / 안내 개선 |
| 5 | 장면 상태·번역 실행 | 완료 실패 |
| 6 | 읽기 설정·집중 읽기 | 양호 |
| 7 | 원문 수정·메시지 행동·중지 | 혼합 |
| 8 | 장면 목록·장면 이동 | 양호 |
| 9 | 채팅 포크·관리 메뉴 | 개선 필요 |
| 10 | 서재 카드·목록·상세·역할 분류 | 개선 필요 |
| 11 | 미전송 초안 보존·채팅 검색 | 양호 |
| 12 | 프롬프트 생성·지침·전송 미리보기 | 개선 필요 |
| 13 | 앱 일반 설정 | 양호 |
| 14 | 모델 프리셋 목록·편집 | 모바일 개선 필요 |
| 15 | 에이전트·데이터 관리·접근 보안 | 안내 확인 / 실행 미검증 |
| 16 | 자료 편집·로어·시작·옵션·행동·이탈 보호 | 혼합 |

### 01. 처음 진입·빈 서재 — 개선 필요

생성 버튼은 찾을 수 있지만 자료가 없는 상태부터 폴더·검색·정렬·보기 전환이 중복돼요.

![처음 진입·빈 서재 · 01-desktop-empty-library.jpg](../output/uiux-audit-2026-09-08/01-desktop-empty-library.jpg)

### 02. 봇 생성·저장 후 채팅 시작 — 개선 필요

합성 봇 저장은 성공했어요. 모바일은 대표 이미지와 긴 패키지 편집을 지나야 저장할 수 있고, 저장 뒤 채팅 시작은 화면 위에 있어요.

![봇 생성·저장 후 채팅 시작 · 03-mobile-new-bot.jpg](../output/uiux-audit-2026-09-08/03-mobile-new-bot.jpg)

![봇 생성·저장 후 채팅 시작 · 04-mobile-new-bot-save.jpg](../output/uiux-audit-2026-09-08/04-mobile-new-bot-save.jpg)

![봇 생성·저장 후 채팅 시작 · 05-mobile-bot-created.jpg](../output/uiux-audit-2026-09-08/05-mobile-bot-created.jpg)

### 03. 새 채팅 설정 — 개선 필요

본문·번역 모델, 페르소나·모듈·프롬프트를 먼저 선택해요. 모델이 하나여도 본문 모델은 자동 선택되지 않았어요.

![새 채팅 설정 · 06b-mobile-new-chat-ready.jpg](../output/uiux-audit-2026-09-08/06b-mobile-new-chat-ready.jpg)

![새 채팅 설정 · 07-desktop-new-chat.jpg](../output/uiux-audit-2026-09-08/07-desktop-new-chat.jpg)

### 04. 실제 본문 생성·실패 후 재시도 — 생성 성공 / 안내 개선

본문 두 건을 완료했어요. 처음의 실행 환경 인증 오류는 제품 결함에서 제외했지만, 완료 후에도 이전 본문 실패가 하단 대표 상태로 남는 것을 확인했어요.

![실제 본문 생성·실패 후 재시도 · 12-mobile-failed-turn-expanded.jpg](../output/uiux-audit-2026-09-08/12-mobile-failed-turn-expanded.jpg)

![실제 본문 생성·실패 후 재시도 · 17-desktop-live-response.jpg](../output/uiux-audit-2026-09-08/17-desktop-live-response.jpg)

### 05. 장면 상태·번역 실행 — 완료 실패

초기 자동 상태는 모델 미지정으로 실패했어요. 모델 지정 후 상태 두 건은 출력 검증에서, 번역 한 건은 보조 실행에서 실패했어요. 원문은 유지됐어요.

![장면 상태·번역 실행 · 18-desktop-auxiliary-recovery.jpg](../output/uiux-audit-2026-09-08/18-desktop-auxiliary-recovery.jpg)

![장면 상태·번역 실행 · 23-mobile-auxiliary-failures.jpg](../output/uiux-audit-2026-09-08/23-mobile-auxiliary-failures.jpg)

### 06. 읽기 설정·집중 읽기 — 양호

테마·글자 크기 조절과 집중 읽기가 동작해요. 좁은 화면에서도 본문 가로 넘침 없이 읽을 수 있었어요.

![읽기 설정·집중 읽기 · 20-desktop-reading-settings.jpg](../output/uiux-audit-2026-09-08/20-desktop-reading-settings.jpg)

![읽기 설정·집중 읽기 · 22-mobile-focus-reading.jpg](../output/uiux-audit-2026-09-08/22-mobile-focus-reading.jpg)

![읽기 설정·집중 읽기 · 64-mobile-360-focus-reading.jpg](../output/uiux-audit-2026-09-08/64-mobile-360-focus-reading.jpg)

### 07. 원문 수정·메시지 행동·중지 — 혼합

중지는 성공했고 완료 원문은 남았어요. 원문 수정창은 화면 밖에 열렸고, 완료 요청 수정·응답 재생성·메시지 버전 전환은 현재 UI에 없어요.

![원문 수정·메시지 행동·중지 · 24-mobile-source-edit.jpg](../output/uiux-audit-2026-09-08/24-mobile-source-edit.jpg)

![원문 수정·메시지 행동·중지 · 25c-mobile-source-edit-focused.jpg](../output/uiux-audit-2026-09-08/25c-mobile-source-edit-focused.jpg)

![원문 수정·메시지 행동·중지 · 29-mobile-cancel-clicked.jpg](../output/uiux-audit-2026-09-08/29-mobile-cancel-clicked.jpg)

### 08. 장면 목록·장면 이동 — 양호

목록에서 두 번째 장면으로 이동했고 현재 장면 표시가 2/2로 바뀌었어요. 전체 목록 검색 입력도 제공돼요.

![장면 목록·장면 이동 · 30-mobile-scene-list.jpg](../output/uiux-audit-2026-09-08/30-mobile-scene-list.jpg)

![장면 목록·장면 이동 · 63-mobile-360-original-chat.jpg](../output/uiux-audit-2026-09-08/63-mobile-360-original-chat.jpg)

### 09. 채팅 포크·관리 메뉴 — 개선 필요

포크는 클릭 즉시 사본을 만들고 첫 장면으로 이동했어요. 메뉴에는 폴더·순서·삭제만 있고 기존 채팅 이름 변경은 없어요.

![채팅 포크·관리 메뉴 · 31-mobile-chat-fork.jpg](../output/uiux-audit-2026-09-08/31-mobile-chat-fork.jpg)

![채팅 포크·관리 메뉴 · 32-mobile-navigation.jpg](../output/uiux-audit-2026-09-08/32-mobile-navigation.jpg)

![채팅 포크·관리 메뉴 · 33-mobile-chat-menu.jpg](../output/uiux-audit-2026-09-08/33-mobile-chat-menu.jpg)

### 10. 서재 카드·목록·상세·역할 분류 — 개선 필요

목록·상세 진입은 정상이에요. 모바일 카드의 새 채팅은 화면 아래에 걸리고, 페르소나·모듈의 빈 상태는 역할을 충분히 설명하지 않아요.

![서재 카드·목록·상세·역할 분류 · 34-mobile-library.jpg](../output/uiux-audit-2026-09-08/34-mobile-library.jpg)

![서재 카드·목록·상세·역할 분류 · 35-mobile-library-list.jpg](../output/uiux-audit-2026-09-08/35-mobile-library-list.jpg)

![서재 카드·목록·상세·역할 분류 · 36-mobile-bot-detail.jpg](../output/uiux-audit-2026-09-08/36-mobile-bot-detail.jpg)

![서재 카드·목록·상세·역할 분류 · 60-mobile-persona-empty.jpg](../output/uiux-audit-2026-09-08/60-mobile-persona-empty.jpg)

![서재 카드·목록·상세·역할 분류 · 61-mobile-module-empty.jpg](../output/uiux-audit-2026-09-08/61-mobile-module-empty.jpg)

### 11. 미전송 초안 보존·채팅 검색 — 양호

포크 채팅에 둔 초안은 서재를 다녀와도 유지됐어요. 검색 결과 없음과 키보드로 검색어를 지운 뒤 목록 복원을 확인했어요.

![미전송 초안 보존·채팅 검색 · 37-mobile-draft-after-library.jpg](../output/uiux-audit-2026-09-08/37-mobile-draft-after-library.jpg)

![미전송 초안 보존·채팅 검색 · 62-mobile-chat-search-empty.jpg](../output/uiux-audit-2026-09-08/62-mobile-chat-search-empty.jpg)

### 12. 프롬프트 생성·지침·전송 미리보기 — 개선 필요

합성 전송 미리보기는 성공했어요. 짧은 지침 편집도 9개 블록과 기술적 필드 안에서 시작해요.

![프롬프트 생성·지침·전송 미리보기 · 38-mobile-prompts.jpg](../output/uiux-audit-2026-09-08/38-mobile-prompts.jpg)

![프롬프트 생성·지침·전송 미리보기 · 39-mobile-prompt-create.jpg](../output/uiux-audit-2026-09-08/39-mobile-prompt-create.jpg)

![프롬프트 생성·지침·전송 미리보기 · 41b-desktop-prompt-message-ready.jpg](../output/uiux-audit-2026-09-08/41b-desktop-prompt-message-ready.jpg)

![프롬프트 생성·지침·전송 미리보기 · 43-desktop-prompt-preview-result.jpg](../output/uiux-audit-2026-09-08/43-desktop-prompt-preview-result.jpg)

### 13. 앱 일반 설정 — 양호

테마와 Enter 전송 방식이 간결하게 구분돼요. 채팅 설정은 Escape로 닫을 수 있었어요.

![앱 일반 설정 · 44-desktop-settings-general.jpg](../output/uiux-audit-2026-09-08/44-desktop-settings-general.jpg)

### 14. 모델 프리셋 목록·편집 — 모바일 개선 필요

저장된 모델 수정 화면과 종료를 확인했어요. 모바일 첫 화면은 탐색·안내·저장 영역 때문에 실제 입력란이 보이지 않아요.

![모델 프리셋 목록·편집 · 45-desktop-provider-models.jpg](../output/uiux-audit-2026-09-08/45-desktop-provider-models.jpg)

![모델 프리셋 목록·편집 · 46-desktop-model-editor.jpg](../output/uiux-audit-2026-09-08/46-desktop-model-editor.jpg)

![모델 프리셋 목록·편집 · 47-mobile-model-editor.jpg](../output/uiux-audit-2026-09-08/47-mobile-model-editor.jpg)

### 15. 에이전트·데이터 관리·접근 보안 — 안내 확인 / 실행 미검증

세 설정 화면을 열어 확인했어요. Codex 연결, 데이터 복원·로그아웃은 실행하지 않았어요. 데이터 복원 안내는 서버 관리자 용어에 의존해요.

![에이전트·데이터 관리·접근 보안 · 48-mobile-settings-agents.jpg](../output/uiux-audit-2026-09-08/48-mobile-settings-agents.jpg)

![에이전트·데이터 관리·접근 보안 · 49-mobile-settings-data.jpg](../output/uiux-audit-2026-09-08/49-mobile-settings-data.jpg)

![에이전트·데이터 관리·접근 보안 · 50-mobile-settings-security.jpg](../output/uiux-audit-2026-09-08/50-mobile-settings-security.jpg)

![에이전트·데이터 관리·접근 보안 · 51b-desktop-work-status-ready.jpg](../output/uiux-audit-2026-09-08/51b-desktop-work-status-ready.jpg)

### 16. 자료 편집·로어·시작·옵션·행동·이탈 보호 — 혼합

빈 로어 초안을 만들고 미저장 이탈 확인을 거쳐 버렸어요. 시작·옵션·행동 탭은 열었고 저장은 하지 않았어요. 로어 본문 앞에 적용되지 않는 고정 배치 설정이 길게 나와요.

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 52-desktop-bot-edit.jpg](../output/uiux-audit-2026-09-08/52-desktop-bot-edit.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 53-desktop-lore-editor.jpg](../output/uiux-audit-2026-09-08/53-desktop-lore-editor.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 54-desktop-package-start.jpg](../output/uiux-audit-2026-09-08/54-desktop-package-start.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 55-desktop-package-options.jpg](../output/uiux-audit-2026-09-08/55-desktop-package-options.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 56-desktop-package-behavior.jpg](../output/uiux-audit-2026-09-08/56-desktop-package-behavior.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 57-mobile-360-lore-editor.jpg](../output/uiux-audit-2026-09-08/57-mobile-360-lore-editor.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 58-mobile-360-lore-fields.jpg](../output/uiux-audit-2026-09-08/58-mobile-360-lore-fields.jpg)

![자료 편집·로어·시작·옵션·행동·이탈 보호 · 59-mobile-unsaved-guard.jpg](../output/uiux-audit-2026-09-08/59-mobile-unsaved-guard.jpg)

## 유지할 장점

- 실제 본문 생성 두 건이 완료됐고, 보조 작업 실패와 중지 후에도 완료 원문이 보존됐어요.
- 집중 읽기·테마·글자 크기·장면 목록이 실제로 동작했어요. 확인한 좁은 화면에서 본문 가로 넘침은 없었어요.
- 서재 왕복 후 미전송 채팅 초안이 유지됐고, 자료 편집 이탈은 확인창으로 보호됐어요.
- 프롬프트의 합성 전송 미리보기는 10개 메시지를 보여줬고 추가 모델 호출을 만들지 않았어요.
- 채팅 포크는 원문 두 건을 복사했으며 공급자 호출을 추가하지 않았어요.

## 제한과 제외한 판정

- 모바일은 실제 브라우저의 좁은 뷰포트 검사예요. 실제 iOS/Android 기기, 소프트 키보드, 안전 영역, 터치 제스처, IME, 스크린리더는 검사하지 않았어요. 네이티브 데스크톱 패키지 검사도 아니에요.
- 32번 화면의 채팅 행 메뉴는 뷰포트만 줄여 숨겨져 보였지만, 소스에 hover:none/pointer:coarse 표시 규칙이 있어 실제 터치 기기의 접근 불가 문제로 판정하지 않았어요(web/bot-navigation.css:331).
- 같은 모델·현재 기본 프롬프트·합성 자료의 소수 실행 결과예요. 모든 실제 작품, 장문 대화, 다른 모델의 성공률·품질·성능을 뜻하지 않아요.
- 실제 이미지 업로드/생성, 상태·기억의 정상 완료 흐름, 데이터 내보내기/복원, 폴더 생성·이동·삭제, 보관 전개 전환, 연결 등록·삭제, 실제 Codex 로그인은 이번 조작 범위에 포함하지 않았어요. 패키지의 모든 탭·필드를 저장·실행 검증하지 않았어요.
- 최초의 CREDENTIAL_UNAVAILABLE는 제한된 실행 환경의 인증 연결 실패였고 승인된 로컬 실행으로 해소됐어요. 앱 자체의 공급자 오류로 세지 않았어요.
- 최초 감사에서는 자동 승인 검토가 '장면 상태 자동 실행 끄기·저장'을 거절해 미검증으로 남겼어요. 이후 사용자의 명시적 추가 승인에 따라 OFF 저장·새로고침 유지·실제 본문 1건 완료·자동 후속 작업 0개를 확인했어요(PASS). 후속 결과는 project-plan/UIUX-AUTO-STATUS-OFF-2026-09-08.md에 있어요. 이 보고서의 14회는 최초 감사 집계이며 후속 본문 1회를 더한 누적 시도는 15회예요.
- 00은 구형 실행 화면, 06과 51은 로딩 화면, 41은 크기 전환 직후 잘린 화면이므로 현재 준비된 화면의 근거에서 제외했어요. 27→28의 첫 중지 시도는 응답 완료로 버튼이 사라져 실제 클릭하지 못했으며, 29의 두 번째 중지 시도로 확인했어요.
- 스크린샷과 일부 DOM/초점 측정으로 전체 접근성 준수를 주장하지 않아요. CSS·키보드·터치 위험은 구현 후보와 후속 실제 기기 검사로 구분했어요.
- 기능은 바꾸지 않았으므로 이번 감사에 quality:full이나 합성 회귀를 다시 실행하지 않았어요. UI 동작 관찰·메타데이터 검산·소스/빌드 일치 확인을 증거로 사용했어요.

## 실행 동일성

- source SHA-256: 664d189428dc335f6636b53f8c0008f881df700e0383a1d268da68486b402ab7
- dist SHA-256: 88baacf093a08333a649b52db6c9b4e90be446013b080b39ad45ea4f2f34e6e8
- 감사 시작과 종료에 현재 소스 fingerprint가 격리 빌드와 같음을 확인했어요.

[환경 증거](../output/uiux-audit-2026-09-08/environment.json) · [모바일 측정](../output/uiux-audit-2026-09-08/mobile-metrics.json) · [원문 수정 초점 측정](../output/uiux-audit-2026-09-08/source-edit-position.json)
