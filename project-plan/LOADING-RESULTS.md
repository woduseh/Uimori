# 긴 대화·서재 로딩 개선 결과

아래는 별도 작업트리의 당시 측정·검증 기록이에요. 2026-09-07 문서 점검 시 검증 표의 `output/` 링크 6개 대상은 현재 checkout에 없어 원본 증거를 재확인하지 못했어요. 수치와 링크는 이력으로 보존해요. 이후 최초 조회와 SSE 직렬화 경합 수정은 [NATIVE-RESULTS](NATIVE-RESULTS.md), 현재 통합 상태는 [CURRENT](CURRENT.md)를 확인해요.

2026-09-07. 기준 `51e5196`, 작업 경로 `C:/Users/wodus/.codex/worktrees/deca/uimori`예요. 사용자 DB·원본 자료·공용 루트는 수정하지 않았고 유료 provider 호출·외부 전송·push·배포는 없어요.

## 결과

대표 합성 자료의 초기 전송은 **225.40MB → 2.03MB**, 설정 SSE 갱신은 **222.45MB → 46.57KB**, 초기 DOM은 **17,743 → 614개**로 줄었어요. 과거 실행 snapshot의 반복 전송을 제거한 효과가 가장 커요. 데이터 보존이나 생성 입력을 줄여서 얻은 결과가 아니에요.

| 관측 항목 | 개선 전 | 개선 후 |
| --- | ---: | ---: |
| 초기 브라우저 API 요청 수 | 108 | 11 |
| 초기 완료 응답 전송 bytes | 225,400,506 | 2,034,737 |
| 초기 DOM element 수 | 17,743 | 614 |
| 초기 원고 article / anchor block 수 | 100 / 4,580 | 5 / 126 |
| 초기 JS heap 관측 bytes | 355,183,820 | 9,886,780 |
| 초기 관측 경과 ms, 1,500ms 대기 포함 | 4,941.5 | 2,402.5 |
| 설정 변경 SSE의 브라우저 API 요청 수 | 2 | 1 |
| 설정 변경 SSE 완료 응답 bytes | 222,447,621 | 46,568 |
| 새로고침 API 요청 수 | 108 | 11 |
| 새로고침 완료 응답 bytes | 447,472,892 | 1,654,340 |
| 새로고침 JS heap 관측 bytes | 1,288,100,352 | 21,145,692 |
| 새로고침 관측 경과 ms, 1,500ms 대기 포함 | 7,108.0 | 2,367.1 |
| 31단계 스크롤 경과 ms | 211.0 | 208.2 |

MB/KB는 십진 단위예요. bytes는 CDP `encodedDataLength` 합계로 헤더를 포함하고, 열린 SSE 자체는 완료 bytes에서 빠져요. API 요청 수에는 열린 SSE 요청도 포함해요. 설정 변경을 일으킨 Node의 PATCH는 브라우저 요청 수에 포함하지 않아요. 원시 Resource Timing의 decoded body bytes도 JSON에 따로 남겼어요.

초기 시간은 `goto(domcontentloaded)`부터 첫 source element를 기다린 뒤 고정 1.5초 대기와 관측까지의 시간이에요. 순수 FCP/응답 지연으로 해석하지 않아요. SSE 시간에는 총 3초의 고정 대기가 있어 지연 개선 주장에 사용하지 않아요. 스크롤은 프레임 대기에 지배되며 전후 이동 범위도 전체 100개/현재 5개로 달라요. 스크롤 속도가 빨라졌다는 주장은 하지 않아요. heap은 순간 관측값이며 peak나 강제 GC 이후 retained heap이 아니에요.

## 합성 자료와 재현

`scripts/measure-loading.mjs`는 새 SQLite·port·Chromium context를 만들고 종료 시 소유 서버와 브라우저를 종료해요. 측정 DB는 해당 output 안에 남겨요.

