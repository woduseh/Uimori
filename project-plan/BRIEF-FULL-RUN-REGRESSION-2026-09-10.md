# 작업 브리프 · 전체 브라우저 회귀가 두 배로 느려졌어요

2026-09-10. 후속 정리 작업이 `verify:redesign` 전체 실행의 벽시계 시간을 **10.8분에서 19.8분으로** 늘렸어요. 원인을 특정하지 못한 채 넘겨요. 여기까지 측정한 것과, 측정하지 못한 것을 구분해서 적었어요.

## 한 줄 요약

의도한 네 건은 실제로 고쳐졌는데, 전체 실행에서만 여섯 건이 새로 깨지고 총 531초가 늘었어요. 새 실패는 모두 단독 실행에서 통과해요. **개별 검사의 결함이 아니라 전체 실행의 상호작용 문제예요.**

## 측정값

같은 기계(macOS 25.6, Edge 152), 같은 날, 동시 실행 없이 연속으로 잰 A/B예요.

| | 기준선 `15f6bd5` | 후속 트리 |
| --- | --- | --- |
| 벽시계 | 10.8분 | 19.8분 |
| 검사별 소요 합 | 630초 | 1,161초 |
| 결과 | 213 PASS / 7 FAIL | 211 PASS / 9 FAIL |

없어진 실패 네 건은 `CSUI04`, `SIDENAV01`, `UI03 UI12 new story retry`, `UXUI01`이에요.

새로 생긴 실패 여섯 건은 `GMUI01`, `HELPUI02`, `LIBUI04`, `OUTUI01`, `BUI03`, `PAUI05`예요. 양쪽에 공통으로 남은 실패는 `ACTUI08`(이후 수정됨), `PRUI01`, `UI common dialogs`예요.

증거는 두 곳에 있어요.

- 후속 트리: `output/playwright/redesign-2026-09-10T00-16-49-965Z-f1414b80/`
- 기준선: `output/playwright/baseline-15f6bd5-2026-09-10T00-40-40Z/` — 스크래치 트리에서 실행해서 `summary.json`과 `playwright.json`만 옮겨 뒀어요. 같은 폴더의 `compare-durations.mjs`가 두 `playwright.json`을 받아 검사별 증감을 정렬해 출력해요.

`output/`은 `.gitignore` 대상이라 **두 증거 모두 이 기계에만 있어요.** 다른 기계에서 이어받으면 기준선을 다시 재야 해요. `git archive 15f6bd5 | tar -x -C <스크래치>` 뒤 `node_modules`를 심볼릭 링크하고 `node scripts/build.mjs`로 빌드한 다음 같은 harness를 돌리면 돼요.

```bash
node output/playwright/baseline-15f6bd5-2026-09-10T00-40-40Z/compare-durations.mjs output/playwright/baseline-15f6bd5-2026-09-10T00-40-40Z/playwright.json output/playwright/<새 실행>/playwright.json
```

## 증가가 어떤 모양인지

증가분은 연속적이지 않고 **약 +10초와 +30초 단위**로 쌓여요. `expect`의 10초 한도와 검사의 30초 한도와 같은 값이에요. 점진적 성능 저하가 아니라 어떤 대기가 한도까지 갔다가 풀리는 모양이에요.

가장 큰 것부터예요.

| 증가 | 기준선 → 후속 | 검사 |
| --- | --- | --- |
| +207.9초 | 2.6 → 210.5 | `BUI03` (package-behavior) |
| +76.1초 | 1.7 → 77.7 | `LIBUI04` (library) |
| +65.3초 | 6.8 → 72.1 | `HELPUI02` (helper) |
| +40.9초 | 2.1 → 43.0 | `HELPUI05` (helper) |
| +31.1초 | 2.4 → 33.4 | `OUTUI01` (outline) |
| +28.4초 | 2.4 → 30.8 | `GMUI01` (global-models) |
| +28.1초 | 2.3 → 30.4 | `PAUI05` (prompt-actions) |

실행 순서로 보면 220건 중 **22번째부터 131번째 사이에만** 흩어져 있고 그 뒤로는 한 건도 없어요. 시작점이 하나가 아니라서 "어느 검사가 전역 상태를 오염시켰다"는 단순한 그림에는 맞지 않아요.

## 확정한 것

