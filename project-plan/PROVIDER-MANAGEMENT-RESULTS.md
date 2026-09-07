# 공급자 관리와 모델 등록 보조 · 2026-09-07

작업 기준은 main `51e51967503dd9de9f765c0702210a360adde674`예요. `codex/provider-management` 전용 작업트리에서 구현했으며 공용 main에 직접 병합하거나 push하지 않았어요. 원래 루트의 미커밋 native 문서는 읽기만 했어요.

작업트리: `C:/Users/wodus/.codex/visualizations/2026/09/07/01a07961-8314-75c2-971f-0dade42cfa71/uimori-provider-management`.

## 구현 결과와 사용법

1. **연결·모델 관리**: 설정 → 연결과 모델에서 이름·주소·모델 ID를 검색하고 수정·복제·비활성화해요. 복제는 별도 ID의 초안이며 사용자가 등록 버튼을 눌러야 저장해요. 연결 복제는 비활성 상태로 시작해요. 수정 충돌 시 초안과 expectedRevision을 유지하고 최신 다시 불러오기에서만 교체해요.
2. **등록 흐름**: 공급자 템플릿 → 연결 등록 → 서버 인증/Origin 준비 상태 → 명시적인 모델 목록 조회 또는 수동 ID → 모델 옵션 → 저장 → 새 이야기/이야기 설정의 역할 배정 순서예요. 등록 직후 모델 양식에서 해당 연결을 선택해요. 조회 실패 시 마지막 목록을 유지하고 실패를 완료로 표시하지 않아요. Vertex의 목록은 로컬 지원 목록이에요.
3. **정의와 출처**: 기존 7개 어댑터의 안정적 ID·정의 revision·설정 가능한 옵션·인증/목록 방식·확인일·소스 파일을 `core/provider-definitions.ts`에 둬요. 정의는 로컬 구현 설명이며 모델별 기능·가격 보증이 아니에요. 서버가 모델 등록 출처와 당시 catalog timestamp를 고정하고, 사용자 확인값은 `userOverrides`로 따로 표시해요.
4. **모델 등록 보조**: 이미 저장한 모델을 선택하고 자연어로 새 연결/모델 설정안을 요청해요. 최대 1회·60초이며 `registration.propose` 또는 완료 JSON을 같은 저장 검증으로 검사해요. **검토한 연결·모델 등록 적용**을 눌러야 원자적으로 생성해요. 제안은 기존 설정을 수정하지 않으며 새 연결은 비활성으로 생성돼요. 인증·Origin 설정과 활성화, 역할 배정은 사용자가 진행해요.

비활성 연결 버전에 모델을 저장한 경우 연결 활성화 후 모델 편집에서 최신 연결 버전을 명시적으로 선택해 저장해야 해요. 프리셋은 연결 revision에 고정되므로 이를 조용히 최신 값으로 바꾸지 않아요. 신규 모델 ID를 등록하는 것과 새 API 프로토콜을 지원하는 것은 다른 작업이에요.

자세한 사용법은 [공급자 안내](../docs/PROVIDERS.md), 참고 소스와 미채택 구조는 [정적 조사 근거](PROVIDER-DEFINITIONS-SOURCES.md)에 있어요.

## 저장과 권한 계약

