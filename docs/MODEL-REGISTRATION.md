# 모델 등록 결정 · 실행 게이트 대신 공급자 판정

[연결 계약](PROVIDERS.md) · [모델 옵션·응답 테스트](MODEL-PARAMETERS.md) · [현재 상태](../project-plan/CURRENT.md)

2026-09-09에 정한 결정과 그 근거, 버린 대안을 기록하는 문서예요. 현재 계약은 연결 계약과 모델 옵션 문서가 우선하고, 이 문서는 "왜 이렇게 했는가"를 남겨요.

## 결론

- **모델 ID는 실행 조건이 아니에요.** `core/model-capabilities.ts`의 표는 알려진 모델의 옵션 목록과 한도를 UI에 먼저 보여주는 힌트예요. 표에 없는 ID와 값도 그대로 공급자에 보내요.
- **저장 검증은 프로토콜 단위예요.** encoder가 보낼 수 있는 옵션 키와 값 어휘만 거절해요. 모델별 지원 여부는 공급자 응답이 판정해요.
- **거절은 이름으로 보여줘요.** 4xx 응답의 `param`, `fieldViolations`, 메시지 선두 경로, 인용 식별자 중 화이트리스트 필드만 `core/provider-rejection.ts`가 앱 옵션 이름으로 바꿔 실패 턴 카드, 보조 작업 카드, 응답 테스트 결과에 표시해요. 공급자 메시지 원문은 저장하거나 보여주지 않아요.
- **응답 테스트는 프리셋 옵션을 그대로 보내요.** 출력 256토큰, 캐시 끄기, 도구 없음만 달라요. 결과가 그 프리셋에 대한 공급자 판정이 돼요.
- **에이전트 등록 보조 기능은 제거했어요.** 게이트가 없으면 모델을 쓰기 위해 거칠 이유가 없어요.
- **모델 편집은 기본과 고급 두 탭이고 노출 조절은 사고 강도 하나예요.** 프로토콜 native 필드에 저장하고 어느 요청 필드로 나가는지 표시해요. Vercel과 OpenAI 호환 연결은 `reasoning_effort`로 보내며 게이트웨이가 변환한다는 사실을 함께 표시해요.
- **판단 원칙은 "실패 비용이 없으면 막지 말고 피드백 품질을 높인다"예요.** 옵션이 맞지 않는 요청은 생성 전에 400으로 끝나 과금이 없어요.

## 배경

2026-09-08까지 공식 연결인 OpenAI 기본 주소, Anthropic, Gemini, DeepSeek에서는 표에 없는 모델 ID의 실행을 차단하고, 프리셋에 capability revision을 각인해 표가 바뀌면 재저장 전까지 실행을 막았어요. 그래서 새 모델마다 명세서를 코딩 에이전트에 넘겨 표, encoder, 문서, 테스트를 고치는 커밋이 필요했어요. 직전 커밋 `c1fc704`는 모델 5개 추가에 26파일 454줄이었어요.

이 게이트는 호환 연결인 Vercel과 사용자 지정 주소에는 없었어요. 파라미터를 가장 확실하게 거절하는 공식 API 쪽만 막는 불일치였고, 응답 테스트 버튼도 같은 게이트에 막혀 확인 도구가 확인을 못 했어요.

각 랩의 모델 목록 API가 주는 정보는 2026-09-09에 공식 문서로 확인했어요.

| 출처 | 토큰 한도 | 파라미터 지원 정보 |
| --- | --- | --- |
| OpenAI `/v1/models` | 없음 | 없음. id, created, owned_by, shutdown_date |
| Anthropic `/v1/models` | max_input_tokens, max_tokens | `capabilities.effort` 레벨별 지원, `thinking.types`, `structured_outputs` 등 |
| Gemini Developer API `models.list` | inputTokenLimit, outputTokenLimit | thinking 여부, temperature·topP 범위. 레벨 목록 없음 |
| Vercel `/v1/models` | context_window, max_tokens | `reasoning_options`의 effort 값과 budget 범위, `supported_parameters`, tags, 가격 |