- **환경이 아니에요.** 기준선을 같은 조건에서 다시 재서 10.8분을 얻었어요. 처음 세운 "핫스팟·기계 상태" 가설은 이 측정으로 기각됐어요.
- **동시 실행이 아니에요.** 후속 실행 창(00:16Z–00:36Z)에 겹치는 다른 harness 실행 산출물이 없어요.
- **단독 실행에서는 재현되지 않아요.** 예를 들어 `LOADUI01`은 전체 실행에서 1.3초 → 11.4초인데 `verify:loading` 단독으로는 1.3초예요. 새 실패 여섯 건도 모두 단독으로 통과해요.

## 확정하지 못한 것

무엇이 원인인지예요. 후보는 이번 후속 정리에서 바꾼 검사 helper 두 개예요. 둘 다 여러 spec이 공유해요.

**후보 A — `tests/fixtures/prompt-workspace.ts`의 `afterEach`.** drain을 5초로 제한하고, 복원 훅에 `testInfo.timeout + 30_000` 예산을 주고, 프롬프트 복원과 모델 복원을 분리했어요. 17개 spec 파일이 이 fixture를 써요.

**후보 B — `tests/ui-navigation.ts`의 `selectPackageSection`.** 창 폭을 바꾼 직후의 경합을 없애려고 `.package-editor-layout[data-compact]`가 기대값이 될 때까지 기다리는 단정을 추가했어요. 8개 spec 파일이 이 helper를 써요.

**두 후보 모두 절반만 설명해요.** 느려진 18건 중 11건은 A 또는 B의 사용처인데 나머지 7건(`LIBUI04`, `HELPUI02`, `HELPUI05`, `OUTUI01`, `LOADUI01`, `CSUI02`, `LIBUI01`)은 둘 다 쓰지 않아요. 가장 큰 `BUI03`(+207.9초)은 B의 사용처이고, 두 번째로 큰 `LIBUI04`(+76.1초)는 아니에요.

`LIBUI04`의 실패 문맥에는 `Test timeout of 30000ms exceeded` 뒤에 `apiRequestContext.get: Target page, context or browser has been closed`가 남아 있어요. 뒤엣것은 본문이 이미 timeout된 뒤 `afterEach`가 닫힌 컨텍스트로 요청한 결과라서, 원인이 아니라 결과예요.

## 다음 사람이 할 일

1. **후보를 하나씩 되돌려 전체 실행을 재요.** 개별 실행으로는 아무것도 재현되지 않으니 판정은 전체 실행에서만 나와요. 한 번이 10~20분이에요. `tests/ui-navigation.ts`만 되돌린 실행과 `tests/fixtures/prompt-workspace.ts`만 되돌린 실행, 두 번이면 A·B의 기여를 가릅니다. 되돌릴 커밋은 아래 "관련 커밋"에 있어요.
2. **둘 다 아니면 제품 쪽을 봐요.** `web/main.tsx`의 `libraryListRequest`와 그것을 받는 `web/LibraryPanel.tsx`·`web/PromptLibrary.tsx`의 effect가 화면 진입마다 목록으로 되돌리는 경로를 새로 태워요. `LIBUI04`·`LIBUI01`이 서재 검사라는 점과 맞물려요.
3. **판정은 같은 기계의 A/B로만 해요.** 저장소 CI는 Windows·Node 24.14이고 이 측정은 macOS·Edge예요. 절대 실패 개수는 옮겨 쓸 수 없어요.

## 받아들이는 기준

전체 실행이 기준선의 **10~11분대**로 돌아오고, 새로 생긴 여섯 건이 사라지고, 이번에 고친 네 건(`CSUI04`, `SIDENAV01`, `UI03 UI12`, `UXUI01`)이 계속 통과하는 상태예요. 두 조건을 동시에 만족해야 해요. 되돌리기만 하면 네 건이 함께 돌아와요.

## 관련 커밋

- 제품·환경 수정: `web/`, `scripts/lib.mjs`, `playwright.config.ts`, `.nvmrc`, `docs/DEVELOPMENT.md`
- **검사 helper 수정(후보 A·B, 되돌리기 대상):** `tests/fixtures/prompt-workspace.ts`, `tests/ui-navigation.ts` — 되돌리기 쉽도록 별도 커밋으로 나눠 뒀어요.

배경은 [화면 사이 일관성 정리](UIUX-CONSISTENCY-2026-09-10.md)의 후속 절과 [후속 항목](FOLLOW-UPS-2026-09-10.md)에 있어요. 조사 방법은 [개발 문서](../docs/DEVELOPMENT.md)의 실행 환경 절에 정리했어요.
