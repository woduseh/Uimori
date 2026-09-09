# 화면 사이 일관성 정리

2026-09-10. 앱 전체를 실행해 보고 화면끼리 어긋난 표현을 찾아 하나의 언어로 맞췄어요. 같은 시기에 진행한 [메인·도우미 대화와 재요청 통일](CHAT-UNIFICATION.md)과 범위를 나눴고, 채팅 리더·도우미·진행 표시는 그 문서가 담당해요. 이 작업은 탐색·서재·프롬프트·설정과 공통 제어를 담당해요.

## 확정한 사용자 경험

- **같은 목적의 화면은 같은 조작을 써요.** 서재와 프롬프트는 폴더 이동·검색·목록 관리·선택 작업을 같은 모양으로 제공해요.
- **확정하는 동작은 이름을 가져요.** 설정 저장은 공통 도상에 보이는 이름을 붙여요. 목록으로 돌아가기·삭제·닫기처럼 대상이 분명한 조작은 아이콘으로 남겨요.
- **접기·펼치기는 한 가지 모양이에요.** 브라우저 기본 삼각형 대신 앱이 쓰는 chevron을 회전해요.
- **사이드바는 이름을 먼저 보여줘요.** 봇 행의 보조 조작은 hover·초점·열린 메뉴에서 나타나고, 터치와 좁은 화면에서는 계속 보여요.
- **색은 테마를 따라요.** 정의되지 않은 토큰이나 한쪽 테마에만 맞는 색을 화면에 쓰지 않아요.

## 구현 경계

기능 계약은 바꾸지 않았어요. 저장·삭제·이동·검증 요청, revision 검사, 초안 보호, 접근 이름은 그대로예요. `프로바이더와 모델`처럼 [프로바이더·모델 설정 UI 정리](PROVIDER-UI-CLEANUP.md)에서 정한 용어와 아이콘 전용으로 남기기로 한 조작은 유지했어요.

## 바꾼 것

### 1. 색 토큰의 결함

`--danger`와 `--text-muted`는 어디에도 정의가 없어서 `var()`의 fallback 값이 그대로 화면에 나왔어요. `web/library.css`(2곳)와 `web/bot-navigation.css`는 `#e88b8b`, `web/deletion.css`는 `#b33b43`, `web/editor-drafts.css`는 `#767b88`을 썼어요. 흰 배경에서 `#e88b8b`의 대비는 2.47:1이라, 삭제 아이콘의 hover가 평소 상태(`--muted`)보다 오히려 흐려졌어요. 네 곳 모두 `--error`·`--muted`로 바꿨고 미정의 토큰은 남지 않아요.

`web/deletion.css`가 하드코딩하던 `#a52932`·`#fff`·`#89202a`는 `--error`와 새 `--error-ink`로 바꿔 다크 테마에서도 색이 바뀌어요. `--error-ink`는 `--accent-ink`와 같은 방식이에요.

정의된 토큰 뒤에 붙어 있던 다크 전용 hex fallback 33개도 지웠어요. 라이트 모드에서 토큰이 없으면 어두운 색이 나오는 잘못된 안전망이었어요.

### 2. 아이콘 어휘

`web/ui-icons.ts`에 공통 어휘가 있는데 컴포넌트 대부분이 `lucide-react`를 직접 불러 썼어요. 같은 뜻이 갈라져 있었어요. 편집이 `Pencil`과 `PenLine` 두 개, 닫기 `X`가 여러 파일에서 직접 import, 저장 `Save`와 삭제 `Trash2`는 어휘에 아예 없었어요.

어휘에 `SaveIcon`·`DeleteIcon`·`CheckIcon`·`ExpandIcon`·`DropdownIcon`·`UpIcon`·`DownIcon`·`ForwardIcon`·`UndoIcon`·`ResetIcon`·`DragHandleIcon`·`PinIcon`·`ExternalLinkIcon`·`PowerIcon`·`ImageAddIcon`·`CredentialFileIcon`을 더하고, 29개 컴포넌트의 직접 import를 어휘로 바꿨어요. 채팅 리더·도우미·입력창(`HelperPanel`, `RequestMessage`, `SourceReader`, `ActivityBar`, `ComposerMore`, `main.tsx`)은 병행 작업의 범위라 손대지 않았어요.

### 3. 서재와 프롬프트

