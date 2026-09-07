# 서재 목록 로딩 측정

2026-09-07, 로컬 Windows / 격리 합성 SQLite, 실제 provider 호출 없음.

`GET /api/library?view=summary`는 콘텐츠 본문을 SQLite에서 제외하고 목록 메타데이터만 반환해요. `contentBodiesOmitted`와 `assetsOmitted`를 명시하고, 기존 `GET /api/library` 전체 응답은 유지해요. 웹은 선택한 채팅의 assets를 사용하므로 전체 보관 assets 목록은 summary에서 생략해요. 프롬프트 프리셋은 기존 UI 계약을 유지해 전체 본문을 반환해요.

LibraryPanel은 summary 자료 편집/시작 시 기존 immutable revision API를 조회해요. 조회 실패 시 편집기를 열지 않으며 다른 선택·탭 이동·새 자료 생성·unmount 후 늦은 응답을 적용하지 않아요. 저장 CAS는 그대로 유지해요. summary의 `contents[].text`는 빈 문자열 placeholder이므로 다른 본문 편집기를 추가할 때도 `contentBodiesOmitted`를 확인하고 revision 상세를 조회해야 해요.

## 재현과 결과

`npm exec vitest run tests/library-loading.test.ts`와 `npm run check`가 통과했어요. 첫 sandbox 실행의 Windows `spawn EPERM`은 승인 환경에서 다시 실행해 해결했어요.

fixture는 봇 100개와 로어 10개, 본문 총 8,720,000문자, PNG 1px 에셋 1,000개예요. 실제 토큰화는 하지 않았으므로 토큰 수로 주장하지 않아요. 로어 총 920,000문자이며 실제 대용량 이미지 디코딩 비용을 측정한 fixture가 아니에요.

| API | UTF-8 응답 bytes | Fastify inject 경과 ms |
| --- | ---: | ---: |
| 기존 full | 9,124,286 | 48.584 |
| summary | 20,446 | 7.397 |

수치는 한 번의 실행 관측이며 HTTP 네트워크·브라우저 초기 표시·모바일 실측이 아니에요. byte 감소는 본문 생략 효과이고 지연 수치는 환경에 따라 달라져요. 기록은 `output/library-loading/summary.json`으로 재생성돼요.

테스트는 본문 생략/메타데이터 일치, 에셋 full 호환, 정확한 과거 revision 보존, 최신 목록 revision, stale CAS 거절, 잘못된 view 거절을 확인해요. useStory의 summary API 연결과 정확한 revision의 실제 브라우저 편집은 LOADUI03에서 통과했어요. [통합 결과](LOADING-RESULTS.md)를 확인해요.

## 진단 화면 후속 분리

`server/reader-routes.ts`의 `readerRoutes(app, store)`는 채팅별 attempts/jobs 메타데이터와 단일 attempt/job 본문 조회를 제공해요. 메타데이터 SQL은 request/response/raw usage와 job 입력·결과를 읽지 않아요. 기존 인증 hook을 적용하는 app에서 등록해야 해요.

TasksPanel은 보조 작업 메타데이터만 먼저 조회하고, Run/Job 상세를 펼칠 때 기존 Run 또는 단일 Job API를 조회해요. 비용 Inspector는 펼칠 때 attempts 요약, 개별 시도를 펼칠 때 request/response를 조회해요. 실패와 로딩을 명시하고 빈 진단을 만들어내지 않아요. 열린 상세는 reader cursor 변화에 갱신하며 닫으면 큰 응답 state를 해제해요. off-page 분기의 원고는 완료되지 않았다고 표시하지 않고 보관된 장면으로 안내해요.

`npm exec vitest run tests/reader-diagnostics.test.ts` 통과: 대형 합성 request의 목록 생략, 단일 세부 정확성, 다른 채팅 분리, null 비용 보존을 확인했어요. `npm run check`도 통과했어요. app 등록과 SourceReader의 Job 진단 지연 조회를 통합했어요. 최종 기존 UI 19개와 로딩 브라우저 4개 검증 결과는 [통합 결과](LOADING-RESULTS.md)에 있어요.
