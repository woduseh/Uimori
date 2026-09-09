# 후속 항목 · 2026-09-10

메인·도우미 대화 통일(`e417572`), 회귀 timeout 상향(`118cc64`), 화면 일관성 정리(`3ed07c3`)를 마친 뒤 남은 항목이에요. 세 작업 중 어느 것도 원인이 아니며 각각 별도 범위로 다뤄요. 판정 근거와 미확정 부분을 구분해서 적었어요.

`verify:redesign` 전체 실행에서 남은 실패는 여섯 건인데 원인은 다섯 가지예요. `UXUI01`과 `UI03 UI12 new story retry`가 하나의 원인으로 묶여요(아래 2번). 나머지 `CSUI04`·`PRUI01`·`SIDENAV01`의 성격은 [일관성 정리 기록](UIUX-CONSISTENCY-2026-09-10.md)에 정리했어요. 이 실행은 macOS·Edge 152이고 저장소 CI는 Windows·Node 24.14예요. 같은 환경의 A/B 비교는 유효하지만 **남은 실패의 절대 개수는 Windows에서 다시 확인해야 해요.**

## 1. ACTUI08 · 재시도한 작업의 이전 세대 알림이 남아요

여섯 건 중 유일하게 제품 결함으로 보이는 항목이에요. 사용자에게는 하나의 작업이 서로 모순된 두 상태로 동시에 보여요.

**증상.** 작업 알림 대화상자에 같은 `data-activity-id`를 가진 항목이 두 개 생겨요. 실측한 두 행은 `번역하는 중`(세대 2)과 `번역 중단 · 확인 필요`(세대 1)예요. Playwright의 strict mode 위반으로 검사가 실패해요.

**확인한 것.** `tests/activity-browser.spec.ts:480`이 3회 중 2회 실패해요. `e417572` 이전 `HEAD` 격리 트리에서도 같은 증상으로 재현해서 최근 세 작업과 무관한 선행 결함이에요.

**미확정.** 정확한 메커니즘은 특정하지 못했어요. 진입점은 `web/ActivityStatus.tsx`가 `notices` 상태와 `history` 상태를 합쳐 `web/ActivityNotifications.tsx`에 넘기는 `items`예요. `items`는 활동 ID로 합쳐 세대가 하나만 남는데 `notices`는 `acknowledgementKey`(세대 포함)로 유지해서, 이전 세대의 알림이 새 세대와 함께 남는 경로가 있어 보여요. 조정 로직 어느 지점이 이전 세대를 걸러내지 못하는지 확인해야 해요.

## 2. UXUI01 · 전역 프롬프트 작업본이 실행 사이에 오염돼요

**원인은 실측으로 확정했어요.** 전체 실행이 끝난 시점의 전역 프롬프트 작업본에 창작 옵션 control 두 개(`detail`, `coNarration`)가 남아 있어요.

```
output/playwright/redesign-2026-09-09T22-53-24-717Z-d14bdc59/evidence-db/app.sqlite
  prompt_workspace(id=1) → main.program.controls = 2  ·  ids: detail, coNarration
```

`web/main.tsx`의 `hasCreativeOptions`가 이 전역 작업본의 control 개수만 보므로 `창작 옵션` 버튼이 렌더돼요. `tests/ui-usability-browser.spec.ts:38`은 그 버튼이 0개일 것을 기대해서 실패해요.

**전체 실행에서만 나타나요.** `e417572`와 그 부모 `08fab43` 양쪽 격리 트리에서 이 검사만 단독으로 돌리면 통과해요. 56개 spec이 서버와 DB 하나를 공유하고 이 검사가 220건 중 219번째로 도는 게 조건이에요. 개별 spec은 각자 뒷정리를 하므로 하나씩 돌려서는 원인을 찾을 수 없어요.

**남기는 주체도 확정됐어요.** 두 control은 `tests/ui-navigation.ts`의 `createPromptChoice()`가 만드는 프로그램의 것이고, 이 helper를 쓰는 spec은 `product-browser.spec.ts`와 `ui-browser.spec.ts` 둘뿐이에요. 둘 다 그 프롬프트를 전역 작업본에 적용하고 단독 실행에서는 뒷정리가 끝나요. 자세한 추적은 [일관성 정리 기록](UIUX-CONSISTENCY-2026-09-10.md)에 있어요.

**그래서 이 실패는 `UI03 UI12 new story retry`와 한 원인이에요.** 그 검사가 전역 작업본을 되돌리는 `afterEach`에서 timeout으로 끝나요. 복원이 끝나지 않으니 적용한 control이 남고, 이후 모든 화면에 `창작 옵션`이 보여요. 남은 여섯 건 중 둘이 여기서 묶여요.