| 대상 | 이전 서재 | 이전 프롬프트 | 지금 |
| --- | --- | --- | --- |
| 폴더 이동 | `전체 / 폴더명` breadcrumb과 폴더 카드 | `<select>` 드롭다운 | 양쪽 모두 breadcrumb과 폴더 카드 |
| 검색창 | 돋보기 아이콘 있음 | 없음 | 양쪽 모두 있음 |
| 자료가 없을 때 | 검색·목록 관리 숨김 | 그대로 노출 | 양쪽 모두 숨김 |
| 선택 작업 | `전체 선택 / 이동 / 완료`, 도구막대에서 검색을 대체 | `표시된 자료 전체 선택 / 선택한 자료 이동 / 선택 취소`, 도구막대 아래 별도 줄 | 서재 쪽으로 통일 |
| 목록 항목 도상 | 대표 이미지 | `≡` 글자 | 대표 이미지와 같은 자리에 프롬프트 도상 |
| 목록으로 돌아가기 | `← 서재 목록` 글자 화살표 | `← 프롬프트 목록` 글자 화살표 | 공통 `BackIcon`과 이름 |

`LibraryFolders`의 `presentation`에서 아무도 쓰지 않게 된 `toolbar`(드롭다운)를 지웠고, 함께 죽은 `.library-folder-mobile` 계열 CSS도 정리했어요. breadcrumb의 접근 이름은 두 화면에서 같은 뜻이 되도록 `서재 위치`에서 `현재 폴더`로 바꿨어요.

### 4. 설정 저장 버튼

`현재 프롬프트`는 자동 저장인데 `현재 모델`·`삽화`·`자동 후속 작업`·채팅 설정·모델 편집은 이름 없는 플로피 아이콘 하나를 눌러야 했어요. 공통 `web/SaveButton.tsx`를 만들어 도상은 유지하고 보이는 이름(`저장`, 이미지 등록은 `등록`)을 붙였어요. 접근 이름은 `현재 모델 설정 저장`처럼 대상을 포함한 기존 이름 그대로라 기존 선택자와 음성 입력이 계속 맞아요. 보이는 글자가 접근 이름 안에 있으므로 WCAG 2.5.3도 지켜요.

`다시 불러오기`처럼 확정이 아닌 보조 조작과 `모델 편집 끝내기`·삭제는 아이콘으로 남겼어요.

### 5. 사이드바 봇 행

250px 사이드바에 토글·검색·메뉴·새 채팅 네 조작이 항상 들어가 봇 이름이 `궤도 정거장 관...`으로 잘렸어요. 채팅 검색을 봇 관리 메뉴 항목으로 옮기고, 남은 `새 채팅`과 관리 메뉴는 hover·초점·열린 메뉴에서 나타나게 했어요. 터치와 좁은 화면에서는 기존 채팅 행 규칙과 같은 media query로 계속 보여요.

### 6. 접기·펼치기와 파일 선택

브라우저 기본 삼각형을 쓰던 `<details>` 약 50곳이 공통 chevron을 쓰도록 `web/style.css`에 규칙 하나를 넣었어요. 자기 도상을 그리는 `ActionMenu`·`LibraryItemMenu`·`TurnActivity`·프롬프트 구성 블록은 같은 자리에서 명시적으로 제외했어요.

파일 선택 입력은 브라우저 기본 위젯 그대로였고, 두 화면만 서로 다른 방식으로 덮어쓰고 있었어요. 공통 규칙 하나로 모으고 화면별 중복을 지웠어요.

`web/style.css`에서 `.model-chip` 규칙이 연속된 두 블록으로 갈라져 있던 것도 하나로 합쳤어요. 두 블록에 겹치는 속성이 없어 결과가 같고, 병합 전후의 computed style 15개 속성이 동일한 것과 `verify:chat-unification` 14 PASS·`verify:turn-activity` 4 PASS·`verify:deletion` 19 PASS로 확인했어요. 이 선택자는 [메인·도우미 통일](CHAT-UNIFICATION.md)의 헤더·입력창 마크업이 쓰는 것이라 해당 작업 쪽 요청으로 정리했어요.

### 7. 프로바이더 용어 통일