- 보관 봇 100개, 서로 다른 봇을 연결한 채팅 10개, 채팅마다 source 100개예요.
- 각 source는 8,000–80,000 UTF-16 code unit, 선택 채팅 합계 4,400,000자, 전체 44,000,000자예요. ASCII 합성 본문이므로 본문 UTF-8 bytes도 각각 같은 수치예요.
- **실제 tokenizer는 실행하지 않았어요.** 2천–2만 토큰을 대표하려는 문자 크기 범위이며 실제 2천–2만 토큰을 검증한 자료는 아니에요. 한국어·코드·모델별 tokenizer에 따라 달라져요.
- 로어는 항목당 저장 제한을 지켜 100,000자 × 4개, 총 400,000자예요. 10만 토큰을 실제로 측정한 것은 아니에요. 별도 서재 검사에는 로어 920,000자를 포함해요.
- 선택 채팅은 모든 Run에 당시까지의 전체 ancestry를 넣었어요. 나머지 9개 채팅은 source 100개씩을 보관하되 snapshot history는 비워 fixture 크기를 제한했어요. 전체 snapshot JSON은 212,124,741 bytes, DB는 261,472,256 bytes였어요.
- PNG 에셋 1,000개는 작은 합성 이미지예요. 메타데이터와 숨은 DOM 비용을 재현하며 대형 이미지 디코딩·GPU 메모리 측정이 아니에요.
- 큰 자료 측정에는 번역 job·attempt·tool 기록과 snapshot의 profile/resource 복제가 없어요. 해당 비용까지 포함한 보관량의 상한으로 주장하지 않아요.

```powershell
npm ci --offline --no-audit --no-fund
npm run check
npm run build
node scripts/measure-loading.mjs --label reproduced
node scripts/verify-loading.mjs
node scripts/verify-ui.mjs
npx vitest run --reporter=json --outputFile=output/loading-unit-report.json
```

Windows Node 24.14.0 / PC 로컬 Chrome, 1440×1000 측정이에요. 브라우저 회귀검사는 390px viewport도 사용해요. 실제 모바일 기기·원격 서비스·개인 작품·live 모델 검증이 아니며 각 성능 단계는 단일 관측이에요. 개선 전 결과는 기준 코드에서 같은 하네스로 측정했어요.

## 구현과 보존한 계약

- `server/reader.ts`: 기존 전체 detail을 유지하고 `/api/chats/:id/reader`를 추가했어요. branch ancestry의 고정 5개 구간을 반환하고 source URL·읽던 원고도 해당 구간으로 정규화해요. `since`와 `known`으로 이미 가진 원고를 생략하며, source/job event로 변한 원고와 해당 job만 교체해요. 자산은 최초 및 자산 변경 시 반환해요. 구간 밖 활성 job도 별도 집계해 작업 배지가 누락되지 않아요.
- Run은 SQLite JSON projection으로 읽기 메타데이터만 반환해요. `ReaderRun`은 완전한 `Run`과 다른 타입이며 생략된 snapshot/입력/도구를 빈 진단으로 표시하지 않아요. 전체 실행은 기존 `/runs/:id`, 진단 목록·단일 Job/Attempt는 `reader-routes.ts`로 필요할 때 읽어요. 번역 chunk는 읽기 화면에서 상태·재시도 식별자만 보내고 입력·결과 진단은 상세에서 읽어요.
- `useStory.ts`: 한 구간만 보관하고 SSE burst를 묶어요. 초기 로딩이 진행 중이면 불필요한 중복 GET을 기다렸다가 event cursor를 확인해요. 늦은 다른 채팅·구간의 응답은 적용하지 않아요. offline에서는 SSE를 닫고 online/재접속에서는 현재 구간을 완전히 재확인해요. 번역 보기를 누르지 않은 재접속은 모델 호출을 만들지 않아요.
- source·anchor·offset과 URL target을 함께 저장해 직접 링크와 같은 URL 새로고침을 구분해요. 긴 구간의 위·아래에 이전/다음/최근 원고 이동을 두었어요. 스크롤 위치 탐색은 표시된 block의 이진 탐색을 사용하고 Prose의 동일 텍스트 렌더링은 memo로 재사용해요.
- 서재는 `/library?view=summary`로 본문과 전체 에셋을 생략해요. 편집/시작 시 표시된 immutable revision을 조회해요. 보관 revision 조회 effect는 attachment signature에 묶어 SSE마다 본문을 재전송하지 않아요. 상세 수치와 계약은 [서재 결과](LIBRARY-LOADING-RESULTS.md)에 있어요.
- Dialog는 처음 열기 전 자식을 마운트하지 않고, 열었던 폼은 같은 scope에서 유지해요. 이미지 목록은 펼쳤을 때 48개씩 렌더링해요. 이미지 선택 의미·생성 로직은 바꾸지 않았어요.

