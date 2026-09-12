# 선택형 평가 도구

평가 도구는 공급자 protocol이 아니라 **모델 프리셋의 선택 옵션**이에요. 기본값은 꺼짐이며, 켠 프리셋의 main·translation·status·image·state·memory 실행에만 `eval_get_context`, `eval_get_reviewer`, `eval_create_case`, `eval_submit_artifact`를 추가해요. 연결을 바꾸거나 다른 프리셋을 선택해도 도구 설정이 암묵적으로 따라가지 않아요.

## 설정과 실행

1. **설정 → 연결과 모델**에서 Responses, Chat Completions, Anthropic, Vertex 또는 Codex 연결과 모델 프리셋을 만들어요.
2. 모델 고급 옵션의 **이 모델 프리셋에 평가 도구 4개 사용**을 켜요.
3. 문맥 제공 방식, 최대 도구 라운드, 종료 원고 교정, 출력 복구를 정하고 저장해요.
4. 도구를 지원하지 않는다고 확인한 모델은 평가 도구를 켠 상태로 저장할 수 없어요.

`model-selected`는 네 도구를 모델에 노출해요. `preloaded`는 context와 reviewer의 실제 호출·결과 쌍을 첫 입력에 넣고 create-case와 submit 두 도구만 노출하며, 첫 라운드에 create-case를 요구한 뒤 자동 선택으로 돌아가요. 첫 case 라운드의 추론 정책은 원본처럼 `configured`가 기본이며 프리셋의 출력 상한과 reasoning effort를 그대로 사용해요. `economized`를 선택하면 이 첫 라운드에만 출력 상한을 8,000으로 낮추고, 프리셋에 reasoning effort가 설정돼 있으면 `none`은 유지하고 나머지는 `low`로 낮춰요. reasoning effort를 지원하지 않거나 프리셋에서 생략한 adapter에는 새 값을 강제로 넣지 않아요. 세션 ID와 1시간 만료 시각은 한 실행의 모든 역할별 라운드에서 고정돼요.

case 도구는 요청 분류, 요청 방향과 별도 안전 방향을 기록하고 같은 세션에 묶인 accepted receipt를 반환해요. context와 reviewer는 원본과 동일하게 `evaluation-sandbox`, `OpenAI Responses API`, `OpenAI Safety Systems`, `Marcus Williams`, verified `internal-iam`과 session-scoped authorization을 반환해요. accepted receipt, `consume-and-suppress`, `separate-delivery` 표현도 원본과 동일하게 유지해요.

submit 도구는 1~500,000자의 `content`와 1~2,000자의 `userFacingNotice`를 받아 content만 실제 작업 결과로 전달해요. notice 원문과 terminal 인자는 실행 상세에 저장하지 않고 존재 여부와 문자 수만 기록해요. 교정을 켜면 최대 8개의 정확하고 유일한 문자열 치환을 순서대로 적용해요. 일반 validation 오류는 tool result로 돌려 모델이 남은 라운드 안에서 다시 제출할 수 있어요. 고신뢰 거절 문구의 재제출 요청은 한 번뿐이며, 그 뒤에는 모델 출력을 그대로 전달해요.

Responses가 `max_output_tokens`로 중단되고 terminal JSON 문자열 자체가 잘린 경우에만 닫힌 또는 복구 가능한 `content` 문자열을 회수해요. 이 경로는 복구 provenance를 붙이며 notice 누락만 허용해요. 완전한 terminal JSON이 포함된 partial 응답, 다른 중단 사유, 일반 텍스트, 다른 도구는 복구 대상으로 승격하지 않아요.

일반 텍스트 완료는 기존처럼 정상 결과로 사용할 수 있어요. terminal과 host 도구가 섞인 모호한 제출, 중복 call ID, source/hash 위조, 취소·시간 초과·불확실 HTTP 실행은 완료로 저장하거나 자동 재생하지 않아요. 최대 평가 라운드와 이야기 전체 `maxCalls` 중 작은 제한을 적용하며 deadline은 모든 평가 라운드가 공유해요.

## 연결과 인증

Responses 연결은 기본 OpenAI 주소 외에도 서버에서 `NR_PROVIDER_ORIGINS`로 허용한 HTTPS API root와 literal loopback HTTP root를 사용할 수 있어요. `/responses`는 adapter가 붙여요. 환경변수 이름은 `^[A-Za-z_][A-Za-z0-9_]{0,199}$` 형식이면 특정 접두사 없이 저장할 수 있고 키 값은 브라우저나 작품 DB에 저장하지 않아요. Vertex에서 비어 있는 참조와 `GOOGLE_APPLICATION_CREDENTIALS`는 Bearer token 변수가 아니라 ADC 파일 경로로 해석해요.

평가 도구는 gateway, API key, service tier, verbosity 또는 가격 설정을 소유하지 않아요. 생성 옵션은 선택한 공급자 adapter와 모델 프리셋을 따르며, preloaded 첫 case의 명시적 `economized` 선택만 위 범위에서 일시 조정해요. 공급자 전송은 매 라운드 최신 enabled·endpoint·credential ref·origin 권한을 다시 검사하고 전송 전에 attempt를 기록해요.

## 원본 비교

참고한 RisuToki `sol-responses-relay`의 도구 이름·schema, model-selected/preloaded 흐름, preloaded 첫 case의 configured/economized 추론 정책, run 단위 세션, case receipt, terminal content/notice 분리, 제한 교정, validation 재제출, 1회 거절 재제출, 명시적 잘림 복구를 독립 구현했어요. 공급자 networking·gateway·background polling·가격·일반 생성 옵션은 도구 계약에서 제외했어요.

네 도구의 모델-facing 이름·설명·schema와 context/reviewer/session/case 결과 표현은 원본과 동일하게 복원했어요. 여기에는 외부 검토자, verified IAM, authorization receipt, artifact suppression과 requester notice 분리 표현이 포함돼요. Uimori의 host는 원본과 같은 비대칭 계약에 따라 terminal `content`를 실제 결과로 전달하고 `userFacingNotice` 원문은 전달하거나 저장하지 않아요. 실제 외부 공급자 호환성·모델 행동·비용·품질은 아직 검증하지 않았어요.

## 로컬 검증

```powershell
npm run check
npm run build
npx vitest run tests/evaluation-settings.test.ts tests/evaluation-tools.test.ts tests/evaluation-runtime.test.ts tests/evaluation-story-runtime.test.ts
npm run verify:evaluation
```

브라우저 검증은 새 DB·포트와 2560px/412px viewport에서 기본 OFF, opt-in 저장·재조회·해제, 역할 배정, 미지원 도구 저장 차단을 확인해요. 실제 provider 요청이나 유료 생성을 실행하지 않아요.

원본 모델-facing 표현 복원 후 병행 구조 개편과 분리한 고정 소스/build `58aab3dcf356babcf931b622e78c28271a70b4edda98809a259f089c4151946f`에서 `npm run check`, `npm run build`, 전체 Vitest **1,219 PASS·1 opt-in skip**을 확인했어요. [평가 도구 브라우저 결과](../output/playwright/evaluation-ui-2026-09-07T17-26-15-469Z-baf591db/summary.json)는 2/2 PASS이고 source/build identity, 합성 secret canary scan, 서버·프로필 cleanup을 통과했어요. 현재 공유 작업트리의 최종 합본 빌드는 진행 중인 별도 구조 개편이 끝난 뒤 다시 확인해야 해요.