- 연결·모델 수정은 기존 versions와 CAS를 사용해요. 모델의 비활성 표시는 새로운 역할 선택을 막고 기존 동일 ref 배정·과거 Run을 유지해요. 연결의 비활성·주소/프로토콜/인증 참조 변경은 기존 매호출 권한 검사에 반영돼요.
- 관리 UI는 편집 시작 시 정확한 연결/모델 revision을 읽어요. 목록 새로고침이나 늦은 준비 상태 응답이 편집 초안·모델 옵션을 덮지 않아요.
- 준비 상태는 지정된 서버 환경변수의 존재·형식 또는 ADC 파일 설정 여부만 반환해요. 키 원문·환경변수 전체·ADC 파일 내용은 브라우저에 반환하지 않아요. 실제 인증 테스트나 서버 설정 자동 변경은 없어요.
- 보조 요청은 설정 목록의 이름·ID·프로토콜과 사용자 요청만 사용해요. 이야기 본문·사용자 endpoint·credential 참조·원문 읽기 도구를 모델에 제공하지 않아요. 새 연결 제안의 endpoint는 검토 대상 데이터일 뿐 실행 권한이 아니에요.
- `versions`의 `registration-run`은 요청·단일 attempt·검토안·적용 결과를 append-only로 기록해요. 전송 전에 attempt를 저장하고 미확인 실행은 자동 재생하지 않아요. 같은 request key와 적용 hash는 원래 결과를 반환해요. 재시작 시 running 요청은 interrupted로 바뀌고 자동 호출하지 않아요.
- 등록 적용은 planHash/expectedRevision, 현재 연결 revision, 기존 connection/model 검증을 다시 확인한 뒤 한 트랜잭션에서 생성해요. 보조 모델의 권한/연결은 전송 전과 응답 후 재확인해요. 취소·세션 만료·권한 철회 결과를 새 설정으로 채택하지 않아요.
- 관리 attempt도 같은 DB의 Vertex 예산에 포함돼요. 중간 journal revision을 중복 합산하지 않아요. raw usage와 응답/opaque 원문을 관리 이력에 저장하지 않으므로 관리 Vertex 요청은 완료 후에도 전액 예약을 보수적으로 유지해요. `costUsd=null`과 가격 미확인을 0으로 바꾸지 않아요.
- JSON/SQLite 백업은 관리 이력도 보존해요. JSON 복원은 엄격한 schema·frozen 참조·attempt append-only·hash·적용 결과를 검사하고 기존 연결 인증 해제 정책을 유지해요. 이후 ready 제안을 적용할 때도 최신 연결 검증을 다시 수행해요.

## 실제 검증

검증에는 새 파일 SQLite·임시 포트·분리된 Chrome profile과 합성 loopback만 사용했어요. 테스트의 모델 응답은 고정 합성 JSON/SSE이며 실제 모델의 자연어 해석 능력이나 외부 계정 호환성을 측정하지 않아요.

| 검사 | 실측 결과 | 근거 |
| --- | --- | --- |
| TypeScript | PASS | `npm run check` |
| 빌드 | PASS | `npm run build`, 아래 source/dist 식별값 |
| 전체 Vitest | 639/639 PASS, 실패·skip 0 | `output/provider-management/unit-final.json` |
| 신규 핵심 검사 | 41개, 위 전체 검사에 포함 | definitions 5, management 6, selection 4, agent 8, routes 8, registration store 10 |
| 공급자 관리·등록 UI | 6/6 PASS, 실패·skip 0 | `npm run verify:providers`, [summary.json](../output/playwright/provider-management-2026-09-07T04-51-23-478Z-f15a8599/summary.json) |
| 기존 Sol 등록·역할·390px UI | 2/2 PASS, 실패·skip 0 | `npm run verify:sol`, [summary.json](../output/playwright/sol-ui-2026-09-07T04-52-17-342Z-e3b74365/summary.json) |
| 종료·격리 정리 | 두 UI 실행 모두 PASS | 각 summary의 `livePids=[]`, `runtimeRemoved=true`; evidence DB와 reporter·화면 보존 |

두 최종 UI 실행은 같은 빌드를 사용했고 실행 후 source identity도 확인했어요.

- source/build ID: `87a756924745401d8fd461383b34953ec7f482f0d06d597bef2fe5f861fbfc04`
- dist SHA-256: `5ca75226e9645082d743676f05bbe2e16278f4201e8fb3c6b49f68eb0061225a`
- 빌드 시각: `2026-09-07T04:51:18.202Z`. source fingerprint에는 코드·테스트·설정·검증 스크립트가 포함되고 이 결과 문서는 포함되지 않아요.

화면은 최종 관리/등록 캡처 7장과 Sol 모바일 옵션 캡처 1장을 직접 확인했어요. 데스크톱 수정 충돌과 등록 적용 결과, 390px의 모델 옵션·사용자 확인값·제안 검토가 화면 폭 안에서 읽히고 세로 스크롤로 이어져요. 관리 UI fixture의 등록 호출은 두 시나리오에서 각각 1회, 합계 2회였고 fixture 오류는 0개예요.

