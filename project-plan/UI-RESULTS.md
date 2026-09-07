# UI 구현·검증 기록

최신 통합 검증은 [Sol 통합 요약](../output/sol-provider/2026-09-07/summary.json)이에요. [기존 UI](../output/playwright/ui-2026-09-07T02-09-41-126Z-d7e26af4/summary.json) 9 unit + 19 browser와 [Sol 설정 UI](../output/playwright/sol-ui-2026-09-07T02-10-02-278Z-1a8f24c4/summary.json) 2 browser가 PASS예요. 아래는 단계별 고정 화면·측정 기록이며, 당시의 source/build·지원 범위·미커밋 설명을 현재 상태로 해석하지 않아요. 실제 휴대폰·키보드/IME 검증은 별도예요.

# 번역·직접 편집 UI 후속 · 2026-09-07

원문 우선 표시와 **번역 보기**의 명시 시작, 최신 번역 하나, **원문 수정 / 번역 수정** 편집기를 추가했어요. 초안 재복원·저장 충돌·이야기 간 비동기 응답 경계·직접 저장한 번역 보호를 실제 브라우저에서 확인했어요.

UI **9개 렌더 검사+19개 브라우저 검사**와 M0/M1 브라우저 **9개**가 PASS예요. [해당 단계 완료 근거](../output/translation-final/2026-09-07/summary.json), [UI 보고서](../output/playwright/ui-2026-09-07T01-11-15-192Z-ef48f575/summary.json). 390×844의 [원문 편집](../output/playwright/ui-2026-09-07T01-11-15-192Z-ef48f575/browser/ui-browser-UI18-source-and-22bd6-with-one-latest-translation/source-editor-mobile.png)·[번역 편집](../output/playwright/ui-2026-09-07T01-11-15-192Z-ef48f575/browser/ui-browser-UI18-source-and-22bd6-with-one-latest-translation/translation-editor-mobile.png) 화면을 직접 검토했어요. 캡처는 현재 스크롤 위치이며 전체 편집기를 한 화면에 표시한 근거는 아니에요. 실제 휴대폰 키보드·IME 검증과 이전 UI14 성능 측정을 다시 수행한 주장은 하지 않아요.

아래는 이전 UI 개편의 역사적 범위·수치예요. 번역 UX 변경 당시 화면은 위 근거를, 최신 통합 source/build는 문서 첫머리의 Sol 통합 근거를 사용해요.

# Uimori UI-1–UI-3 결과 · 2026-09-06

기존 M1-local 앱을 이야기 탐색 → 원고 읽기 → 하단 이어쓰기 흐름으로 개편했어요. 기존 API와 파일 SQLite를 그대로 사용하며, 별도 데모 앱이나 live provider adapter는 추가하지 않았어요. 로컬 UI 구현과 아래 범위의 최종 검증을 완료했어요.

## 기준과 변경 범위

- 실제 저장소: `C:/Users/wodus/ai-workspace/uimori`, branch `codex/m1-local`, 시작 HEAD `87548d15c41fa0adb74284a1873c9d28e1dfe8ee`.
- 사용자 제공 `ui-redesign/UI_REDESIGN.md`, `CODEX_UI_TASK.ko.md`, `UI_ACCEPTANCE.json`, HTML 시안과 PNG 3장을 읽었어요. 지시서가 언급한 `SOURCE_MAP.json`은 제공된 디렉터리에 없었으며 실제 소스에서 연결 경로를 확인했어요. 사용자 제공 `ui-redesign/`은 수정하지 않았어요.
- `core/`, `server/`, DB schema와 migration은 변경하지 않았어요. 사용자 `.local/narrative.sqlite`를 열거나 migration하지 않았고 사용자 서버를 종료하지 않았어요.
- 추가 의존성은 `lucide-react` 1.41.0 하나예요. Node/npm/기존 lockfile을 유지했고 새 router/store/framework를 도입하지 않았어요. 로컬 변경만 남겼으며 이번 UI 작업을 commit/push/deploy하지 않았어요.

