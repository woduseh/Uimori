# 생성 준비의 이력·요약 조회 성능 개선 — 2026-09-08

## 대상과 기준 상태

`main`의 `3ee79f7`에서 시작했으며 작업트리는 깨끗했어요. 성능 측정·검증 단계에서는 사용자 DB·외부 공급자·배포·push를 사용하지 않았어요. 기존 `AGENTS.md`, `docs/QUALITY.md`, `project-plan/CURRENT.md`, `tests/story-performance.test.ts`, `scripts/measure-loading.mjs`를 확인했어요. 이전 검증 수치 대신 현재 체크아웃에서 기준 검사를 실행했어요.

- 변경 전 `npm run quality`: PASS.
- 변경 전 `npm test -- tests/story-performance.test.ts tests/product.test.ts tests/source-editing.test.ts tests/reader.test.ts`: **4파일 51 PASS**.
- 최초 Vitest는 샌드박스 `spawn EPERM`으로 시작하지 못했어요. 로컬 실행 권한으로 같은 검사를 재실행해 통과했으며 제품 실패와 구분해요.
- 새 history 회귀 테스트의 첫 실행은 fixture 제목 인자 누락으로 6개 실패했어요. 테스트 준비 코드를 수정한 뒤 6개 모두 통과했어요. 기존 source-editing/story-performance 14개는 그 실행에서도 통과했어요.

## 선정 근거와 구현

생성 전 이력 구성(`Store.history`)과 이전 요약 탐색(`previousContextPlan`, `server/app.ts`의 `prepareInputContext` 호출 직전)을 선정했어요. 긴 대화에서 다음 생성이 시작되기 전 서버 이벤트 루프를 동기적으로 점유하는 실제 저장소 경로예요. 전체 생성 요청에는 이외의 프롬프트 컴파일·토큰 추정·저장·공급자 호출이 있어요.

1. **이력 조회의 불필요한 가공·중복 SQL**: 장면마다 `source()`와 `sourceOriginal()`이 원문·번역 revision을 중복 조회하고 화면용 문단을 나누며 문단 anchor 해시를 생성했어요. 필요한 출력은 원문/최신 수정본·hash·원문 시점 구간 정책뿐이에요. JOIN과 최신 edit subquery로 장면당 6회를 1회로 줄였고, 앞쪽 삽입 대신 append 후 한 번 reverse해요.
2. **이전 요약 탐색의 전체 Run 로딩**: 요약이 없는 조상도 `store.run()`을 호출해 전체 누적 history snapshot을 JS에서 두 번 파싱하고 model inputs·tool events를 조회했어요. SQLite에서 contextPlan만 먼저 추출하고 후보의 snapshot만 읽어 한 번 파싱해요. 같은 호출 안에서 현재 source refs도 필요할 때 한 번 계산해요.

`validateSourceIdentity`를 문단 분할과 분리했지만 기존 id/chatId/본문 공백/hash 검증은 그대로 실행해요. 최신 수정본과 원본을 모두 검증하며 source/hash/viewHash/canon 비교, 후보 전체 검증, 조상 순서, 누락 404, 사이클 거부, 반환 객체의 독립성을 유지해요. 원문·실행 snapshot·API 결과 계약은 바꾸지 않았어요. 캐시·스키마·인덱스·새 의존성·동시성 변경은 없어요.

주요 파일:

- `server/store.ts`: 이력 전용 조회.
- `server/context-planning.ts`: 요약 후보 선별 조회.
- `core/auxiliary.ts`: 기존 source identity 검증 재사용.
- `tests/source-history-storage.test.ts`, `tests/context-checkpoint-storage.test.ts`: 정확성 회귀.
- `scripts/measure-context-storage.mjs`: 반복 측정과 출력 동등성·SQL 계측.

## 측정 방법

Windows x64, AMD Ryzen 7 7800X3D(16 logical CPUs), RAM 약 32GiB, Node 24.14.0, SQLite 3.51.2를 사용했어요. 합성 파일 SQLite 하나에 10/100/300개 장면을 가진 채팅을 만들었고 장면당 8,000 UTF-16 code units의 문단 본문과 각 Run의 전체 누적 history를 저장했어요. 100개는 대표 장기 채팅, 300개는 저장소 확장 스트레스 시나리오예요. 요약 계획은 ready이지만 compacted가 없는 탐색 실패 조건이며 모델 입력 한도·실제 요약 실행을 측정하지 않아요. profile/resource/diagnostic payload는 넣지 않았어요.