핵심 회귀는 다음을 확인해요.

- 서버 prepare 검증은 쓰기 0, 제안 ready까지 연결/모델 수 불변, apply 실패 시 두 등록 모두 rollback, 반복 적용의 ID 동일.
- catalog GET 실패·목록 유지·동시 연결 수정의 CAS 409, 무지원 옵션/프로토콜 거절, 준비 상태의 secret 비노출.
- 기존 채팅의 역할·source/hash·snapshot 불변, 비활성 모델의 신규 역할 배정 차단, 기존 동일 ref 설정 저장 허용.
- 실제 loopback 요청 전에 attempt 존재, 최대 1회, 취소·권한 철회·세션 해제, 잘못된 tool/JSON은 설정 무변경.
- crash 후 journal running→interrupted와 별도의 실제 앱 정상종료/재시작에서 추가 호출 0. 비정상 외부 provider 실행 결과까지 확정하지 않아요.
- 공유 Vertex 예산의 narrative+registration 합산, 여러 journal revision에도 1회로 계산, 불확실 예약 유지, archive attempt 삭제/변조 거절.
- UI의 사전 admission 거절 뒤 입력 복구와 응답 수신 실패 후 동일 키 재확인. 확정 4xx와 불확실 네트워크 실패를 구분해 중복 호출을 막아요.

처음 sandbox 실행에서 Vite/Chromium 자식 프로세스가 `spawn EPERM`으로 막혔고 정상 승인 경로로 같은 검증을 실행했어요. 이 환경 실패는 제품 검사 실패와 구분해요. 390px 브라우저는 실제 휴대폰 키보드·네트워크 검증이 아니에요.

첫 관리 UI 실행(`provider-management-2026-09-07T04-48-10-289Z-7ee857ca`)은 4 PASS·2 FAIL이었어요. 등록 보조 테스트의 탐색 함수가 390px에서 접힌 메뉴를 열지 않아 시간 초과됐고, 해당 테스트 함수를 수정한 뒤 위 최종 6개가 통과했어요. 최초 실패 증거는 그대로 남겼어요. 전체 Vitest 이후의 제품 변경은 UI의 admission 오류 입력 복구이며 PMUI06으로 검증했어요.

## 미지원과 통합 주의

- 원본 Provider Manager의 원격 registry 다운로드·동적 정의 import·임의 headers/body·OAuth·key rotation·자동 fallback·새 adapter 설치는 구현하지 않았어요. 원본 실행·수정·코드 복제도 하지 않았어요.
- 보조 등록은 새 연결/모델 생성안을 제공해요. 기존 설정 수정은 관리 UI에서 해요. Sol preloaded 요청 및 등록 제안 외 Sol 도구 왕복은 미지원이며 무음 옵션 변경·추가 모델 호출로 보완하지 않아요.
- 실제 키·사용자 DB·유료 API·개인 작품 전송·push·배포는 사용하지 않았어요. 모델별 기능·요금·실제 공급자 연결·문학/번역 품질은 미검증이에요.
- `ConnectionEditor` 외부 props/re-export와 기존 `/api/library` 형태를 유지해요. 로딩 작업의 `view=summary`는 connections/models를 그대로 제공하므로 호환돼요. 관리 검색은 content 본문에 의존하지 않아요.
- native와 경합 가능 파일은 `core/product.ts`의 Connection/ModelPreset만, `product-store.ts` connection/model/metadata/archive와 신규 선택 guard, `product-routes.ts` 관리 routes예요. PromptPreset/program·역할 메시지 조립·wire encoder는 수정하지 않았어요. `useStory.ts` quickModels, `main.tsx` 선택 목록·StoryPanel connections prop은 로딩/native 변경과 합칠 때 보존해야 해요.
- schema 번호는 변경하지 않았지만 새 `registration-run` kind를 이해하지 못하는 구버전은 해당 JSON archive 복원을 거절해요. 예산과 복원 검증을 함께 통합해야 하며 새 journal kind만 분리해서 빼지 않아요.