| 범위 | 결과와 주요 파일 |
| --- | --- |
| UI-1 셸 | `web/main.tsx`, `style.css`, `product.css`, `Dialog.tsx`, `WorkspacePanels.tsx`: 250px sidebar, 제한된 읽기 폭, 독립 reader 스크롤, 하단 composer, 모바일 메뉴·전체 높이 설정 패널, 밝은/어두운 테마. 서재·백업·작업 로그를 기본 원고에서 옮겼어요. |
| UI-2 원고·입력 | `SourceReader.tsx`, `Prose.tsx`, `useStory.ts`, `api.ts`: Run.request와 Source.runId 연결, 한국어 우선 보기, 안전한 Markdown/ruby 부분집합, 원문·번역·후속 상태 분리, 앵커·독서 위치·탭/분기별 초안/선택 범위 보존. |
| UI-3 자료·설정 | `LibraryPanel.tsx`, `ProfileEditor.tsx`, `library.css`, `NewStory.tsx`, `RuntimeSettings.tsx`: 검색·카드·이름으로 관련 자료 선택, 봇에서 새 이야기 시작, 페르소나/프리셋 선택, 창작 제어 전체 교체와 저장 충돌 보존. 모의 실행 제어는 개발자용 상세에 두었어요. |
| 검증·문서 | `tests/browser.spec.ts`, `product-browser.spec.ts`의 접근 경로 조정, `prose.test.ts`, `ui-browser.spec.ts`, `scripts/verify-ui.mjs`, `ui-evidence.mjs`, package scripts, README, CURRENT, 이 문서와 `design-qa.md`. |

입력창에서는 페르소나·창작 프리셋을 빠르게 바꿔요. 데스크톱은 본문 모델 선택도 노출하며, 좁은 모바일에서 모델은 이야기 설정 → 모델로 접근해요. 기본 Enter는 줄바꿈, Ctrl/Cmd+Enter는 보내기예요. Enter 보내기를 켜면 Shift+Enter로 줄을 바꿔요. 현재 지원하지 않는 reasoning/genre/live 연결을 지원하는 것처럼 표시하지 않았어요.

새 이야기의 profile 저장 실패는 같은 생성된 chat ID로 재시도하고 첫 전송을 막아요. 생성 POST 자체의 응답이 유실되어 ID를 확인하지 못한 경우에는 자동으로 중복 생성하지 않고 확인이 필요함을 알려요. 원문 요청 응답이 유실되면 최초 body/idempotency key로 결과를 재확인하며, 그 사이 작성한 새 초안을 보내거나 지우지 않아요.

## 최종 실행 결과

Windows 11 10.0.26200 / PowerShell / Node 24.14.0 / npm 11.14.1 / Chrome 152.0.7977.82에서 실행했어요. 자식 프로세스가 필요한 빌드·브라우저 검사는 승인된 로컬 실행을 사용했어요.

- 최종 source/build ID: `537ec723951758cb056ea32defddbe06794f28d63c43a74752bf1612a31a5ecc`
- dist SHA-256: `8d39c9db5e66903e5ea947cdaa7b16b1728ed0c9dc1371e83f2ee203cab2ce50`
- 문서 외의 소스·테스트·검증 스크립트를 고정한 뒤 아래 명령을 순차 실행했어요. 세 검증 summary의 ID와 dist hash가 같아요.

| 명령 | 결과 | 증거 |
| --- | --- | --- |
| `npm run check` | PASS | 최종 TypeScript 검사, exit 0 |
| `npm run build` | PASS | 위 build ID로 실제 production build, exit 0 |
| `npm run verify -- --milestone M0` | PASS: Vitest 13, Playwright 3, 검증기 selftest 11 | [summary](../output/playwright/2026-09-06T14-49-01-773Z-886b139a/summary.json) |
| `npm run verify -- --milestone M1-local` | PASS: Vitest 38, Playwright 4 | [summary](../output/playwright/2026-09-06T14-49-45-625Z-dbd23ca5/summary.json) |
| `npm run verify:ui` | PASS: Vitest 7, Playwright 6 | [summary](../output/playwright/ui-2026-09-06T14-50-28-209Z-b9a989e6/summary.json) |

