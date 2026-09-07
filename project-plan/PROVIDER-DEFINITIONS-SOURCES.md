# 공급자 정의와 등록·검색 구조 조사

확인일: 2026-09-07. Uimori 조사 기준 commit: `51e51967503dd9de9f765c0702210a360adde674`.
작업 범위는 `codex/provider-management`의 격리 작업트리이며 원래 Uimori 작업 디렉터리와 참고 프로젝트는 수정하지 않았어요.

## 참고 자료와 확인 범위

- 참고 파일: `C:/Users/wodus/ai-workspace/RisuToki/risu/plugins/provider-manager-v1.16.2.js`
- 파일 크기: 1,016,732 bytes. SHA-256: `fd5f599bd19bfe66837ea558fc717d907c890e6f4bcb5d16207059fa7b81b7a8`
- 헤더에서 provider-manager, 표시 버전 1.16.2, Plugin API 3.0/2.1/2.0 표기를 확인했어요. 실제 호스트 호환성을 실행으로 검증한 결과는 아니에요.
- `RisuToki/AGENTS.md`, `risu/plugins/AGENTS.md`, `risu/plugins/skills/writing-plugins-v3/SKILL.md`를 읽었어요. 스킬의 sandbox·비동기 host 경계·안정적 등록 ID·권한 거절 처리 원칙을 참고했어요. 플러그인 API를 호출하는 구현은 추가하지 않으므로 추가 API 문서는 필요하지 않았어요.
- 원본은 읽기만 했으며 실행·import·eval·복제·수정하지 않았어요. minified 파일 전체를 출력하지 않고 아래 UTF-8 byte 구간과 심볼 주변만 조사했어요. byte 범위는 0-based, 끝 제외예요.
- 플러그인 디렉터리의 별도 LICENSE 파일은 찾지 못했고 저장소 루트에는 LICENSE가 있었어요. 그 라이선스가 이 제3자 산출물에 적용된다고 판단하지 않았어요. 원본 구현·UI 문구를 복사하지 않고 구조에서 배운 원리만 독립 적용했어요.

| 원본 구간·심볼 | 확인한 구조 | 배운 원리와 Uimori 적용 | 확인 한계·비채택 |
| --- | --- | --- | --- |
| bytes 12380–13430, `K` | 공급자 이름·base URL·인증 방식·목록 경로·기본 format과 지원 formats 등을 검사해요. | 공급자 정의를 연결의 실제 값과 분리해요. `core/provider-definitions.ts`에 기존 7개 adapter의 정적 설명을 두어요. | 원본의 인증·format·옵션 전체를 Uimori 지원 기능으로 간주하지 않아요. 임의 header/body 정의를 가져오지 않아요. |
| bytes 803500–804150, `hH`·`mH` | 수동 정의 registry를 열거하며 JSON 입력을 정규화하고 내장 ID 충돌을 막아요. | 안정적 protocol ID로 lookup하고 등록된 프로토콜과 정의의 1:1 관계를 테스트해요. | 동적 JSON 공급자 정의 import는 이번 범위에 추가하지 않아요. 원본 registry validator를 복사하지 않아요. |
| bytes 652350–653200, `KT`·`WT` | 모델 설정을 host 등록 metadata로 구성하고 활성화 모델만 등록해요. | 정의 정보·연결 정보·사용 모델의 역할을 분리해요. 이 파일의 정의 조회는 네트워크 호출이나 권한 부여를 하지 않아요. | 원본 model group·router·batch 등록 방식은 현재 Uimori 등록 흐름의 범위 밖이에요. |
| byte 845693 부근, provider step | 활성 공급자를 모아 선택 단계에 제공해요. | 공급자 선택은 이미 지원하는 adapter의 설명·기본값에서 시작할 수 있어요. | 이 조사 산출물은 UI 자체 구현이나 실제 화면 검증을 포함하지 않아요. |
| bytes 849000–850500, 인증 단계 분기 | 공급자 인증 유형에 따라 입력 흐름이 나뉘어요. | Uimori에서는 실제 key 대신 환경변수 참조와 기존 서버 인증 경로를 설명해요. | 원본 OAuth·Bedrock·proxy·직접 key 저장은 이식하지 않아요. |
| bytes 851500–852400, `modelSearch`; byte 25072 부근, `ie` | 모델 이름·ID·소유자 문자열로 검색하고 추천/기타 목록을 나누어요. 검색 정규화는 영문·숫자 외 문자를 제거해요. | 이름·ID를 함께 찾는 검색 구조를 UI 후속 작업의 근거로 남겨요. | 추천 우선순위·정규화 코드는 복제하지 않아요. 한글 검색어를 없애는 정규화도 채택하지 않아요. 정의 테이블에 모델 추천이나 가격을 추정해 넣지 않아요. |

## Uimori가 실제 지원하는 범위

정의의 `source.kind = adapter`는 외부 공급자의 보증이 아니라 현재 Uimori 어댑터 코드를 확인했다는 뜻이에요. 모든 정의의 모델별 `tools`, `structuredOutput`은 `null`, `price`는 `unknown`이에요. 전송 형식을 구현했다는 사실과 각 모델이 그 기능을 제공한다는 사실을 구분해요.