**수정 방향.** `UI03 UI12`의 `afterEach` timeout을 먼저 고치면 두 건이 함께 풀릴 가능성이 커요. 그것만으로 부족하면 복원 실패가 다음 spec을 오염시키지 않도록 전체 실행에서 spec 사이의 전역 작업본을 격리해요. 두 번째는 검증 하네스 계약 변경이라 별도 판단이 필요해요.

## 3. 도우미 작업의 모델 귀속

**현재 상태.** 도우미 작업 상세에는 모델을 표시하지 않아요. `e417572`의 커밋 전 검토에서 현재 전역 도우미 모델을 표시하던 줄을 제거했어요. 과거 작업의 상세에 지금 선택된 모델이 붙어서, 모델을 바꾼 뒤 이전 실패를 열면 실패 원인을 잘못 귀속할 수 있었어요.

**남은 것.** 그 작업이 실제로 사용한 모델은 여전히 보여줄 수 없어요. `web/useHelperConversation.ts`의 `HelperTaskView`가 `Omit<HelperTask, 'snapshot'>`이라 작업의 snapshot이 화면에 오지 않고, 모델은 그 안에 있어요. 메인은 `web/RunTaskDetails.tsx`가 `run.modelTitle`로 예약 당시 값을 보여주는데 도우미에는 대응물이 없어요.

**수정 방향.** 서버 projection에 작업의 모델 이름만 얹으면 돼요. snapshot 전체를 노출할 필요는 없고, 과거 snapshot을 바꾸지 않는 읽기 전용 추가예요. 그래야 도우미도 메인과 같은 기준으로 "그때 그 모델"을 보여줘요.

## 4. CI의 브라우저 회귀를 별도 job으로 분리

**현재 상태.** `118cc64`에서 `scripts/verify-redesign.mjs`에 30분 한도를 지정하고 `.github/workflows/quality.yml`의 job 한도를 15분에서 45분으로 올렸어요. 전체 회귀가 공용 기본값 600초로는 끝나지 않아서예요. 근거는 [품질 문서](../docs/QUALITY.md)의 CI 절에 있어요.

**남은 문제.** 브라우저 회귀는 수동 실행의 `browser` 옵션에서만 도는데 job 한도는 하나뿐이라, **PR과 push의 공통 경로 상한도 45분으로 함께 느슨해졌어요.** 공통 경로는 보통 몇 분이면 끝나므로 멈춤을 잡는 감시가 그만큼 약해졌어요.

**수정 방향.** 브라우저 회귀를 자체 `timeout-minutes`를 가진 별도 job으로 분리하고 공통 job 한도를 원래대로 되돌려요. CI 구조 변경이라 이번 범위에 넣지 않았어요.

## 조사에 쓸 방법

1과 2를 이어받을 때 쓸 수 있는 방법이에요. 이번에 실제로 원인을 좁힌 방식이에요.

**보존된 실행 DB를 먼저 읽어요.** 하네스가 실행 종료 시점의 SQLite를 `output/playwright/<runId>/evidence-db/app.sqlite`에 남겨요. 2번의 원인은 이 DB의 한 번 조회로 찾았어요. 남은 control의 id가 드러나자 그것을 만드는 helper와 그 helper를 쓰는 spec 두 개까지 좁혀졌어요. 전역 상태가 의심되면 56개 spec을 재생하기 전에 이 DB를 열어요.

**변경의 책임은 부모 커밋과 비교해서 판정해요.** `HEAD`에서도 실패한다는 사실은 그 시점 `HEAD`에 포함된 커밋을 면제하지 않아요. `git archive <ref>`로 부모와 대상 커밋을 각각 스크래치에 풀고 같은 기계에서 연속 실행해요. `CSUI04`가 `08fab43`에서 이미 실패하고 `e417572`에서 통과한다는 판정을 이 방법으로 얻었어요.

**하네스 설정 변경은 양성 대조로 확인해요.** 전체 실행이 설정값 아래에서 끝나면 그 실행은 설정이 반영됐다는 증거가 되지 못해요. `timeout`을 1,000ms로 준 대조가 1,008ms에서 `timedOut: true`로 잘리고 60,000ms는 통과하는 것으로 옵션이 값 그대로 강제됨을 확인했어요. 이 실패의 서명은 `playwright report missing`이고, 저장소에 남은 과거 timeout 실패 기록도 같은 증상이에요.