필수 skip/실패는 모두 0, 소유 테스트 프로세스·runtime 정리와 합성 secret canary 검사는 PASS예요. M0의 검증기 selftest는 의도한 내부 실패를 감지하는 11개 검사로, 제품 기능 검사 개수와 구분해요. M0/M1의 선택 범위 밖 검사를 필수 skip으로 숨기지 않았어요.

기존 browser tests는 새 dialog·서재·작업 상세 경로를 사용하도록 바꿨어요. 원문 원시값은 명시적인 raw 상세에서 검사하고 UI 전용 테스트가 안전한 표시를 별도로 검사해요. revision-one M0 fixture 생성은 API로 유지하고 실제 봇-first 생성은 UI03에서 검사해요. snapshot/revision/idempotency/분기 ancestry/후손/job 귀속/복원·인증 assertion은 유지했어요. 요청 수락 후 sessionStorage를 지우므로 중복 명령 검사는 실제 브라우저가 전송한 원래 body를 사용해요.

좁은 반복 중 stale-response 전달 대기, 숨겨진 상세 locator, 중복 alert locator와 실패 후 hold barrier 정리를 고쳤어요. 제품 결함으로는 dialog 전환 시 이전 close 이벤트가 새 창을 닫는 문제, Tab이 dialog 밖으로 나가는 문제, 실패 요청 위에 첫 장면 안내가 남는 문제를 수정했어요. 수정 전의 중간 PASS나 환경 오류를 최종 증거로 재사용하지 않았어요.

## UI_ACCEPTANCE 연결

아래 PASS는 명시된 로컬 관찰 범위예요. UI 전용 summary의 테스트 제목 태그만으로 16개 항목 전체를 자동 통과로 바꾸지 않았어요.

| 항목 | 확인한 범위·증거 | 결과/남은 범위 |
| --- | --- | --- |
| UI01 | 긴 원고 여러 개에서도 기본 reader/composer와 관리 영역 분리 | 로컬 PASS |
| UI02 | 첫·중간·마지막 독서 위치에서 입력창이 viewport 내부 | 브라우저 PASS; 실제 키보드 별도 |
| UI03 | 봇·페르소나·프리셋 선택, profile 저장 실패/재시도, chat 하나와 생성 전 저장 | 자동 PASS; 생성 POST 자체 응답 유실은 확인 안내 경로 |
| UI04 | Markdown/인용/목록/한글, 제한된 ruby, raw HTML·위험 링크·이미지 요청 차단, source/hash 보존 | unit/browser/storage PASS |
| UI05 | 한국어 기본, 보기 전환 호출 0, 앵커, 늦은 도착·번역 실패만 재시도 | UI/P08/P10 PASS |
| UI06 | A→수정→B 그룹 전체 교체, 모델/연결 유지, profile 충돌 입력 보존 | 기존 P01 PASS |
| UI07 | 후보·후손·부모 snapshot 보존, 보기 전환 호출 0, 다른 탭 분리 | UI/P09/P13 PASS |
| UI08 | dialog Tab 순환·Escape·초점 복귀, label, composition 이벤트로 보내기 차단 | 자동/시각 PASS 범위; 실물 IME·스크린리더 별도 |
| UI09 | 360×800, 390×844, 768×1024, 1024×768, 1440×1000의 원고·서재·이야기 설정·연결 패널 | 가로 overflow 검사 PASS; 캡처 직접 검토 |
| UI10 | 번역/상태 늦은 완료·실패·재시도, 이미지 annotation/source 귀속, 본문/독서 위치·탭 이동 | UI/M0/P10 PASS; 실제 네트워크·폰 별도 |
| UI11 | 실제 loopback HTTP refused/partial, source/job 미커밋, 부분 출력·미확인 비용, 번역 실패와 재연결 | 로컬 API/시각 및 M0/P05 PASS; live 공급자 메시지 별도 |
| UI12 | 독립 context/탭, URL/Back/Forward/새로고침, 초안·커서, 응답 유실의 최초 body/key | UI/M0/P13 PASS |
| UI13 | 설정에서 연결·catalog 실패/manual model·JSON/SQLite 다운로드·보호된 복원·인증 | P04/P11/P12 PASS |
| UI14 | 동일 합성 chat의 목록/자료/에셋 규모별 입력·스크롤·GET·DOM 변화 및 browser rendering 비용 | MEASURED; 수치/범위 아래. 성능 향상·실기기 통과 주장 없음 |
| UI15 | 최종 source의 M0/M1-local, fresh reporter, required skip 0 | PASS |
| UI16 | 참조와 실제 기본/번역/서재/설정/실패/밝은·어두운 화면을 직접 열어 비교 | [design-qa](../design-qa.md) passed; 정적 시각 범위 |