각 경로는 첫 측정을 별도 기록하고 **워밍업 3회 후 9회** 측정했어요. 각 샘플 전 GC는 측정 구간 밖에서 실행해요. fixture 무결성·내용 해시·이력 검사가 먼저 실행되므로 첫 측정도 진정한 cold disk 측정이 아니에요. OS 파일 캐시는 비우지 않았어요. CPU를 사용하는 다른 테스트·빌드는 측정과 동시에 실행하지 않았어요.

전후에는 **같은 DB 파일**을 사용하고 누적 snapshot SHA-256과 이력 출력 SHA-256을 대조해요. 함수별 경과시간·process CPU·반환 직후 heap delta를 기록하고, 별도의 비측정 호출에서 실제 SQL 실행 수와 DB→JS 문자열 UTF-8 bytes를 세요. 이 문자열 수치는 물리 디스크 I/O가 아니며 heap delta는 최대 메모리나 총 할당량이 아니에요.

측정 자료는 `output/context-storage/fixture-GaD0WB/`에 보존해요. baseline snapshot hash는 `1cec6f1cb2aa7677ae6f2b2488049668175544c6377992ad1c4221fae2bc2176`이에요.

## 실측 결과

표는 중앙값이며 괄호는 9회 측정의 최소–최대, 단위는 ms예요. 결합 경로는 두 단계를 연달아 실행한 별도 측정이므로 각 단계의 중앙값 합과 다를 수 있어요.

| 장면 수 | 경로 | 변경 전 | 변경 후 | 중앙값 감소 |
| ---: | --- | ---: | ---: | ---: |
| 10 | 이력 구성 | 3.96 (3.61–4.16) | 0.47 (0.46–0.56) | 88.1% |
| 10 | 이전 요약 탐색 | 2.60 (2.58–2.79) | 0.48 (0.47–0.58) | 81.5% |
| 10 | 두 단계 결합 | 6.39 (6.34–6.89) | 0.91 (0.90–1.08) | 85.8% |
| 100 | 이력 구성 | 64.62 (63.44–66.36) | 35.84 (34.27–41.70) | 44.5% |
| 100 | 이전 요약 탐색 | 109.41 (106.44–116.66) | 34.58 (33.78–36.68) | 68.4% |
| 100 | 두 단계 결합 | 178.46 (173.45–181.07) | 66.55 (65.85–71.33) | **62.7%** |
| 300 | 이력 구성 | 444.20 (440.59–454.68) | 345.18 (342.29–353.05) | 22.3% |
| 300 | 이전 요약 탐색 | 856.65 (851.44–884.04) | 349.34 (347.34–373.80) | 59.2% |
| 300 | 두 단계 결합 | 1316.66 (1311.45–1337.35) | 698.55 (689.26–715.24) | **46.9%** |

100장면 결합 경로에서 약 **112ms**, 300장면에서 약 **618ms**의 동기 서버 작업을 줄였어요. SQL과 문자열 읽기 감소는 별도 계측에서도 확인했어요.

| 장면 수 | 결합 경로 SQL 실행 수 | DB→JS 문자열 bytes | process CPU 중앙값 |
| ---: | ---: | ---: | ---: |
| 10 | 120 → 20 | 621,814 → 166,220 | 해상도 미달(0ms) |
| 100 | 1,200 → 200 | 43,134,839 → 1,735,003 | 172 → 63ms |
| 300 | 3,600 → 600 | 375,537,734 → 5,705,702 | 1,297 → 688ms |

300장면에서 SQL은 **83.3%**, DB→JS 문자열은 **98.5%** 감소했어요. 반환 직후 heap 증가 중앙값은 결합 경로에서 100장면 **66.16→2.26MB**, 300장면 **109.63→8.42MB**였어요. 실행 중 GC의 영향을 받으므로 이 수치를 최대 메모리 감소율로 표현하지 않아요. 모든 MB는 십진수예요.

전후 environment 필드, fixtureSnapshotHash, 3개 이력 outputHash가 모두 일치했어요. 각 측정마다 출력 hash와 `previousContextPlan === undefined`를 검증했어요. 두 단계 모두 9회 범위가 전후 겹치지 않았어요. 첫 측정(워밍업 반복 전)의 결합 시간도 100장면 **175.16→66.75ms**, 300장면 **1316.75→690.14ms**였지만 앞서 설명한 대로 cold disk 측정은 아니에요.

- [변경 전 원자료](../output/context-storage/fixture-GaD0WB/baseline-1788858219027.json)
- [변경 후 원자료](../output/context-storage/fixture-GaD0WB/improved-1788858633718.json)
- [전체 샘플·CPU·heap·SQL 비교](../output/context-storage/fixture-GaD0WB/comparison.json)
- 변경 전 source/build: `794ea0681437e5d85bc9cc302c6f88c28ed774282005efb3523bbfc2460dcfe0` / `2ad38143528eecc185deb7de4316ddf51f4e1671e5d108543e7caf78d551e184`
- 변경 후 source/build: `1383b1ae95ca89e95b45a3e6e09a583ec74e5ff7cd11792aeb19988c08d1f435` / `b611159a073b295b76b4b33d5c77716876a1198268bdb2c784ccd8555da31298`