사용자가 `프로바이더`로 확정해서 문서를 화면에 맞췄어요. 화면은 이미 `프로바이더와 모델`·`프로바이더 관리`·`빠른 프로바이더 진행`으로 통일돼 있었고, `연결과 모델`로 안내하던 문서 쪽만 남아 있었어요. 코드에는 바꿀 것이 없었어요.

문서 **168곳**을 바꿨어요. 화면의 어휘를 그대로 따라서, 등록 항목은 `프로바이더`, 공급 업체는 `제공자`·`공급자`로 구분해요. 문서 제목도 `공급자 연결과 합성 시험`에서 `프로바이더와 합성 시험`으로, `모델 생성 설정과 연결 테스트`에서 `모델 생성 설정과 응답 테스트`(화면의 버튼 이름)로 바꿨어요.

**남긴 `연결`은 프로바이더를 뜻하지 않는 것들이에요.** 모듈·자료·원문·번역의 대상 연결, 네트워크와 SSH·Tailscale·ComfyUI 접속, Codex의 로그인(`Codex 에이전트 연결`, `연결 해제`는 화면 문구 그대로), 패키지 편집기의 탭 이름 `연결과 기능`, 비교 연산자의 연결이에요. 전수로 확인했고 143곳 중 프로바이더 의미는 남지 않았어요.

바꾸다가 되돌린 곳도 있어요. `원문 연결 정보`는 `web/SourceReader.tsx`의 화면 문구라 3곳을 원래대로 두었고, `API 연결 테스트 중이니 OK만 답해주세요.`는 `server/provider-connection-test.ts`가 공급자에게 실제로 보내는 문장이라 그대로 뒀어요.

날짜가 붙은 과거 결과 기록(`project-plan/PROVIDER-*-RESULTS.md` 등)은 당시 증거라 바꾸지 않았어요.

## 검증

### 환경과 그 한계를 먼저 밝혀요

로컬 **macOS**, Node 24.20.0, **Edge 152.0.4191.66 headless**로 실행했어요. 실제 공급자 호출·실기기 확인은 하지 않았어요.

이 저장소가 상정하는 검증 환경은 macOS가 아니에요. `docs/QUALITY.md`의 CI는 **Windows / Node 24.14.0**이고, `scripts/lib.mjs`의 `browserPath()`와 `playwright.config.ts`는 Windows Chrome·Edge 경로만 자동 탐색해요. 저는 `NR_BROWSER_PATH`로 macOS Edge를 지정해 우회했어요.

그래서 아래 결과를 이렇게 나눠 읽어야 해요.

- **믿을 수 있는 것은 같은 환경에서의 A/B 비교예요.** 이 트리와 `HEAD`를 같은 기계·같은 브라우저·같은 Node로 연속 실행해 비교했으므로, "이번 변경이 무엇을 고치고 무엇을 깼는가"는 유효해요.
- **믿을 수 없는 것은 실패의 절대 개수예요.** 남은 실패 중 일부는 macOS·Edge에서만 나타나는 것일 수 있어요. 실제로 `SIDENAV01`의 원인으로 확인한 "닫힌 `<details>` 안 절대 위치 요소의 레이아웃 상자"는 렌더링 엔진 버전에 따라 달라지는 성질이에요.
- **Windows 기준 판정은 이 기록으로 대신할 수 없어요.** 이 기계에는 Chrome이 없어 다른 Chromium 빌드로 교차 확인도 하지 못했어요. 최종 판정은 Windows CI에서 다시 확인해야 해요.


- `npm run quality`(Biome + tsc): PASS.
- `npm run build`: PASS.
- 단위·통합 `vitest`: Node 24에서 **1,716 PASS / 1 SKIP**. SKIP은 기본 비활성인 Codex preflight예요. 로컬 Node 26에서는 `tests/harness.test.ts`와 `tests/server.test.ts` F03이 실패하는데, 두 실패는 이번 변경 전에도 같았고 Node 24에서 통과해요.

브라우저 묶음이에요. 증거는 `output/playwright/<runId>/summary.json`이고 cleanup은 모두 PASS예요.