## 실제 화면 증거

모두 실제 앱 + 실제 API + 별도 합성 SQLite예요. 한 원문은 10,901 UTF-16 code units이며 3개 원문과 번역이 있어요. tokenizer로 계산한 토큰 수가 아니에요. baseline은 위 HEAD의 build `45c815118c41c8be21f58f14f3f632a327fdd8ebc25b0507fc2b931c7b6c1fdb`예요.

| 상태 | 변경 전 | 변경 후 |
| --- | --- | --- |
| 데스크톱 기본 1440×1000 | [before](../output/ui-redesign/2026-09-06T14-15-36.974Z/before-1440-default.png) | [dark](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-dark.png), [light](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-light.png) |
| 모바일 기본 390×844 | [before](../output/ui-redesign/2026-09-06T14-15-36.974Z/before-390-default.png) | [dark](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-dark.png), [light](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-light.png) |
| 원문·번역 | before/after 각각 두 viewport의 `source.png`, `translation.png` | [모바일 원문](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-source.png), [번역](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-translation.png) |
| 서재 | [before](../output/ui-redesign/2026-09-06T14-15-36.974Z/before-1440-library.png) | [desktop](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-library.png), [mobile](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-library.png) |
| 이야기 설정 | [before mobile](../output/ui-redesign/2026-09-06T14-15-36.974Z/before-390-settings.png) | [desktop](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-settings.png), [mobile](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-settings.png) |
| 실패·진단 | 최종 합성 provider로 추가 관찰 | [요청 오류](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-failure.png), [부분 출력·비용 상세](../output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-partial-details.png) |

[manifest](../output/ui-redesign/2026-09-06T14-15-36.974Z/manifest.json), [최종 캡처 build](../output/ui-redesign/2026-09-06T14-15-36.974Z/final-capture-build.json), [오류 API 관찰](../output/ui-redesign/2026-09-06T14-15-36.974Z/errors.json), [실패 화면 DOM](../output/ui-redesign/2026-09-06T14-15-36.974Z/failure-dom.json)에서 경계와 identity를 확인할 수 있어요. 최종 서재에는 성능 측정용 100개 봇이 추가되어 baseline과 카드 수가 달라요. 시안과 실제 데이터가 다르므로 픽셀 일치를 주장하지 않아요.

## 화면 비용 측정

[원시 표본과 방법](../output/ui-redesign/2026-09-06T14-15-36.974Z/performance.json), [browser rendering 표본](../output/ui-redesign/2026-09-06T14-15-36.974Z/render-performance.json). Windows/Chrome, 1440×1000, 같은 활성 chat에서 3 trials/조건, trial당 입력 20회·스크롤 30프레임·실제 detail GET+JSON parse 5회예요.

