# 공급자 생성 설정·캐시·응답 테스트 결과

## 2026-09-08 후속 구현과 통합 상태

모델·연결의 편집 버전 선택을 제거하고 `provider_settings`의 최신 한 벌과 자체 실행 snapshot을 분리했어요. 기본 입력 한도 272,000, 실제 요청 body 추정, 이전 대화 자동 요약·체크포인트 재사용, 상태/기억 보조 작업의 동일 압축을 추가했어요. 출력 한도 확대 요청은 철회되어 변경하지 않았어요. [현재 설정 계약](../docs/MODEL-PARAMETERS.md), [컨텍스트 계약](../docs/CONTEXT-LIMITS.md)을 확인해요.

후속의 확정된 로컬 증거는 상태·등록 69/69(`latest-settings-story-registration-vitest.json`), 설정 30/30(`current-settings-final.json`), 압축 엔진 17/17(`context-compaction-vitest-final.json`), WASM 입력 예산+App/SQLite 통합 37/37(`vitest-context-wasm-regression.json`), 상태·기억 압축 20/20(`story-context-compaction-vitest-initial.json`)이며 모두 `output/provider-parameters/`에 있어요. 이 결과들은 합본 전체 회귀 수치가 아니에요.

첫 후속 전체 검사는 1,035 PASS·30 FAIL·1 skip(`vitest-context-integration-first.json`)이었어요. 남은 구형 설정 fixture를 갱신하면서 번역 `claimJob`이 선택 모델 snapshot을 유실하는 결함을 발견해 고쳤고, claim 전 준비 실패는 queued 상태에서 반복되지 않고 명시 실패로 끝내도록 했어요. 중단·원본 SQLite 증거는 `current-settings-selected-cancelled/`, `current-settings-selected-retry-stall/`에 보존했어요. 반복 문자열의 로컬 tokenizer 지연도 독립 재현한 뒤 segmented WASM 추정으로 바꿨어요. 중단된 실행에는 임의 PASS/FAIL 개수를 부여하지 않았어요.

사용자가 공통 자료·로어 작업과 함께 main 병합·커밋을 승인했어요. 상대 브랜치는 `63035455e870ac5d8dd06a7f7d4ff8bbfc5c619d`이고, 합본의 검증·커밋은 진행 중이에요. **아래 2026-09-07 표는 이 후속 범위 이전에 확인한 증거예요.**

2026-09-07. `5761bb2f5aaf9dfc14c91f8b29598111c266acf3`에서 분리한 `codex/provider-parameters` 작업이에요. Google global 고정·누적 예산 제거를 반영하고, 후속 요청인 Claude Fable 5.1·GPT Flex·캐시 OFF/자동/유지 시간·짧은 실제 응답 테스트를 구현했어요. 전체 화면 회귀와 마지막 시각 확인을 진행 중이에요.

## 구현

- **모델별 설정**: Google Agent Platform 카드에서 모델명 접미사를 제거하고 global endpoint를 유지해요. 모델 프리셋에 Thinking Level, Reasoning Effort/Verbosity/Mode/Context, Claude Output Effort/Thinking, Service Tier를 저장해요. Flex는 Google과 등록된 GPT Responses/Chat에서 선택해요.
- **공통 검증**: `core/model-capabilities.ts`의 정확한 모델 ID·허용값·조합·명세 revision을 UI, 저장/등록 보조/archive, 실행에서 공유해요. 미지정 필드는 생략하고 `none`·`disabled`는 유지해요. 미지원값은 초안에 표시하며 자동 하향·모델 치환·Flex fallback을 하지 않아요.
- **모든 역할에 전달**: 공통 generation 추출기를 main/translation/status/image/state/memory/등록 보조에 적용해요. 저장한 모델·옵션·capability revision을 snapshot에 고정하며 평가 도구의 명시적인 절약 조정 외에는 binding을 바꾸지 않아요.
- **캐시**: Claude와 지원 GPT Responses에서 OFF, 작성 기준점, 자동 캐싱+기준점, 확인된 TTL을 제공해요. 기존 프롬프트 기준점과 continuation의 reasoning·서명·도구 ID를 보존해요. Inspector는 공급자가 반환한 캐시 읽기/쓰기 토큰을 표시하고 누락은 미확인으로 남겨요.
- **응답 테스트**: 저장한 모델에서 `API 연결 테스트 중이니 OK만 답해주세요.`를 출력 256토큰·25초·최저 effort·도구 없음으로 한 번 보내요. 선택한 Service Tier는 유지해요. 모델 revision·세션·현재 연결 권한을 확인하고, durable 전송 기록·동시 실행 제한·idempotency·재시작 중단 처리를 적용해요. 작품 본문은 보내지 않아요.
- **ProviderBudget 제거**: 누적 호출/추정 금액 제한·단가·예약 메타데이터·환경변수 의존성을 제거했어요. 작업별 출력/시간/호출 한도, 전송 전 기록, 취소·중복 방지, usage와 `costUsd=null`은 유지해요.
- **schema/archive v9**: 구형 연결 `requestTier` 등을 받지 않아요. 새 `provider_connection_tests` 진단은 작품 JSON archive에서 제외하고 SQLite backup에는 포함해요. 구버전 이관·호환 UI·자동 백업은 추가하지 않았고 사용자 DB도 초기화하지 않았어요.