Google Agent Platform에는 파라미터 정보를 주는 목록 API가 없어요. REST 참조 목차에는 `publishers.models`의 `get`만 보이고 `list`는 없었어요. 문서 페이지가 탐색 메뉴만 반환해 직접 대조는 못 했어요. 한도를 주는 것은 Gemini Developer API인데 API 키 인증이라 자격증명이 하나 더 필요해요. 그래서 기본은 로컬 힌트 표와 수동 ID 입력이고, 재연님 요청으로 연결에 선택 필드 `catalogCredentialEnv`를 두어 키가 있으면 Developer API 목록에서 Gemini 모델과 한도만 받아오도록 했어요. 이 키는 생성 요청에 쓰지 않아요.

## 선택하지 않은 대안

| 대안 | 버린 이유 |
| --- | --- |
| 게이트 유지, 추정 상태는 옵션 확인 요청 성공 후 해제 | 실패 비용이 없는데 사용자 클릭을 요구해요. "미확인을 확인으로 포장하지 않기" 원칙은 표시에 대한 것이고 요청을 막는 근거가 아니에요 |
| ID 패턴의 패밀리 규칙으로 capability 자동 상속 | 게이트가 없으면 필요성이 작아요. 힌트는 공급자 목록과 표로 충분해요 |
| 등록 보조 에이전트를 capability 초안 생성기로 재정의 | 게이트 제거로 존재 이유가 사라져요. 저장소, 라우트, UI, 테스트 한 벌을 삭제했어요 |
| 사고 강도를 통일 5단계로 두고 공급자별로 교차 변환 | "옵션을 조용히 바꾸지 않는다" 원칙과 충돌해요. 라벨만 통일하고 값은 native 그대로 저장해요 |
| Vertex publisher-model 목록 조회 추가 | 파라미터 정보가 없고 게이트가 없으면 이득이 작아요 |
| Gemini Developer API 목록을 필수로 사용 | API 키를 따로 요구해요. 기본값으로는 강제하지 않고, 키 환경변수 이름을 넣은 연결에서만 선택적으로 써요 |
| 공급자 오류 메시지 원문 노출 | 기존 비노출 정책을 유지해요. 메시지에서는 선두 `path:`와 인용 식별자만 화이트리스트 대조 후 필드 이름으로 채택해요 |
| 응답 테스트를 최저 effort로 유지 | 프리셋 옵션에 대한 판정을 얻을 수 없어요. 출력 상한 256토큰으로 비용은 그대로 묶여 있어요 |

## 결과

- 삭제: `server/provider-registration-*.ts`, `core/provider-registration.ts`, `web/ProviderRegistrationAssistant.tsx`, 관련 테스트 4개, `registration-run` archive 검증.
- 추가: `core/provider-rejection.ts`는 필드에서 옵션으로 매핑, `core/model-hints.ts`는 목록·표·어휘 병합, `core/provider-catalog.ts`는 Anthropic·Vercel 목록 메타데이터 파싱, `web/provider-rejection.tsx`는 거절 안내 표시예요.
- `Connection.catalog[]`에 `limits`와 `options` 선택 필드가 생겼고, 목록에서 모델을 고르면 한도를 미리 채워요. Gemini 연결의 `catalogCredentialEnv`는 Developer API 목록 조회 전용 키 참조예요.
- state·memory 작업도 실패 원인이 4xx면 같은 거절 안내를 작업 카드에 표시해요.
- 검증 fixture 이름은 `providerFixture`, 환경변수는 `NR_PROVIDER_FIXTURE_URL`이에요.
- Anthropic thinking `enabled`와 budget 입력은 UI에서 뺐어요. encoder가 budget을 보내지 않아 동작할 수 없는 조합이었어요.
- 명시한 캐시 모드는 표에 없는 모델에도 그대로 보내요. 미지정일 때만 공급자 기본이에요.

## 남은 항목

- 거절 필드 추출은 각 공급자의 문서상 오류 형태에 맞춘 것이고 실제 키로는 확인하지 않았어요.
- 사고 강도를 채팅 입력창에서 바로 바꾸는 계약은 별도 판단이에요.
- product-browser P04 세 case는 기존 verify 스크립트가 선택하지 않아 세션용 임시 runner로 확인했어요. 필요하면 verify 스크립트에 추가해요.