| 묶음 | 결과 | runId |
| --- | --- | --- |
| `verify:library` | 26 PASS | `library-2026-09-09T21-46-47-424Z-247d8445` |
| `verify:providers` | 15 PASS | `provider-management-2026-09-09T21-48-32-449Z-16e4db5c` |
| `verify:illustration` | 3 PASS | `illustration-ui-2026-09-09T21-51-43-217Z-62090693` |
| `verify:deletion` | 19 PASS | `deletion-2026-09-09T21-51-52-680Z-d6cc14ba` |
| `verify:request-edit` | 6 PASS | `request-edit-2026-09-09T21-52-22-190Z-c63affcc` |
| `verify:navigation` | 23 PASS / 1 FAIL | `navigation-2026-09-09T21-47-24-001Z-431b1a44` |
| `verify:ui` | 23 PASS / 1 FAIL | `ui-2026-09-09T21-49-18-412Z-af015f5a` |
| `verify:prompts` | 14 PASS / 1 FAIL | `prompt-editor-2026-09-09T21-47-53-185Z-21013642` |
| `verify:settings-polish` | 14 PASS / 1 FAIL | `settings-polish-2026-09-09T21-50-56-096Z-a658b343` |

`verify:ui`는 이번 변경 전 4건이 실패했고 지금은 1건이에요. 채팅 목록 접근 이름을 맞추면서 나머지 3건이 되살아났어요.

### 전체 회귀로 판정했어요

부분 묶음의 실패는 실행 순서에 민감해서 그것만으로 판정하지 않았어요. `verify:redesign` 전체를 이 트리와 `HEAD`(`e417572`) 격리 트리에서 각각 한 번씩 돌려 비교했어요. `HEAD` 쪽은 harness 기본 600초에 걸려서 timeout만 1,800초로 올린 같은 옵션의 변형으로 완주시켰어요.

| 트리 | 결과 | runId |
| --- | --- | --- |
| 이 트리 | **214 PASS / 6 FAIL** (9.2분) | `redesign-2026-09-09T22-07-33-854Z-5c6ded4b` |
| `HEAD` 격리 | **210 PASS / 10 FAIL** (11.8분) | `redesign-long-2026-09-09T22-28-38-589Z-2ffecb28` |

**이 트리의 실패 6건은 `HEAD` 실패 10건의 부분집합이에요. 새로 깨진 검사는 없고 4건이 되살아났어요.**

병행 작업이 같은 작업트리에서 한 번 더 돌렸고 **214 PASS / 6 FAIL, 565.5초**로 같은 6건을 재현했어요(`redesign-2026-09-09T22-53-24-717Z-d14bdc59`). 다른 세션이 독립적으로 실행한 결과라 이 트리의 상태를 한 번 더 확인해 줘요. **이 실행은 harness timeout 상향의 증거가 아니에요.** 565초는 상향 전 600초 아래라 어느 설정에서도 똑같이 완주해요. 이 실행이 보이는 것은 6건의 독립 재현과, 병행 작업이 바꾼 세 파일이 앱 동작에 영향을 주지 않는다는 것 둘이에요.

| 검사 | HEAD | 이 트리 |
| --- | --- | --- |
| `ACTUI08` | FAIL | FAIL |
| `CSUI04` | FAIL | FAIL |
| `PRUI01` | FAIL | FAIL |
| `SIDENAV01` | FAIL | FAIL |
| `UI03 UI12 new story retry…` | FAIL | FAIL |
| `UXUI01` | FAIL | FAIL |
| `UI07 UI12 late accepted fork…` | FAIL | **PASS** |
| `UI12 late failed SSE refresh…` | FAIL | **PASS** |
| `UI18 translation is requested only by first view click…` | FAIL | **PASS** |
| `UI common dialogs center on desktop…` | FAIL | **PASS** |

`SCUI02`는 **양쪽 전체 실행에서 모두 통과**했어요. 부분 묶음 `verify:settings-polish`와 단독 실행에서만 실패해요. 390→1440 리사이즈 직후 `ProviderManagement`의 navigate rAF가 초점을 옮기는 테스트 쪽 경합이라, 부분 실행 결과로 기능 결함으로 분류하면 안 돼요.

`SIDENAV01`은 제 변경과 무관한 것을 따로 확인했어요. 실행 중인 화면에서 이번에 추가한 `summary`·`summary::before` 규칙 세 개를 CSSOM에서 제거하고 다시 측정해도 결과가 같았어요(`display: grid`, 높이 106px 그대로). 닫힌 `<details>` 안의 `position: absolute` 메뉴 본문이 레이아웃 상자를 유지해서 Playwright의 `toBeHidden()`이 숨김으로 보지 않는 것이고, 실제로는 그려지지 않아요. 메뉴 좌표에서 `elementFromPoint`를 하면 메뉴가 아니라 탐색 컨테이너가 잡혀요.