첫 규모 비교는 14:45 UTC의 `40ffe95e…` 빌드에서 측정했어요. 이후 변경은 테스트/검증 스크립트와 원문이 없는 실패 화면의 empty-state 조건이며 이 표의 원문 3개가 있는 화면은 그대로예요. 14:49 UTC의 browser rendering 추가 표본과 최종 캡처는 `537ec723…` 빌드를 사용했어요. 서로 다른 시점의 표본을 하나의 최종 자동 테스트로 합산하지 않았어요.

| 관측 | 자료 8·에셋 3 | 자료 158·에셋 23 |
| --- | ---: | ---: |
| 입력 handler 진입→다음 RAF 중앙값 | 5.50 ms | 5.25 ms |
| 입력→RAF p95 | 85.3 ms | 11.5 ms |
| 스크롤 write→다음 RAF 중앙값 | 6.6 ms | 6.9 ms |
| detail GET+JSON 중앙값 | 15.8 ms | 15.7 ms |
| detail 응답 크기 | 1,177,095 bytes | 1,185,465 bytes |
| DOM element 수 | 984 | 1,964 |

첫 조건의 초기 표본 지연이 크고 warmup/동시 부하를 통제하지 않았으므로 p95 감소를 개선 효과로 해석하지 않아요. 검색 결과 100개와 0개를 실제 관찰했어요. 입력/스크롤 중 detail GET은 trial당 0~1회, 관측한 long task는 0개였어요. 이는 네트워크가 항상 0회이거나 모든 장치가 부드럽다는 증거가 아니에요.

DOM mutation은 약 1,300→약 8,000으로 증가했어요. 숨겨져 있으나 상태를 보존하는 새 이야기·profile 폼 등의 비용이 목록 크기에 비례하며, 가상화된 대규모 목록 성능을 확보했다고 주장하지 않아요. 별도 최종 browser metric 3표본에서 입력 20회의 ScriptDuration 중앙값 84.8 ms·LayoutDuration 6.18 ms, 30 scroll frame의 ScriptDuration 3.68 ms·LayoutDuration 0 ms를 기록했어요. 이 값은 React render/commit 횟수나 단일 입력 지연이 아니에요.

## 실행과 남은 범위

