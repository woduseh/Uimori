# 화면 갤러리 · 디자인 검토를 위한 일괄 캡처

`npm run verify:gallery`는 빌드된 앱을 격리된 테스트 모드 서버에 띄우고, 합성 자료를 한 번 시딩한 뒤, 목록에 있는 모든 화면과 모달을 **412×844(모바일)·2560×900(데스크톱) × light·dark**로 캡처해요. 이어서 목록에 있는 **여정**(서재의 봇에서 첫 채팅을 만들고, 두 장면을 받고, 포크하기까지)을 두 폭에서 한 단계씩 걸으며 단계마다 캡처하고 상호작용 횟수를 세요. 단정이 없어서 한 기계에서 2분 안에 끝나고, 결과는 한 장의 contact sheet와 수치 파일로 남아요. 디자인 검토를 시작할 때 전체 브라우저 회귀(`verify:redesign`) 대신 이 갤러리를 먼저 열어요.

폭은 `fixtures/browser-viewports.json`의 공통 기준을 사용하고 높이는 갤러리의 기존 844/900px를 유지해요. 이 기준은 2026-09-12부터 적용하며 과거 갤러리의 수치와 캡처 파일은 그대로 보존해요.

갤러리는 **기록**이에요. 캡처와 여정 단계가 모두 성공하고 정리가 끝나면 PASS이고, 원칙 수치를 못 맞춘 화면이 있어도 실행은 실패하지 않아요. 판정과 개선 결정은 사람이 하고, 수치를 단정으로 강제하는 일은 해당 화면의 `verify-*` 검사가 맡아요.

## 산출물

`output/playwright/gallery-<시각>-<id>/` 아래에 남아요. 다른 `verify-*`와 같은 소유권·정리 규약(`ownership.json`, `summary.json`, `evidence-db/`, `artifactScan`)을 따르므로 `npm run cleanup`으로 함께 정리돼요.

| 파일 | 내용 |
| --- | --- |
| `index.html` | 화면 × (폭·테마) 표와, 그 아래 여정별 단계 × 폭 표. 각 캡처 아래에 수치 배지가 붙고, 여정 단계에는 그 단계의 상호작용 수와 누적 수가 붙어요. 배지 색은 기록이며 판정이 아니에요. |
| `screens/<id>-<폭>-<테마>.png` | 뷰포트 캡처. 실패한 화면은 `-failed.png`로 마지막 상태를 남겨요. |
| `journeys/<여정>-<단계>-<폭>.png` | 여정의 각 단계가 안정된 뒤의 캡처(light만). 실패한 단계는 `-failed.png`를 남기고 그 폭의 여정은 거기서 멈춰요. |
| `metrics.json` | 화면별 수치. 항목마다 `metric`, `value`, `target`, `pass`(`null`은 기록만), `detail`, `source`가 있어요. |
| `journey.json` | `source`, `rubric`, 여정 실행(`runs`: 폭별 단계 목록, 단계마다 `interactions`·`cumulativeInteractions`·`elapsedMs`·`url`, 중단됐으면 `failedStep`)과 단계별 수치(`results`). |
| `captures.json` | 캡처 목록(시작 시각 `at`, 소요 시간 `elapsedMs`)과 실패 이유. |
| `summary.json` | 실행 상태, 서버·빌드 identity, 시딩 결과와 경고, `screens`·`journeysDefined`(목록 개수), `gallery.rubric`(충족·미충족·기록만 개수와 미충족 화면 목록), `gallery.journeys`(폭별 완주 여부·단계 수·상호작용 수). |

## 수치와 출처

