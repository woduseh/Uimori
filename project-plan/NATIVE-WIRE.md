# 네이티브 요청과 제출 계약

> 역사적 기록: 아래는 2026-09-07 native 통합 당시의 요청·provider 지원과 검증 기록이에요. 이후 전용 native/hidden 실행기와 Sol provider를 제거했으므로 `native.host-context`, hidden seed, non-Sol 분기, v8 및 당시 테스트 경로는 현행 사용 안내가 아니에요. 현재 실행 계약은 [프롬프트 실행](../docs/PROMPT-RUNTIME.md), [원문 구간](../docs/SOURCE-SEGMENTS.md), [공급자와 모델 설정](../docs/MODEL-PARAMETERS.md), [선택형 평가 도구](EVALUATION-TOOLS.md)를 확인해요. 현재 저장 형식과 검증 상태는 [CURRENT](CURRENT.md)를 따라요.

2026-09-07의 `server/main-request.ts`는 실제 메인 실행과 무호출 미리보기의 ProviderRequest 구성을 공유해요. 미리보기의 `exact-request-body`는 그 미리보기 스냅샷에 대한 해당 프로토콜의 실제 인코더 본문이며, 인증 헤더·fetch·attempt 기록·과금은 없어요. 이후 실제 Run은 실행 ID와 hidden 선택 seed, 최신 자료·설정이 달라질 수 있으므로 미래 요청과 byte 동일하다는 의미는 아니에요. 번역/상태 대기 중의 `mapping-only`는 역할 변환만 보여주며 실제 보호 구간·도구·schema를 포함한 실행 본문이라는 주장을 하지 않아요.

정적 host 권한 문구와 동적 자료를 구분해요. `native.host-context` user 메시지는 첫 history/current 직전에 들어가며 저장된 compilation에도 나타나요. 사용자 블록의 role/순서와 cache message ID는 유지해요. 구조화된 메인 프리셋의 memory는 선택한 memory 슬롯에만 들어가요. state 슬롯을 선언하면 state도 그 슬롯에만 들어가고, 구조화된 프리셋의 pinned 본문은 description/persona/lore 등의 슬롯이 소유해요. 원문 이력과 현재 요청을 host JSON으로 다시 보내지 않아요. 도구 결과는 후속 요청의 provider-native tool result로만 이어져요.

동적 메시지 앞에 있는 cache anchor는 per-turn parent/state JSON 때문에 prefix가 먼저 바뀌지 않아요. anchor 뒤의 user/system 배치를 공급자가 지원하지 않으면 기존 capability 검사로 거부해요. 특히 Vertex의 연속 같은 role은 검증 범위 밖이라 명시적으로 거부하며 이를 임의 병합하지 않아요. 자료/모델/도구/정적 설정이 달라지면 prefix도 달라질 수 있고, 이 구현은 실제 cache hit·최소 token 조건·계정 접근권한을 입증하지 않아요.

OpenAI 공식 [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching#how-caching-works)은 GPT-5.6 이후의 명시적 breakpoint와 요청당 최대 4개 쓰기를 설명해요. [현재 모델 목록](https://developers.openai.com/api/docs/models)에서 확인한 이름을 바탕으로 공식 Responses 경로만 `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`를 exact match해요. 임의 future/datetime suffix와 Sol·Chat 호환 경로에 이 capability를 추정하지 않아요.

Claude 공식 [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)는 Fable 5.1/Mythos 5.1/Fable 5/Mythos 5/Opus 4.8/Opus 5를 열거하고, user 뒤에서 assistant 앞 또는 배열 끝이라는 배치 제약을 설명해요. 구현도 여섯 공식 API alias만 exact match하며 새 모델로 자동 확장하지 않아요. 본문 없는 effort 변경·clear_at·tool 변경 beta는 구현하지 않아요.

Phēmē tool-call variant의 Fiction 모드에는 non-Sol 메인 실행에서만 `story.submit({content})`을 최종 제출 경계로 등록해요. 한 번의 sole call, 비어 있지 않은 500,000자 이하 본문, 추가 인자 없음이 필요해요. mixed call/외부 source identity/잘못된 본문은 원고를 만들지 않아요. host가 chat·parent·profile·preset 귀속을 기록하고 기존 원자적 완료 경로가 source를 저장해요. OOC/normal 프리셋에는 이 도구를 노출하지 않으며 일반 text 완료 fallback은 유지해요. Sol은 기존 `eval_submit_artifact` 경계를 사용해요.

검증은 `tests/native-main-request.test.ts`의 합성 무호출 인코딩 및 로컬 Chat 호환 loopback 시험이에요. 실제 외부 요청·모델 품질·가격·cache hit 시험은 하지 않았어요. 미출시 native 중간 빌드 snapshot은 버전 호환 계약이 아니에요. 현재 DB·archive는 v8만 사용하며, 구버전 DB 이관·archive 복원 호환은 제공하지 않아요. 새 Risu 자료 이식은 [공통 이식 가이드](../docs/RISU-PORTING.md)를 따르고 현재 검증 상태는 [CURRENT](CURRENT.md)를 확인해요.