| Uimori 파일·심볼 | 채택하는 계약 |
| --- | --- |
| `core/product.ts`: `PROVIDER_PROTOCOLS`, `validateProviderEndpoint` | 지원 protocol 7개와 기존 endpoint 경계를 유지해요. 추가 API 프로토콜이나 자동 origin 승인은 없어요. |
| `web/ProviderSettings.tsx`: 조사 시 `labels`, `roots`, `credentials` | 기존 label·endpoint·환경변수 기본값을 보존해요. fixture·Vertex·custom의 빈 endpoint는 사용자 입력이 필요하다는 뜻이에요. |
| `server/product-store.ts`: `validateModelGeneration` | `optionKeys`는 최상위 모델 프리셋 키예요. timeoutMs는 host 실행 옵션이고 requestTier는 별도 연결 옵션이므로 목록에서 제외해요. 평가 도구는 특정 공급자 옵션이 아니라 선택한 모델 프리셋의 `evaluationTools`로 검증해요. |
| `core/vertex-protocol.ts`: `encodeVertex`; `core/vertex-auth.ts` | Vertex는 고정 지원 모델·global 프로젝트 endpoint·thinkingLevel을 유지해요. temperature는 null이며 사용자 조절 옵션으로 광고하지 않아요. 서버의 GOOGLE_APPLICATION_CREDENTIALS 파일 또는 기존 Bearer 경로를 사용해요. |
| `core/openai-protocol.ts`: `encodeResponses`; `core/openai-chat-protocol.ts`: `encodeChat`; `core/anthropic-protocol.ts`: `encodeAnthropic` | 각 encoder가 받는 생성 옵션만 정의해요. Anthropic thinking과 temperature의 상호 제약은 그대로 유지해요. |
| `core/provider-http.ts`: `executeNativeProvider`; `core/transport.ts`: `executeProvider` | Anthropic은 x-api-key, native Responses·Vercel은 Bearer예요. custom Chat과 fixture의 선택적 Bearer는 limitations에 명시해요. fixture는 자체 loopback 형식이에요. |
| `core/evaluation-tool-config.ts`; `core/evaluation-tools.ts`; `server/evaluation-session.ts` | 네 평가 도구는 공급자 정의와 분리하고, 사용자가 켠 모델 프리셋에만 추가해요. 현재 계약은 [선택형 평가 도구](EVALUATION-TOOLS.md)를 따라요. |
| `server/product-routes.ts`: `/api/connections/:id/catalog` | Vertex만 로컬 지원 목록이에요. fixture는 loopback에 한정되지만 목록은 HTTP 요청이므로 `remote`로 구분해요. 다른 정의도 실제 목록 조회 성공이나 인증 성공을 미리 주장하지 않아요. |

`optionKeys`는 기존 어댑터·저장 검증에서 받아들이는 범위를 설명해요. fixture는 전달받은 옵션을 합성 서버가 해석하므로 실제 모델의 생성 옵션 지원을 검증한 것이 아니에요. 공통 최대 토큰·temperature·timeout 설정도 모델별 실제 지원을 보증하지 않아요.

## 조사 시 로컬 파일 SHA-256

후속 병렬 구현에서 파일이 바뀔 수 있으므로 아래 값은 조사 스냅샷의 식별자예요. `core/sol-*` 두 행은 제거 전 조사 증거이며 현재 제품 파일이나 지원 protocol 목록이 아니에요.

| 파일 | SHA-256 |
| --- | --- |
| core/product.ts | d1cc589762f8f65495e1ddba39b95de77ef431ff2d7a2f446a8efbbcb0d418c2 |
| web/ProviderSettings.tsx | 56d7df34d1e9ac4fbfba4a2eb1587767e958fe2f22f5531d3b4c51df356656eb |
| server/product-store.ts | 3b53005238933ab76934a28c2160d6ecb101801d64c6075d2d22a721ff566e89 |
| server/product-routes.ts | a77f677748bd9936bae090ad3f1a88302fc48fded748b14347bbc5f26c319370 |
| core/transport.ts | 1fefe26ee7e7dc58ec201d5046cd068a86859b3034a8eeb56c689c907e9bbd97 |
| core/provider-http.ts | cfb33ddb62348d2271f24511d264541cbf933a11599d5c788d216e34039ced9f |
| core/vertex-auth.ts | 1b48cfc3a02de3640051b6209ea698df9fb93fc04944a8b3d851481e1b8d6c8d |
| core/vertex-protocol.ts | 268cc8ba2124ae927cd9aa53cfac405a695f8c61664d3c1c8362ac42ed5d0531 |
| core/openai-protocol.ts | d8e739fd0a8bc74098faaaad33e89fc637cfd901acc085c7afa70e55163e9ddf |
| core/openai-chat-protocol.ts | 01cef7a1d5b33cd325016c72db20078899947226e40154afc042334024160743 |
| core/anthropic-protocol.ts | 0de8307ea182d4683982b8e9d6bbe05fb5d0cb798c8a7ead20e067bf42ab824f |
| core/sol-config.ts | 49877f3437711cab7675ed8fecf1b6c353c8e3ee15db0d406bf5faf970d9219b |
| core/sol-protocol.ts | d638a7a47a42ddfd894646397eabf57ef3b5fe25097eb0b8bad3e35863f2c7d7 |

## 검증 범위

`npx vitest run tests/provider-definitions.test.ts` 결과는 5/5 PASS예요. 등록 protocol의 완전성, 기존 기본값·endpoint validator 일치, unknown capability·price, 공급자별 옵션 구분, 공유 metadata 불변성을 확인했어요. 첫 sandbox 실행은 Vite 시작 중 spawn EPERM으로 막혔고, 승인된 동일 명령 재실행에서 통과했어요. 실제 공급자 호출·인증·청구·원격 모델 가용성·RisuAI 플러그인 실행과 화면은 검증하지 않았어요. 전체 프로젝트 검증은 통합 담당자가 수행해요.