정확한 지원 ID, API 매핑, 캐시 한계와 사용 절차는 [모델 파라미터 문서](../docs/MODEL-PARAMETERS.md)에 있어요. [계획](PROVIDER-PARAMETERS-PLAN.md)의 Vercel 전용 routing/native option 매핑은 후속 범위이며 기존 호환 어댑터 계약을 유지해요.

## 검증

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| 타입·빌드 | PASS | `npm run check`, `npm run build` |
| 전체 단위·통합 | 1,027 PASS · 1 opt-in skip | [Vitest JSON](../output/provider-parameters/vitest-verified.json) |
| 공급자 관리·등록 보조 브라우저 | 15/15 PASS | [summary](../output/playwright/provider-management-2026-09-07T14-14-37-912Z-16aef76e/summary.json) |
| 평가 도구 화면 | 2/2 PASS | [summary](../output/playwright/evaluation-ui-2026-09-07T14-14-39-548Z-0c4eb3ea/summary.json) |
| 전체 브라우저 회귀 | 실행 중 | 완료 후 기록 |
| 모바일 캐시 제어 시각 검사 | 실행 중 | 완료 후 기록 |

단위 skip은 `installed Codex initializes with isolated empty authentication`의 명시 opt-in 사전 검사예요. 실제 계정/모델 실행 검증을 뜻하지 않아요. 브라우저 검사는 독립 DB·포트·임시 디렉터리와 합성 provider를 사용했고, 완료한 두 실행의 cleanup·source/build 일치가 PASS예요.

최종 브라우저 source/build는 `fd7255ea9effee6e7f848ca1c1dac158b9fcd54f994a54f1194f0c76cf00d898`, dist는 `704960bb4844a3d802bae990998799db26efaae6da8a69bf112ffd5a990c5408`예요. 전체 단위 검사 시작 당시 source는 `21d5a1c03278c0a1a1030e50048ec3426ae174b81ec8de43c9676b3439d0a401`이며 이후에는 브라우저 검사 두 파일의 선택자/DOM 속성 판정만 수정했어요. 제품 코드와 dist는 같아요.

## 발견·수정과 첫 실패 보존

1. 최초 통합 실행은 구형 connection tier·Gemini 기본 thinking·명세 revision fixture 때문에 **974 PASS·21 FAIL·1 skip**이었어요. 현재 계약으로 fixture를 갱신하고 미지원값 거절 반례를 유지했어요. [첫 통합 결과](../output/provider-parameters/vitest-integration.json)
2. 최종 읽기 검토에서 Codex `thread/start`를 기다리는 동안 모델 수정/비활성 또는 세션 해제가 일어나도 `turn/start`가 시작되는 경합을 발견했어요. 실제 실행 직전 동기 `beforeTurn` 검사에 모델/세션 권한을 연결했으며 durable `sent`는 기존 위치에서 한 번만 기록해요. 수정 전 세 조건에서 turn 1회를 재현했고, 수정 후 0회 차단과 정상 조건 1회를 확인했어요.
3. Claude의 지정 정지 문자열 종료가 기존 decoder에서 항상 partial이었어요. 요청에 고정한 `stopSequences`와 응답 `stop_sequence`가 일치할 때만 completed로 바꿨어요. 미지정·불일치·빈 응답·잘림은 기존 실패 계약을 유지해요. 최초 신규 loopback fixture는 endpoint 설정으로 **158 PASS·2 FAIL**이었고 원본을 보존한 뒤 실제 endpoint 검증을 유지하는 전달 fixture로 수정했어요. [최초 fixture 결과](../output/provider-parameters/vitest-anthropic-stop-sequences.json), [관련 160/160 PASS](../output/provider-parameters/vitest-anthropic-stop-sequences-final.json)
4. 첫 공급자 브라우저는 `<option disabled>`에 일반 control용 disabled 판정을 사용한 1건이 실패했어요. 실제 DOM에는 disabled가 있었으므로 DOM property로 검사하도록 수정했어요. 첫 평가 브라우저는 옛 메뉴/레이블을 찾다가 1건 timeout이 났고 생성 설정의 새 위치로 갱신했어요. 제품 코드는 바꾸지 않았고 두 실행 모두 cleanup을 마쳤어요. [공급자 첫 FAIL](../output/playwright/provider-management-2026-09-07T14-12-55-319Z-8a41ef49/summary.json), [평가 첫 FAIL](../output/playwright/evaluation-ui-2026-09-07T14-12-58-340Z-36aa0bb9/summary.json)

## 한계와 병행 작업

실제 API 수락·계정별 모델 가용성·Flex 대기·캐시 hit·청구액·Codex 구독 실행·물리 휴대폰/IME·배포는 검증하지 않았어요. 응답 테스트 기능을 눌렀을 때 실제 요청을 보내도록 구현한 것이며, 개발 중에는 합성 요청만 실행했어요. Gemini 암묵적 캐시의 프로젝트 제어와 `cachedContents` 수명 관리는 이번 범위에 없어요.

별도 `codex/shared-package-authoring` 작업과 공유 파일의 책임을 조율했어요. 통합 시 `core/product.ts`의 모델/연결 필드, `server/product-store.ts`의 모델/연결/archive 검증, `server/app.ts`의 hook/route, `server/product-auxiliary.ts`의 generation 추출, `server/store.ts`의 v9와 진단 테이블을 함께 보존해야 해요. 그 작업의 패키지 이미지·start·모듈 변경을 이 결과에 합산하지 않아요. 이 브랜치의 commit·merge·push는 수행하지 않았어요.