DB schema, createRun/history 생성 입력, immutable source/Run snapshot, source hash, CAS/idempotency, owner/generation, 연결 권한·취소·불확실 실행 자동 재생 금지 계약은 변경하지 않았어요.

## 검증과 증거

| 검증 | 결과 / 증거 |
| --- | --- |
| 타입 검사·빌드 | PASS. 최종 buildId `76f641cb956894fdfc3f8834b2c6dd703c82db71d7aaf9d652de4579cfbcd7de` |
| 전체 단위 검사 | 606/606 PASS, 실패·skip 0. [JSON](../output/loading-final-vitest.json) |
| 기존 UI | 단위 9 + 브라우저 19 PASS. [summary](../output/playwright/ui-2026-09-07T04-35-24-287Z-ecdd3437/summary.json) |
| 로딩 브라우저 | LOADUI01–04 모두 PASS. [summary](../output/playwright/loading-ui-2026-09-07T04-35-23-887Z-63cf6d3b/summary.json) |
| 개선 전 성능 | [baseline](../output/playwright/loading-baseline-2026-09-07T04-13-23-861Z-17f40056/summary.json) |
| 최종 성능 | [verified](../output/playwright/loading-verified-2026-09-07T04-36-27-706Z-e6946691/summary.json) · [화면](../output/playwright/loading-verified-2026-09-07T04-36-27-706Z-e6946691/initial.png) |

전체 단위 검사 후 마지막으로 바뀐 것은 클라이언트의 늦은 탐색 오류 격리와 같은 원고 재선택 처리예요. 그 변경은 최종 빌드의 UI 19개·로딩 4개와 성능 실행으로 확인했어요. 선택 단위 9개는 전체 606개와 중복이에요. M0/M1/M2 전체 인수나 모델 품질 PASS로 확대하지 않아요.

LOADUI는 12개 원고의 페이지/직접 URL/읽던 anchor 복원, 두 탭 원문 CAS 충돌·초안 보존·다른 채팅 격리·직접 번역, 봇 100개 목록에서 정확한 과거 revision 조회, 오프라인 수정/재접속과 이어지는 단일 원고 SSE delta를 확인해요. 단위 검사는 100개 전체 페이지 순회, 임의 원고의 구간 정규화, branch/chat scope, source 수정과 최신 번역 hash, immutable 기록, 잘못된 cursor, 진단 본문 분리를 확인해요. 실제 화면도 PC 초기 화면과 390px 편집 충돌 화면에서 확인했어요.

초기 sandbox의 `spawn EPERM`은 승인된 로컬 실행으로 분리했어요. 중간 FAIL 증거는 그대로 남겼어요. 서재 placeholder 계약을 잘못 가정한 새 테스트, 새 API와 맞지 않던 기존 intercept, 구간 탐색의 부분 이름 일치 문제는 검사를 올바른 계약에 맞췄어요. 실제 제품 결함인 offline 연결 처리와 짧은 대화 복원은 수정 후 통과했어요. 실패를 PASS로 덮어쓰지 않았어요.

## 통합 주의점과 남는 비용

`server/store.ts`의 생성 의미는 수정하지 않았어요. native 쪽 `core/types.ts`/`core/product.ts`/`server/app.ts`/`product-store.ts`/`web/main.tsx` 변경과 병합할 때 additive reader route·타입·summary 분기를 보존해요. 새 native 콘텐츠 편집기는 `Library.contentBodiesOmitted`를 확인해 정확한 revision 본문을 가져온 후 저장해야 해요. 공급자 모델·연결 목록 필드는 summary에서 그대로 유지해요. 사용자 미커밋 `NATIVE-PORTING.md`는 읽기만 했고 공용 CURRENT/SOURCES는 변경하지 않았어요.

선택 채팅의 에셋 메타데이터와 Run 요약 목록은 여전히 전체를 읽어요. prompt preset 본문도 library summary에 남아요. SQLite는 Run metadata를 추출할 때 저장된 JSON을 읽으며, 실행 상세를 열면 선택한 Run의 큰 snapshot이 의도적으로 전송돼요. 현재 개선은 반복 전송·과거 원고 전체 DOM의 주요 비용을 제거한 범위이며 무한 보관 규모의 상수 비용을 보장하지 않아요. 큰 이미지 자체와 실제 tokenizer·모바일/원격 환경은 별도 측정이 필요해요.
