# 모델 요금과 추정 비용

모델 편집의 **고급 → 요금과 추정 비용**에서 공식 요금을 사용하거나 직접 입력해요. 단위는 **USD / 100만 토큰**이며 입력·캐시 읽기·캐시 쓰기·출력을 구분해요. 1시간 캐시 쓰기는 별도로 입력할 수 있어요. 빈칸은 미확인이고 무료인 항목만 0으로 설정해요. 직접 입력의 Flex 단가는 별도로 저장하며 일괄 반값으로 가정하지 않아요.

화면에는 **“참고용 추정 금액이며 실제 청구액과 다를 수 있어요”**를 표시해요. 이번 계산은 호출 후 공급자가 보고한 토큰 사용량에 단가를 적용해요. 로컬 토크나이저의 입력 길이 추정은 컨텍스트 계획에만 사용하며 이 비용에 섞지 않아요. 세금·개별 계약·크레딧·환율·검색/도구·저장시간 등 토큰 외 요금과 라우팅 차이 때문에 청구액과 다를 수 있어요.

## 자동 요금의 범위

`core/model-pricing.ts`가 2026-09-09 확인한 공식 단가를 제공해요. 프로토콜만 보지 않고 정확한 공급자 endpoint·모델 ID·서비스 등급을 확인해요. 미등록 모델도 실행할 수 있지만 자동 요금이 없으면 직접 입력해야 해요. 커스텀 gateway에 직접 공급자 단가를 자동 적용하지 않아요.

| 공급자 | 자동 기준 |
| --- | --- |
| OpenAI 직접 API | GPT-6 Astra, GPT-5.6 Sol·Terra·Luna와 Sol alias. Standard/Flex/Fast와 272K 초과 장문 단가 |
| Anthropic 직접 API | Claude Fable 5.1·Opus 5, 캐시 읽기와 5분/1시간 쓰기 |
| Google Agent Platform global | Gemini 3.1 Pro Preview·3.5 Flash-Lite·3.8 Flash, Standard/Flex·200K 장문 구간과 명시된 프로모션 기간 |
| DeepSeek 직접 API | V4 Pro·Flash, 호출 시작 시각의 UTC 평일 혼잡 시간대 |
| Vercel AI Gateway | 사용자가 갱신한 모델 목록의 `pricing`을 USD/100만 토큰으로 변환. 단가·두 단계 문맥 구간·명시된 서비스 등급을 보존하며 중복 할인하지 않음 |
| Codex 구독·합성 fixture | API USD 단가 자동 적용 없음. 토큰 비용 추정 미지원 |

공식 출처: [OpenAI 가격](https://developers.openai.com/api/docs/pricing), [OpenAI Flex](https://developers.openai.com/api/docs/guides/flex-processing), [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Google Cloud 가격](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), [Google Flex 적용 확인](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo), [DeepSeek 가격](https://api-docs.deepseek.com/quick_start/pricing/), [Vercel 모델 목록 API](https://vercel.com/docs/ai-gateway/models-and-providers).

Vercel의 2026-09-09 공개 GET 목록에서 Sol·Grok의 snake_case 단가·문맥 구간과 서비스 tier를 확인했어요. 자동 라우팅의 실제 공급자에 따라 단가가 달라질 수 있어요. 복잡하거나 잘못된 단가 구조는 가격만 미확인으로 남기고 모델 목록은 유지해요. Google 캐시 저장시간 요금과 프로모션 크레딧 환급은 토큰 금액에서 자동 차감하지 않아요. 공식 표는 앱에 포함된 확인 시점의 참고값이며 매 호출 인터넷에서 갱신하지 않아요.

## 실행·저장 계약

- 모델의 `pricing` 설정은 일반 revision CAS로 저장해요. 새 작업을 예약할 때 `ModelSnapshot.pricingSnapshot`에 단가·출처·확인일·문맥 구간 등을 고정해요. 이후 현재 모델의 가격을 수정해도 과거 실행을 재가격하지 않아요.
- 요청의 가격 정보는 host metadata예요. 공급자 HTTP/RPC 본문에 전송하지 않아요. 전송 직전 attempt에 가격과 시작 시각을 기록하며 서버가 강제한 Vertex Flex도 예약 당시 보존한 Flex 단가를 사용해요.
- 완료 시 `response.estimatedCost`에 계산 결과·항목별 토큰/단가/금액을 기록해요. 기존 `cost_usd`는 공급자가 보고한 실제 비용 전용이고 `null`을 추정 금액이나 0으로 바꾸지 않아요. schema·운영 DB 이관은 필요 없어요.
- 공급자별 입력/캐시 합산 의미를 구분해 중복 계산하지 않아요. Anthropic normalized 입력은 이미 캐시를 포함하며 원 usage의 입력·캐시 분할을 사용해요. 출력에 포함된 reasoning/thinking을 다시 더하지 않아요.
- 사용량이나 단가가 없으면 전체 추정 금액은 미확인이에요. 확인된 항목은 부분합으로 보여요. 실제 서비스 tier가 고정 가격과 다르면 금액을 추정하지 않아요. 기존 미확인 호출은 최신 요금으로 소급 계산하지 않아요.
- 본문에는 작문과 작문 보조의 추정 비용을 표시해요. 번역·제목 등 후속 작업은 작업 현황에서 별도로 확인해요. 상세에는 공급자 보고 비용과 추정 비용을 분리해 표시해요.
- JSON 보관은 가격 snapshot과 추정 결과를 보존하며 형식·모델 귀속·계산 일치를 검증해요. 가격은 실행 허가나 누적 금액 차단 조건이 아니에요. 취소·중복·불확실 실행·원문 귀속 계약은 유지해요.

검증은 `tests/model-pricing.test.ts`, `tests/pricing-estimate.test.ts`, `tests/pricing-store.test.ts`, `tests/pricing-transport.test.ts`, `tests/model-pricing-browser.spec.ts`에서 수행해요. 합성 검사는 실제 공급자 청구액 일치나 실제 휴대폰 검증을 의미하지 않아요.
