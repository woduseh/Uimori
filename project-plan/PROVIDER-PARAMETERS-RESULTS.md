# 공급자 설정·컨텍스트·공통 자료 통합 결과

2026-09-08. 공급자 작업 `63b7247`과 공통 자료·로어 작업 `6303545`를 main에 통합했어요. 기준 commit은 `5761bb2`이고 두 작업의 모델 설정, 이미지·시작문, 로어 유지와 자동 대화 요약을 함께 검증해요. 최종 합본 검증과 근거는 아래에 기록해요.

모델·연결은 `provider_settings`의 최신 한 벌로 편집하고 실행마다 모델·연결 snapshot을 고정해요. 입력 한도 기본값은 272,000이며 실제 요청 body를 로컬에서 추정해 앞선 대화를 요약·재사용해요. 상태·기억 보조 작업에도 같은 압축 엔진을 적용해요. 출력 한도 확대 요청은 철회되어 변경하지 않았어요. [모델 설정](../docs/MODEL-PARAMETERS.md) · [입력 컨텍스트](../docs/CONTEXT-LIMITS.md)

## 구현

- **모델별 설정**: Google Agent Platform 카드에서 모델명 접미사를 제거하고 global endpoint를 유지해요. 모델 프리셋에 Thinking Level, Reasoning Effort/Verbosity/Mode/Context, Claude Output Effort/Thinking, Service Tier를 저장해요. Flex는 Google과 등록된 GPT Responses/Chat에서 선택해요.
- **공통 검증**: `core/model-capabilities.ts`의 정확한 모델 ID·허용값·조합·명세 revision을 UI, 저장/등록 보조/archive, 실행에서 공유해요. 미지정 필드는 생략하고 `none`·`disabled`는 유지해요. 미지원값은 초안에 표시하며 자동 하향·모델 치환·Flex fallback을 하지 않아요.
- **모든 역할에 전달**: 공통 generation 추출기를 main/translation/status/image/state/memory/등록 보조에 적용해요. 저장한 모델·옵션·capability revision을 snapshot에 고정하며 평가 도구의 명시적인 절약 조정 외에는 binding을 바꾸지 않아요.
- **캐시**: Claude와 지원 GPT Responses에서 OFF, 작성 기준점, 자동 캐싱+기준점, 확인된 TTL을 제공해요. 기존 프롬프트 기준점과 continuation의 reasoning·서명·도구 ID를 보존해요. Inspector는 공급자가 반환한 캐시 읽기/쓰기 토큰을 표시하고 누락은 미확인으로 남겨요.
- **응답 테스트**: 저장한 모델에서 `API 연결 테스트 중이니 OK만 답해주세요.`를 출력 256토큰·25초·최저 effort·도구 없음으로 한 번 보내요. 선택한 Service Tier는 유지해요. 모델 revision·세션·현재 연결 권한을 확인하고, durable 전송 기록·동시 실행 제한·idempotency·재시작 중단 처리를 적용해요. 작품 본문은 보내지 않아요.
- **ProviderBudget 제거**: 누적 호출/추정 금액 제한·단가·예약 메타데이터·환경변수 의존성을 제거했어요. 작업별 출력/시간/호출 한도, 전송 전 기록, 취소·중복 방지, usage와 `costUsd=null`은 유지해요.
- **schema/archive v9**: 구형 연결 `requestTier` 등을 받지 않아요. 새 `provider_connection_tests` 진단은 작품 JSON archive에서 제외하고 SQLite backup에는 포함해요. 구버전 이관·호환 UI·자동 백업은 추가하지 않았고 사용자 DB도 초기화하지 않았어요.

정확한 지원 ID, API 매핑, 캐시 한계와 사용 절차는 [모델 파라미터 문서](../docs/MODEL-PARAMETERS.md)에 있어요. [계획](PROVIDER-PARAMETERS-PLAN.md)의 Vercel 전용 routing/native option 매핑은 후속 범위이며 기존 호환 어댑터 계약을 유지해요.

## 합본 통합

공통 자료의 옵션·지침·이미지·공유 모듈·작성된 시작문과 로어 배경/장면 배치를 함께 반영했어요. 최신 모델 ID 선택과 응답 유실 시 동일 생성 요청 재확인을 유지해요. [자료 작업](SHARED-PACKAGE-RESULTS.md) · [로어 작업](LORE-CONTEXT-RESULTS.md)

자동 요약은 로어 본문을 섞지 않은 실제 대화만 처리해요. authored 시작문은 검증된 출처 표식으로 assistant 단독을 허용하고 일반 대화의 user 누락은 거절해요. 고정 입력만으로 한도에 가까워지면 조회 자료를 LRU 순서로 통째 정리하고, 이후 Run과 독립 포크·보관에서 제외 항목을 부활시키지 않아요. 요약에 따라 원래 위치가 빠진 참고 자료는 요약 뒤·최근 대화 앞에 제공해요.

## 검증

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| 타입·빌드 | PASS | `npm run check`, `npm run build` |
| 전체 단위·통합 | **1,175 PASS · 0 FAIL · 1 opt-in skip** | [Vitest](../output/provider-parameters/vitest-merged-final.json) |
| 전체 브라우저 | **79/79 PASS** | [브라우저 summary](../output/playwright/redesign-2026-09-07T15-40-44-406Z-6eb46595/summary.json) |
| source/build 일치·cleanup | PASS | 같은 브라우저 summary · 남은 PID 0 |
| 390px 시각 확인 | PASS | [최종 증거](../output/provider-parameters/FINAL-VERIFICATION.json)의 PNG 목록 |