`UXUI01`과 `CSUI04`는 처음에 `web/main.tsx`의 컨트롤이라는 이유로 `e417572` 쪽 문제로 적었는데, 그 논증은 틀렸어요. "`HEAD`에서도 실패한다"는 이번 변경만 면제하고, `HEAD`가 곧 `e417572`이므로 그 커밋을 면제하지 않아요. 병행 작업 쪽에서 부모 `08fab43`과 직접 비교해 확인했어요.

| 검사 | `08fab43` 단독 | `e417572` 단독 |
| --- | --- | --- |
| `UXUI01` | PASS | PASS |
| `CSUI04` | TIMEDOUT | PASS |

`CSUI04`는 그 커밋 이전부터 단독 실행에서 깨져 있었고 오히려 그 커밋에서 통과해요. `UXUI01`은 양쪽 모두 단독으로 통과하니 **전체 실행에서만 나타나는 실행 간 상호작용**이에요.

`UXUI01`의 원인은 확정했어요. `창작 옵션` 버튼의 조건인 `hasCreativeOptions`(`web/main.tsx:263`)가 채팅별 상태가 아니라 **전역 프롬프트 작업본**의 `main.program.controls`를 읽어요. `verify:redesign`은 56개 spec이 서버와 DB 하나를 공유하고, `UXUI01`은 220개 케이스 중 219번째로 가장 마지막에 실행돼요.

harness가 보존한 evidence DB로 종료 시점 상태를 직접 읽었어요. `redesign-2026-09-09T22-53-24-717Z-d14bdc59/evidence-db/app.sqlite`의 `prompt_workspace(id=1)`에 **control 두 개가 남아 있어요** — `detail`(합성 상세도)과 `coNarration`(합성 공동 서술)이에요. 그래서 버튼이 렌더되고, `tests/ui-usability-browser.spec.ts:38`의 "0개" 기대가 깨져요.

이 둘은 `tests/ui-navigation.ts:178`의 `createPromptChoice()`가 만드는 프로그램의 control과 정확히 같아요. 이 helper를 쓰는 spec은 `product-browser.spec.ts`와 `ui-browser.spec.ts` 둘뿐이고, 둘 다 그 프롬프트를 전역 작업본에 적용해요. 두 spec을 단독으로 돌리면 뒤처리가 되어 controls가 0으로 정리돼요.

**그래서 이 실패는 같은 실행의 다른 실패와 이어져 있어요.** `ui-browser.spec.ts`의 `UI03 UI12 new story retry`가 전역 작업본을 되돌리는 `afterEach`에서 timeout으로 끝나요(`tests/ui-browser.spec.ts:72`). 복원이 끝나지 않으면 적용된 control이 남고, 이후 모든 화면에 `창작 옵션`이 보여요. 남은 6건 중 둘이 하나의 원인으로 묶이는 셈이에요. 확정 수정은 이번 범위 밖이라 후속으로 남겨요.

전체 순서를 재생하지 않아도 evidence DB가 종료 시점 전역 상태를 보존한다는 점은 앞으로도 쓸 만한 방법이에요.

### 갱신한 검사

- `tests/settings-action-icons-browser.spec.ts`(SICON01): 확정 동작에 이름이 보이는지 검사하는 `named()`를 더했어요. 아이콘 전용을 요구하는 `icon()`은 `다시 불러오기`에 그대로 남아요.
- `tests/provider-management-browser.spec.ts`(PMUI03): 모델 저장만 이름 있는 버튼으로 검사하고, 편집 끝내기·삭제는 44×44 아이콘 검사를 유지해요.
- `tests/library-browser.spec.ts`: `chooseFolder`가 두 화면에서 같은 breadcrumb 경로를 써요. LIBUI03은 폴더로 들어가기 전에 검색어를 지워요. 검색은 폴더 전체를 훑는 동작이라 폴더 카드가 숨는 기존 서재 규칙과 같아요.
- `tests/organization-browser.spec.ts`: 봇 채팅 검색을 관리 메뉴에서 열어요.
- `tests/ui-browser.spec.ts`: 채팅 목록 navigation의 접근 이름을 `/의 채팅 목록$/`로 맞췄어요. 실제 이름은 `등불의 강의 채팅 목록`처럼 봇 이름을 포함해서, 여러 봇을 펼쳐도 보조 기술이 목록을 구별할 수 있어요. 이전 리터럴 `봇의 채팅 목록`은 어떤 화면과도 맞지 않아 UI03·UI07·UI12·UI18이 멈춰 있었어요.
- 뒤로가기 버튼의 접근 이름에서 `←` 글자가 빠지면서 9개 spec의 선택자를 함께 고쳤어요.