## 정확성·회귀 검증

- **`quality:full` PASS**: Biome·TypeScript·빌드, 하네스 **26/26**, Vitest **1,354 PASS·1 opt-in skip**(126파일 PASS·1파일 skip). skip은 `NR_CODEX_PREFLIGHT`로 명시 선택하는 설치 Codex 사전 검사이며 이번 실행에서 수행하지 않았어요. [전체 로그](../output/context-storage/quality-full.log) · [하네스 보고서](../output/tooling/2026-09-08T09-08-03-639Z-4f3b62b3/summary.json)
- 신규 history 6개: 원문/최신 수정본/원문으로 되돌린 수정, 분기 순서, 원문 시점 구간 정책, 과거 Run 불변성, 빈 이력, 누락·사이클, 원본/수정본의 공백·hash 손상 거부.
- 신규 checkpoint 14개: 요약 없음/null, 최신 조상 우선, 오래된 유효 요약 fallback, 손상·다른 budget/dependency·pending/failed 후보 제외, 현재 원문/정사 변경·Hidden Story 보존창 만료 시 거부, 반환 객체 독립성, 원문 identity·누락 source/run 거부.
- 전체 검사에 기존 원문/번역 직접 수정·archive/fork·요약/재사용·취소·패키지·Reader HTTP 페이지/분기/진단·S07 성능 정확성 테스트도 포함돼요.
- **`verify:smoke` F02/F03/F06 PASS**: 실제 loopback HTTP/서버 재시작 검사 4개·브라우저 2개, 중복 명령·CAS·다중 탭/문맥 격리·재접속·늦은 응답 처리·하네스의 의도적 실패 감지, source/build 일치와 cleanup PASS를 확인했어요. [smoke 보고서](../output/playwright/2026-09-08T09-11-10-482Z-6bcf6d33/summary.json)
- 검증 후 제품 소스 변경은 없고 결과 문서만 정리했어요.

## 재현

현재 구현 측정:

```powershell
npm run build
node --expose-gc scripts/measure-context-storage.mjs --label reproduced
```

같은 데이터로 반복하려면 출력된 fixture 경로를 사용해요. 이 작업의 보존 DB로 다시 측정하는 명령은 다음과 같아요.

```powershell
node --expose-gc scripts/measure-context-storage.mjs --label repeated --fixture output/context-storage/fixture-GaD0WB
```

변경 전을 다시 만들려면 별도 체크아웃의 `3ee79f7`에 이 측정 스크립트만 복사하고 같은 Node/의존성으로 빌드한 뒤 실행해요. fixture 폴더를 개선 체크아웃의 `output/context-storage/`에 그대로 복사해 전후에 동일한 fixtureSnapshotHash와 outputHash가 나오는지 확인해요. 사용자 DB를 지정하지 않도록 스크립트는 자체 fixture 표식과 `output/context-storage/fixture-*` 경로만 허용해요. 측정 DB는 보존하며 자동 삭제하지 않아요.

정확성 검증 명령:

```powershell
npm run quality:full
npm run verify:smoke
```

## 보류와 한계

- SQLite의 JSON 필드 추출도 누적 snapshot 본문을 읽고 파싱해요. 저장된 전체 history의 제곱 수준 증가를 없앤 변경이 아니며, 긴 이력의 남은 비용으로 기록해요.
- Reader는 이미 페이지·증분 응답을 사용하지만 모든 Run의 snapshot에서 표시 메타데이터를 추출해요. 이번에는 생성 준비의 실측 병목에 집중했으며 Reader 최적화 효과는 주장하지 않아요.
- 패키지 컴파일의 같은 요청 내 반복과 요약 후보 선택 중 반복 토큰화는 코드로 찾은 후속 후보예요. 아직 성능을 측정하지 않았어요. 특히 사용자 PromptProgram 조건은 토큰 수의 단조성을 보장하지 않아 단순 이진 탐색을 도입하지 않았어요.
- 효과 없는 제품 변경을 남기거나 되돌린 실험은 없어요. 검증 실패를 숨기거나 데이터/기능을 생략하지 않았어요.
- 실측 범위는 합성 파일 SQLite의 생성 준비 두 단계예요. 전체 앱 응답시간·공급자 TTFT/처리량·청구 비용·휴대폰·Linux/Docker·cold disk 성능으로 확대 해석하지 않아요. 실제 요약 재사용·무효화는 성능 수치 대신 회귀 테스트로 검증해요.