최종 source/build는 `1e5cce2af3ed71c8448378df20392fd779614d759b09f7550d7f2cab0e4b13de`, dist는 `273a849c0af88fb52ff8e258e137333be4540673b50a1f285a41062d85e00fc7`예요. 단위 검사는 `eb2bb117e0265c7b8bc9dc49f226e9af1a951b9e4aca70220a19b0b0b0956578`에서 완료했고, 이후 제품 변경은 SourceReader의 안내 위치 한 곳뿐이에요. 이 화면 변경과 브라우저 fixture 수정 뒤 타입·빌드·전체 브라우저를 다시 통과했어요. 단위 skip은 설치된 Codex의 빈 인증 프로필 사전 검사를 명시 실행할 때만 켜는 항목이에요.

공급자 단독 최종 검사는 1,094 PASS·1 skip(`vitest-before-merge-final.json`)이었어요. 합본 최초 검사는 1,173 PASS·1 FAIL·1 skip(`vitest-merged-first.json`)이며 새 로어 테스트의 복원 연결 조회 fixture 오류를 수정했어요. 실패 기록은 그대로 보존해요. 최종 근거 파일은 모두 `output/provider-parameters/`에 있어요.

## 발견·수정과 첫 실패 보존

1. 최초 통합 실행은 구형 connection tier·Gemini 기본 thinking·명세 revision fixture 때문에 **974 PASS·21 FAIL·1 skip**이었어요. 현재 계약으로 fixture를 갱신하고 미지원값 거절 반례를 유지했어요. [첫 통합 결과](../output/provider-parameters/vitest-integration.json)
2. 최종 읽기 검토에서 Codex `thread/start`를 기다리는 동안 모델 수정/비활성 또는 세션 해제가 일어나도 `turn/start`가 시작되는 경합을 발견했어요. 실제 실행 직전 동기 `beforeTurn` 검사에 모델/세션 권한을 연결했으며 durable `sent`는 기존 위치에서 한 번만 기록해요. 수정 전 세 조건에서 turn 1회를 재현했고, 수정 후 0회 차단과 정상 조건 1회를 확인했어요.
3. Claude의 지정 정지 문자열 종료가 기존 decoder에서 항상 partial이었어요. 요청에 고정한 `stopSequences`와 응답 `stop_sequence`가 일치할 때만 completed로 바꿨어요. 미지정·불일치·빈 응답·잘림은 기존 실패 계약을 유지해요. 최초 신규 loopback fixture는 endpoint 설정으로 **158 PASS·2 FAIL**이었고 원본을 보존한 뒤 실제 endpoint 검증을 유지하는 전달 fixture로 수정했어요. [최초 fixture 결과](../output/provider-parameters/vitest-anthropic-stop-sequences.json), [관련 160/160 PASS](../output/provider-parameters/vitest-anthropic-stop-sequences-final.json)
4. 첫 공급자 브라우저는 `<option disabled>`에 일반 control용 disabled 판정을 사용한 1건이 실패했어요. 실제 DOM에는 disabled가 있었으므로 DOM property로 검사하도록 수정했어요. 첫 평가 브라우저는 옛 메뉴/레이블을 찾다가 1건 timeout이 났고 생성 설정의 새 위치로 갱신했어요. 제품 코드는 바꾸지 않았고 두 실행 모두 cleanup을 마쳤어요. [공급자 첫 FAIL](../output/playwright/provider-management-2026-09-07T14-12-55-319Z-8a41ef49/summary.json), [평가 첫 FAIL](../output/playwright/evaluation-ui-2026-09-07T14-12-58-340Z-36aa0bb9/summary.json)

5. 최신 설정 후속의 첫 전체 검사는 **1,035 PASS·30 FAIL·1 skip**이었어요(`vitest-context-integration-first.json`). 구형 설정 fixture를 갱신하면서 번역 `claimJob`이 선택 모델 snapshot을 유실하는 결함을 고쳤고, claim 전 준비 실패는 queued 상태에서 반복되지 않고 명시 실패로 끝내도록 했어요. 중단·원본 SQLite는 `current-settings-selected-cancelled/`, `current-settings-selected-retry-stall/`에 보존했어요. 반복 문자열의 tokenizer 지연은 별도 재현 후 4,096 UTF-16 조각의 WASM 추정으로 수정했어요. 중단된 실행에 임의의 PASS/FAIL 개수를 부여하지 않았어요.

최초 합본 브라우저는 **78 PASS·1 FAIL**이었어요. PMUI07은 카탈로그 POST만 합성하고 새로 조회한 library에는 빈 목록을 반환한 fixture 때문에 실패했어요. 실제 저장 경로와 같은 조회 결과가 이어지도록 합성 응답을 맞췄어요. 자동 검사는 통과했던 컨텍스트 상태 화면도 PNG에서 직접 확인해 번역 버튼과의 겹침을 발견했고, 안내를 도구 모음 뒤로 옮기고 영역 비겹침 검사를 추가했어요. [최초 합본 브라우저와 cleanup](../output/playwright/redesign-2026-09-07T15-34-47-580Z-c326c678/summary.json)은 그대로 보존해요.

## 검증 한계

실제 API 수락·계정별 모델 가용성·Flex 대기·캐시 hit·청구액·실모델 요약 품질·Codex 구독 실행·물리 휴대폰/IME·배포는 검증하지 않았어요. 응답 테스트 기능은 사용자가 실행하면 짧은 실제 요청을 보내며 개발 중에는 합성 요청만 실행했어요. Gemini 암묵적 캐시의 프로젝트 제어와 `cachedContents` 수명 관리는 이번 범위에 없어요. 현재 schema/archive는 v9이며 기존 사용자 DB를 초기화하거나 이관하지 않았어요.