- 현재 [검증용 실제 앱](http://127.0.0.1:60577/?chat=214902a5-3a23-438a-9f4f-bd658a359205)은 위 output의 합성 DB를 사용해요. 사용자에게 확인용으로 남긴 preview 서버만 실행 중이며, 자동 검증 서버는 모두 정리했어요.
- 사용자 DB로 최신 UI를 실행하려면 기존 앱 터미널에서 서버를 종료하고 `C:/Users/wodus/ai-workspace/uimori`에서 `npm run dev`를 실행한 뒤 [로컬 앱](http://127.0.0.1:4310)을 열어요. 기존 schema v1을 여는 경우의 자동 백업/migration 동작은 이전 M1 계약 그대로이며 이번 작업에서 실행하지 않았어요.
- 실제 휴대폰의 IME·키보드·백그라운드, 스크린리더, live provider·유료 호출·문학/번역 품질, 외부 접속·배포, 새 두 clean worktree 검증은 수행하지 않았어요. viewport와 composition 이벤트는 실물 기기 검증을 대신하지 않아요.
- 기존 M1의 live/device/quality 전제는 [M1-RESULTS](M1-RESULTS.md)에 남아 있어요. UI 로컬 완료가 M1 전체 또는 M2 완료를 뜻하지 않아요.


## 2026-09-07 M1 사용 여정 후속

프로젝트가 정한 봇 선택 → 페르소나 → 저장한 창작 프리셋 → 구체적인 OOC 장면 → 한국어로 읽기 → 이어쓰기·다른 응답 흐름을 실제 앱에서 따라가며 세 곳을 수정했어요. 아래는 이번 로컬 회귀와 직접 화면 검토 결과예요. 앞 절의 과거 build 결과를 최신 구현의 검증으로 소급하지 않아요.

### 이번 증거의 경계

- 변경 전 실제 UI: [manifest](../output/ui-journey/2026-09-06T22-28-43.684Z/manifest.json), [identity](../output/ui-journey/2026-09-06T22-28-43.684Z/identity.json), `before-screens/` 8장. 별도 합성 SQLite와 불변 복사 dist, source/build `91fea8192875d32c471be2f3d261edf3950754a864a4869f179fb0903df43b98`, dist `bdb1bce1147557e84a8c6e7de18f0b572fb40cb473fc5d170c301f5b4355ba70`예요. 봇·페르소나·두 프리셋·10,901 UTF-16 code units 원고와 합성 한국어 번역을 사용했어요.
- 변경 후 로컬 회귀: source/build `2e0fdf784f4fbec83c21f036fba7b290c8ef548d3f5186bd0add1750a291c5be`, dist `8312a18f633a03bd9c6677923ca99ff0a67a018d83b1c68305b669ed62bb3ce6`. [UI summary](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/summary.json)와 [M1-local summary](../output/playwright/2026-09-06T23-00-04-553Z-19c75950/summary.json)가 같은 identity를 기록해요.
- 시각 검토자는 수정 전 세 장과 수정 후 UI 다섯 장·공급자 설정 두 장을 원본 크기로 직접 열었어요. 이미지 경로·SHA-256·관찰·한계는 [시각 검토 기록](../output/ui-journey/2026-09-06T22-28-43.684Z/after-visual-review.json)에 있어요. 파일 목록이나 자동 PASS만으로 시각 판정을 내리지 않았어요.

### 확인한 마찰과 변경

| 실제 관찰 | 적용한 변경 | 직접 비교와 검증 |
| --- | --- | --- |
| 봇·페르소나·프리셋으로 새 이야기를 만들어도 본문/번역 모델은 비어 있어 설정 → 모델 → 두 선택 → 저장 → 닫기 동작이 더 필요했어요. | `NewStory.tsx`에 본문·한국어 번역 모델 선택을 두고, 성공한 선택의 정확한 모델 revision을 다음 새 이야기에도 제안해요. 비활성 연결의 모델은 제안에서 제외해요. | [변경 전](../output/ui-journey/2026-09-06T22-28-43.684Z/before-screens/02-new-story-mobile.png) / [변경 후](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/browser/ui-browser-UI03-UI12-start-7a670-heir-connection-is-disabled/starting-models-mobile.png). 저장만으로 run/attempt가 생기지 않고, 선택 복원·disabled 연결 제외·실패한 profile 복구가 통과했어요. |
| 긴 OOC 요청을 보낸 뒤 초안은 비워졌지만 textarea의 확대된 높이가 남아 모바일 독서 공간을 차지했어요. | 초안·보기·목적지 변경에 맞춰 입력 높이를 다시 측정해요. 빈 입력은 기본 높이로 돌아오며 복원한 긴 초안은 내용에 맞춰 늘어나요. | [변경 전](../output/ui-journey/2026-09-06T22-28-43.684Z/before-screens/05-reading-arrival-mobile.png) / [변경 후](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/browser/ui-browser-UI02-UI04-UI12--8b342--later-long-draft-on-return/collapsed-composer-mobile.png). browser가 전송 전·후 실제 bounding box와 복귀한 긴 초안 높이를 검사했어요. |
| 모바일 다른 전개 창의 select가 가로로 넘쳤고 여러 후보가 모두 “후보 분기”라 구분하기 어려웠어요. | select의 grid 최소 폭을 제한하고, 자동 후보 이름을 “다른 응답 1/2”로 표시하며 해당 원문에 결합된 한국어 번역 미리보기를 넣었어요. 사용자 지정 분기 이름은 유지해요. | [변경 전](../output/ui-journey/2026-09-06T22-28-43.684Z/before-screens/08-two-candidates-mobile.png) / [변경 후](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/browser/ui-browser-UI07-UI09-multi-2e5da-low-or-generation-on-switch/distinct-candidates-mobile.png). 이름·미리보기가 보이고 내부 dialog/select가 390px 안에 들어와요. 분기 전환 전후 runs/sources/attempts 불변도 통과했어요. |

새 이야기의 model 선택은 처음 저장할 profile에 함께 반영해요. pending profile v2는 최초 선택을 보존하지만 다른 탭이 이미 모델을 바꾼 새 revision에는 이전 모델을 덮어쓰지 않아요. 기존 v1/legacy 복구와 동결된 자료 revision도 유지해요. 미지정 모델은 “검사용 모의 생성/번역 · 실제 모델 없음”으로 표시하며 저장된 모델에는 실제 공급자 이름을 붙여요.

### 최신 로컬 검증과 시각 결과

- `npm run verify:ui`: prose unit 7/7, UI browser 14/14 PASS, skip/실패 0, 소유 프로세스 정리·합성 canary 검사 PASS예요. 이번에 추가한 네 browser 사례는 시작 모델 저장·기억, pending 모델 충돌 복구, composer 높이, 후보 선택창이에요. 기존 URL/초안/커서/IME 합성 이벤트/느린 응답/원문 결합 검사를 유지했어요.
- `npm run verify -- --milestone M1-local`: unit 55/55, browser 6/6 PASS예요. 모바일 공급자 설정 저장과 실제 모델 실행 없는 native 옵션 저장도 포함해요. [공급자 옵션](../output/playwright/2026-09-06T23-00-04-553Z-19c75950/browser/product-browser-P04-named--92157-ngs-without-model-execution/provider-settings.png) / [Vertex 옵션](../output/playwright/2026-09-06T23-00-04-553Z-19c75950/browser/product-browser-P04-Vertex-4f07a-n-presets-without-execution/vertex-settings-mobile.png)를 직접 열어 label·선택·등록 상태와 패널 안 배치를 확인했어요.
- 앞선 [UI 검증 시도](../output/playwright/ui-2026-09-06T22-58-43-317Z-57354477/summary.json)는 build와 검증 실행이 겹쳐 `dist/build-identity.json`을 읽는 시점에 ENOENT로 끝났어요. 이는 검사 환경의 실행 순서 실패이며 UI 기능 실패나 PASS로 집계하지 않아요. build가 끝난 뒤 별도 실행한 위 최신 결과를 사용해요.
- [390×844 reader](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/browser/ui-browser-UI01-UI02-UI04--1ca91--and-zero-call-view-changes/reader-390.png)와 [1440×1000 reader](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/browser/ui-browser-UI01-UI02-UI04--1ca91--and-zero-call-view-changes/reader-1440.png)도 직접 열었어요. 검토한 화면 안에서 새 P0/P1/P2 시각 결함을 발견하지 못했어요. 글자·선택 상태·본문/입력/설정의 구분이 유지되고 후보 선택창의 가로 잘림은 사라졌어요.

수정 전후는 서로 다른 합성 데이터와 dark/light theme를 사용하므로 픽셀 차이 또는 성능 개선 수치로 해석하지 않아요. 수정 후 composer 캡처는 번역 준비 중이며 다른 자동 reader 캡처의 번역은 짧은 mock이에요. 이 캡처를 실제 장문 한국어 번역의 독서 통과로 사용하지 않아요. 실제 Vertex Flex 장문 여정의 원문·번역·비용·실패/재시도·의미 품질은 별도의 실제 실행 결과와 함께 판단해요. 실제 휴대폰 키보드·IME·백그라운드와 전 보조 기술 검증은 수행하지 않았어요.

변경 전 검토용 소유 preview PID 9048과 그 Edge 탭은 종료했고 임시 viewport override를 reset했어요. 합성 원본 DB/WAL/SHM·copied dist·캡처는 보존했어요. 사용자 `.local` DB나 사용자 서버를 이 검토에 사용하지 않았어요.


## 2026-09-07 전체 프롬프트 편집 후속

이야기 설정·서재에 공유 프롬프트 편집기를 추가했어요. 역할별 전체 본문, 기본 불러오기, UTF-8 txt/md, 새 저장·revision 수정·선택 적용, 빈 본문과 기본 구분을 지원해요. [최종 UI 검사](../output/playwright/ui-2026-09-07T00-03-29-151Z-739aba94/summary.json)는 Vitest 7·Playwright 16 PASS, 실패/skip 0, cleanup PASS예요. UI17 두 사례가 전체 문자·역할/설정 탭 초안·보관 버전·409 뒤 편집 보존·서재 수정·모델 요청 0을 검사해요. 첫 실행의 1건 실패는 테스트가 영문 오류를 기대한 것이며 실제 한국어 충돌 안내에 맞춰 바로잡았어요. 제품 오류 문구를 시험에 맞춰 변경하지 않았어요.

캡처한 390×844·1440×1000의 스크롤된 편집기 영역에서 본문 줄바꿈과 저장/적용 버튼이 읽히고 가로 겹침이 없는 것을 확인했어요. 이 제한된 시각 검토는 실제 휴대폰이나 UI 전체 인수 증거가 아니에요. [최종 통합 근거와 캡처 경로](../output/prompt-final/2026-09-07/summary.json), [최신 검토용 앱](http://127.0.0.1:59325/?chat=048ece7b-3e4a-4a1c-9de8-40985e79c1d8).


## 2026-09-07 포크 간략화 최종 검증

새 후보/분기 선택 대신 원고의 **여기서 새 이야기로 이어가기**와 상단 **이야기 포크**로 별도 이야기로 이동해요. 원본과 포크의 설정·초안·읽기 기록을 분리하고 유실된 응답은 같은 키로 확인해 중복 생성을 막아요. 지연된 응답은 사용자가 이동한 화면을 가로채지 않아요. 기존 전개는 목록을 한 번 눌러 열며 별도의 장면 dropdown/확인 단계가 없어요.

[최종 summary](../output/fork-final/2026-09-07/summary.json), [UI 7+16](../output/playwright/ui-2026-09-07T00-35-24-644Z-0465468d/summary.json), [M1-local 55+6](../output/playwright/2026-09-07T00-34-39-681Z-85e08186/summary.json) PASS이며 모두 source `7fb2aeae84e3e2d13514ab476b11cd6e8306c89cc6d0bcfeeb1739c2aea251a1`, dist `6a3b011dffa2010068b9048148a7e856fd607cea04a17b4483cf385f450f6c5b`예요. 전체 Vitest 457/457, 실패·required skip 0, 검사 서버 cleanup PASS예요. 이전 M0/UI14 성능/전체 화면 검토는 역사적 결과로 유지하고 이번에 재측정한 것으로 주장하지 않아요.

루트 에이전트가 390px [포크 reader](../output/playwright/2026-09-07T00-34-39-681Z-85e08186/browser/product-browser-P09-P10-P1-fcbf4-ttings-tabs-and-descendants/m1-mobile-fork-reader.png)와 [보관된 전개 목록](../output/playwright/ui-2026-09-07T00-35-24-644Z-0465468d/browser/ui-browser-UI07-UI09-legac-cdfc9--reading-without-generation/legacy-branches-mobile.png)을 직접 보고 제목/도구/입력 영역과 목록의 넘침·잘림 및 추가 선택 단계가 없음을 확인했어요. 합성 viewport 검사이며 실제 폰 검증은 아니에요. [새 확인용 앱](http://127.0.0.1:52890/?chat=048ece7b-3e4a-4a1c-9de8-40985e79c1d8&branch=main%3A048ece7b-3e4a-4a1c-9de8-40985e79c1d8)은 합성 DB 복사본으로 실제 API 호출이 차단돼요.