### 확인한 성능 회귀 하나

처음에는 공통 chevron에 `transition: transform 120ms ease`를 넣었어요. 이 상태에서 `PFUI01`이 3회 중 1회 실패했어요. 1440px로 창을 넓힌 직후 `패키지 분야 목록` 뒤로가기 버튼을 누르려다 요소가 DOM에서 떨어져 60초를 넘겼어요. 같은 검사를 `HEAD` 트리에서 3회 돌리면 모두 통과해요.

원인을 좁히려고 chevron 규칙만 뺀 빌드와 transition만 뺀 빌드를 각각 3회 돌렸고, 둘 다 통과했어요. 문서 전체의 `<details>`마다 transition을 거는 비용이 창 크기 변경 뒤 첫 commit을 늦춰 기존 경합을 드러낸 것으로 보여요. transition을 빼고 회전만 남겼어요. 사이드바의 기존 chevron도 transition이 없어서 동작이 같아져요.

## 남은 것

- `tests/ui-navigation.ts`의 `selectPackageSection`에는 경합이 남아 있어요. 창 폭을 바꾼 직후 `compact` 상태가 반영되기 전에 뒤로가기 버튼의 표시 여부를 읽어요. 이번에는 원인을 없애 통과하지만, `.package-editor-layout[data-compact]`가 기대한 값이 될 때까지 기다리게 하면 근본적으로 사라져요. 여러 suite가 공유하는 helper라 이번 범위에서 고치지 않았어요.
- `설정 → 현재 모델`에서 `번역`만 테두리로 감싼 묶음이고 나머지 역할은 맨 label이에요. 하위 설정이 있는 역할이라 묶음 자체는 뜻이 있지만, 다른 역할과의 시각 차이는 다시 볼 여지가 있어요.
- border-radius 26종, font-size 19종에 px와 rem이 섞여 있어요. 이번에는 결함만 고치고 스케일 토큰화는 하지 않았어요.
- **Windows에서 같은 전체 회귀를 한 번 돌려야 해요.** 이 기록의 실패 6건이 그대로 남는지, 아니면 macOS·Edge에서만 나타난 것인지가 거기서 갈려요. A/B 비교 자체는 같은 환경에서 했으므로 이번 변경의 영향 판정에는 영향이 없어요.
- `verify:redesign`의 harness timeout 600초가 부족하다는 건 이 측정(이 트리 9.2분, `HEAD` 11.8분)으로 확인됐고, 병행 작업이 `scripts/verify-redesign.mjs`의 `timeout`을 1,800초로, CI 작업의 `timeout-minutes`를 45분으로 올린 뒤 근거를 `docs/QUALITY.md`에 남겼어요. 그 세 파일은 이번 작업의 변경이 아니에요. 증거는 둘로 나눠 읽어야 해요. **상향이 필요하다**는 근거는 `HEAD` 트리의 11.8분(708초) 실행이 600초에서 report 없이 종료된 것이고, **상향이 실효다**는 근거는 병행 작업이 `timeout`만 바꿔 돌린 양성 대조예요. 1,000ms 지정은 1,008ms에서 `timedOut: true`로 잘렸고 60,000ms 지정은 통과했어요. 옵션이 `runBrowserVerification`에서 `command()`로 값 그대로 전달돼 강제된다는 뜻이에요. 1,000ms 대조의 실패 문구가 `playwright report missing`으로 `HEAD` 실행의 증상과 같아서, 저장소에 남은 과거 timeout FAIL들도 같은 원인이라는 진단을 뒷받침해요. 남은 한계는 **상향된 값으로 600초를 넘겨 완주하는 장면은 아직 아무도 직접 보지 못했다**는 거예요. 위 둘을 합친 추론이에요.