수치의 정의와 목표는 [AI 제품 UI 원칙 4절](UI-PRINCIPLES-AI-PRODUCTS.md#4-적용-순서-제안)을 따르고, 구현은 [`tests/fixtures/ui-metrics.ts`](../tests/fixtures/ui-metrics.ts)에 있어요. 브라우저 검사가 같은 함수를 import하므로 갤러리의 기록과 검사의 단정이 같은 계산을 써요. 목표를 바꾸려면 원칙 문서를 먼저 고쳐요.

| 이름 | 계산 | 채점 폭 |
| --- | --- | --- |
| `header-controls` | `header.workspace-header` 안 `button, [role=button], summary` 중 보이는 것의 개수 (탐색 토글 포함) | 좁은 화면만 (4개 이하) |
| `composer-dock` | `.composer-dock` 높이 | 둘 다 (모바일 52px, 데스크톱 56px) |
| `body-share` | 첫 `[data-testid=source-text]`의 뷰포트 안 높이 ÷ 뷰포트 높이 | 좁은 화면만 (0.6 이상) |
| `menu-in-viewport` | 열린 `details[open] .action-menu-body`와 모든 항목이 뷰포트 안 | 둘 다 |
| `overflow` | `scrollWidth − innerWidth` | 둘 다 (1px 이하) |
| `touch-44` | 보이는 `button, [role=button], summary, checkbox, radio` 중 44px 미만인 것의 개수 (본문 안 제외) | 좁은 화면만 (0개) |
| `min-font` | 텍스트를 직접 가진 보이는 요소 중 계산된 `font-size`가 12px 미만인 것의 개수 | 둘 다 (0곳) |
| `font-size-values` | 로드된 스타일시트에 선언된 `font-size` 값의 종수 (`inherit` 등 제외). 실행당 한 번, `screen: "*"` | 8종 이하 |
| `border-radius-values` | 선언된 `border-radius`를 성분으로 쪼갠 뒤 모양(직각 `0`, 원 `50%`, 알약 999px 이상)을 제외한 길이 값의 종수. `detail`에 `scalars`·`shapes`·`raw`를 함께 기록 | 길이 값 3종 이하 |

"좁은 화면"은 `useCompactLayout`과 같은 760px 이하예요. 채점하지 않는 폭에서도 값은 기록해요.

## 화면 목록

[`scripts/gallery/screens.mjs`](../scripts/gallery/screens.mjs)가 목록이에요. 항목 하나는 `id`, `title`, `principles`(원칙 문서의 P·F 식별자), `url`, 선택 사항으로 `ready`(기다릴 요소), `steps`, `viewports`, `themes`, `metrics`, `settle`, `fullPage`를 가져요.

- `url`의 `$chat.main` 같은 값은 시딩 결과로 바뀌어요. 이름은 [`scripts/gallery/seed.mjs`](../scripts/gallery/seed.mjs)의 반환값이에요.
- `steps`는 페이지가 준비된 뒤 차례로 실행돼요. 어휘는 [`scripts/gallery/steps.mjs`](../scripts/gallery/steps.mjs)에 있어요: `{ click: { label | role+name | testid | text | css, nth?, within? } }`, `{ fill: { <위치>, text } }`, `{ menu: 'chat' | 'scene' | 'app' | '<aria-label>' }`, `{ visible: <위치> }`, `{ press }`, `{ wait }`. 어떤 단계든 `when: 'compact' | 'wide'`를 붙이면 그 폭(760px 기준)에서만 실행돼요. 도우미 패널처럼 좁은 화면에서는 ⋯ 메뉴 안에, 넓은 화면에서는 헤더에 진입점이 있는 화면이 이 방식을 써요. 접근 가능한 이름에 의존하므로 라벨을 바꾸면 이 목록도 함께 바꿔요.
- 화면을 추가할 때는 원칙 식별자와 기다릴 요소를 함께 적어요. 기다릴 요소가 없으면 헤더가 보이는 시점에 캡처해요.

## 여정

[`scripts/gallery/journey.mjs`](../scripts/gallery/journey.mjs)가 목록이에요. 여정 하나는 `id`, `title`, `principles`, 시작 `url`·`ready`, 선택 사항으로 `viewports`, 그리고 `steps`를 가져요. 단계 하나는 `id`, `title`, `actions`(위 단계 어휘), 선택 사항으로 `ready`(단계가 끝났다고 볼 요소), `urlParam`(그 쿼리 값이 바뀔 때까지 기다림 · 새 채팅·포크), `settle`(캡처 전 대기, 기본 300ms), `metrics`를 가져요.

- 상호작용은 `click`·`fill`·`menu`·`press` 한 번을 1로 세요. `visible`·`wait`는 세지 않아요. 실행된 순간 세므로 단계가 그 뒤에 실패해도 든 횟수는 남아요. 같은 결과에 폭마다 몇 번이 드는지 비교하는 것이 목적이고, 실제 기기의 스크롤·IME 입력은 포함하지 않아요.
- `fill`의 `text`는 입력할 값이에요. 위치는 `label`·`testid`·`role`·`css`로 적어요.
- 여정은 화면 캡처가 모두 끝난 뒤 light 테마로만, 두 폭에서 각각 새 컨텍스트로 실행돼요. 서버에 채팅을 실제로 만들지만, 화면 캡처는 그보다 먼저 끝나므로 영향을 받지 않아요.
- 현재 여정은 `first-chat` 하나예요: 서재 봇 탭 → `<봇> 새 채팅` → `채팅 만들기` → 첫 요청·첫 장면 → 둘째 요청·둘째 장면 → 채팅 ⋯ `채팅 포크`. 페르소나·시작 프롬프트 선택은 포함하지 않아요.

## 테스트 모드 딥링크

모달과 화면 대부분은 URL로 열 수 없어서, 테스트 모드 서버에서만 아래 파라미터를 읽어요. 구현은 [`web/usePanelDeepLink.ts`](../web/usePanelDeepLink.ts)이고 `/api/health`의 `testMode`가 참일 때만 동작해요. 적용한 뒤 파라미터는 주소에서 지워지고, `chat`·`branch`·`source`는 건드리지 않아요.

| 파라미터 | 값 |
| --- | --- |
| `panel` | `navigation`, `new`, `story`(채팅 설정), `branches`, `tasks`, `settings`, `reading`, `outline` |
| `section` | `panel=story`일 때 `characters`, `prompts`, `models`, `story`, `images`, `runtime` · `panel=settings`일 때 `general`, `models`, `prompts`, `connections`, `agents`, `illustrations`, `data`, `security` |
| `destination` · `tab` | `destination=library`와 `bot`, `persona`, `module`, `prompts` |

채팅이 필요한 패널(`story`, `tasks`, `branches`, `outline`)은 `chat`을 함께 주고, 채팅이 불러와진 뒤에 열려요. 알 수 없는 값은 무시해요. 브라우저 검사도 같은 파라미터로 화면에 바로 들어갈 수 있어요(`tests/panel-deep-link-browser.spec.ts`).

## 시딩 자료

봇 두 개(하나는 긴 한글 이름), 페르소나, 모듈, 장면 3개가 쓰인 채팅(제목과 첫 장면 id도 `$chat.main.title`·`$source.first`로 쓸 수 있어요), 빈 채팅, 요청이 실패한 채팅(테스트 모드 `fail-next` 주입)이에요. 실패 주입이 안 되면 `summary.json`의 `seed.warnings`에 남고 실행은 계속돼요. 모두 합성 문장이며 개인 자료는 쓰지 않아요.

## 한계

- 이 캡처는 실제 기기, IME, 실제 모델, 배포 환경의 증거가 아니에요.
- 수치는 정의된 요소 선택자에 묶여 있어요. 클래스 이름이 바뀌면 `ui-metrics.ts`도 따라 바꿔야 하고, 값이 `null`이나 `false`로 떨어지면 먼저 선택자를 의심해요.
- Windows CI에서는 아직 실행하지 않았어요. 캡처 시간과 글꼴 렌더링은 기계마다 달라요.
- 같은 기계에서 다른 브라우저 검사가 동시에 돌면 준비 대기(10초)와 단계 대기(15초)가 넘어 개별 캡처가 실패할 수 있어요. 2026-09-10에 다른 세션의 spec 44건과 겹친 실행은 캡처 2개가 대기 초과로 빠졌고, 혼자 돌린 직전 실행은 모두 성공했어요. 혼자 돌리고, `captures.json`의 `elapsedMs`가 평소(중앙값 약 0.5초)보다 크게 튀면 결과보다 기계 상태를 먼저 의심해요.
