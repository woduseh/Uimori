# Providers, Codex, execution, context and illustrations

Developer-only technical sections extracted verbatim from `docs/PROVIDERS.md`, `docs/CODEX.md`, `docs/MODEL-PARAMETERS.md`, `docs/MODEL-PRICING.md`, `docs/GLOBAL-MODELS.md`, `docs/EXECUTION.md`, `docs/GENERATION.md`, `docs/CONTEXT-LIMITS.md`, `docs/AGENT-COLLABORATION.md`, `docs/EVALUATION-TOOLS.md`, `docs/ILLUSTRATIONS.md`, and `docs/INPUT-TRANSLATION.md`.

## Providers and transport encoding

이 섹션은 프로바이더 연동과 관련된 내부 아키텍처, 전송 인코딩, 동시성 및 진단 규약을 설명하는 개발자/에이전트 계약이에요.

### 요청 변환 및 소유권 경계
- `core/model-request-fields.ts`: 실행 스냅샷에서 모델 ID, 프로바이더 옵션, 확정된 가격 스냅샷만 추출해 요청 객체로 변환해요. 생성 옵션, 컨텍스트 예산, 도구 정의, 저장 및 실행 정책은 각 호출 주체가 독자적으로 결정해요.
- `server/provider-connections.ts` 및 `server/credentials.ts`: 연결 입력값 검증과 키 저장(DB 읽기/쓰기)을 담당해요. 연결 저장 시 최종 URL 검증과 새로 선택하거나 기존에 저장한 Vertex 서비스 계정 프로젝트 검증은 동일 트랜잭션에서 원자적으로 수행돼요. 자료 편집과 과거 백업 검증이 프로바이더 전송 경로에 개입하지 않아요.
- `server/main-request.ts`: 공통 컨텍스트 측정 경로로, 프로바이더별 요청과 모델별 토크나이저 예산을 통합 처리해요. 컨텍스트 계획, 자동 압축, 다음 요청 분량 미리보기가 이 경로를 사용하며, 실제 전송할 요청을 기준으로 측정하고 요약 포함 여부를 확인해요. Gemini 대화는 역할과 순서를 유지한 네이티브 텍스트로 전송하며, Codex의 두 실행 형식 측정과 도우미 전용 입력 형식도 유지해요.
- 프롬프트 형상 검증은 원본 데이터를 복사하거나 수정하지 않으며, 수정이 필요한 입력과 프로바이더 연속 상태는 소유 경계에서 복사해요. 공개 스트림을 소비하지 않는 호출에서는 중간 표시용 본문을 조립하지 않으며 최종 결과·사용량·취소 처리는 유지해요.

### 프로토콜별 이미지 및 메시지 인코딩
- **본문 참고 이미지 전달 규격**:
  - OpenAI Responses: `input_image`
  - OpenAI Chat / Vercel: `image_url`
  - Anthropic Messages: `image`
  - Google Gemini / Vertex AI: `inlineData`
  - Codex: 전용 이미지 입력 객체 (Codex의 이미지 생성 도구는 켜지 않음)
- **이미지 제약**: DeepSeek 직접 연결 및 명시적으로 확인된 텍스트 전용 모델은 이미지 입력을 거절해요. 지원 여부가 확인되지 않은 사용자 지정 모델은 지원 미확인 상태로 전송을 허용해요. 사용자 이미지 첨부 UI는 본문 요청에 표시돼요. 이미지 배치 판단의 후보 전송은 판단 프로바이더 옵션에서 따로 설정해요.
- **Vercel Chat 변환**: 이전 assistant 메시지의 텍스트 조각들을 순서대로 합쳐 하나의 문자열로 전송해요.
- **OpenAI Responses 변환**: 수동 대화 이력을 assistant를 포함하여 `input_text` 조각들로 구성하고 조각별 캐시 기준점을 유지해요. 도구 후속 요청에서는 프로바이더가 실제로 반환한 메시지·사고·도구 호출 항목을 원래 형식과 식별자로 이어 보내요.
- **Gemini 대화 및 도구 처리**: 도구 호출 후 이어지는 요청은 모델의 원본 응답과 사고 서명을 보존하고, 동일한 사용자 턴 안의 추가 제어 텍스트를 도구 결과(`functionResponse`) 앞에 배치해 Vertex 엔드포인트 거절 문제를 방지해요 (Claude·OpenAI·Codex 요청 형식은 변경하지 않음).
- **Gemini 중간 system 변환**: Gemini 모델 ID(`gemini-…`와 `google/gemini-…` 같은 게이트웨이 ID)로 보내는 요청에서 선두가 아닌 system 메시지는 전송할 때만 user로 바꾸고 `GEMINI_MID_SYSTEM_TO_USER` 진단을 남겨요. 원래 프롬프트는 바꾸지 않아요. 직접 연결은 Gemini API·Vertex AI 레퍼런스가 `contents`에 user와 model 역할만 허용해서 적용하고, 게이트웨이 연결은 확인된 지원 사례가 없어 같은 규칙을 보수적으로 적용해요. 판단 기준은 [모델별 capability](../../core/model-capabilities.ts)의 `acceptsMidConversationSystem`이에요.
- **Anthropic 메시지 보정**: `user → 연속 system → user` 형태의 프롬프트 전송 시, system 블록 끝에 짧은 가상 completed assistant 응답을 전송용으로 한 번 추가해요. 원래 프롬프트 및 실행 스냅샷의 역할·순서·본문·캐시 기준점은 옮기지 않으며 요청 미리보기 진단에만 기록돼요. 도구 후속 요청은 저장된 메시지를 그대로 재생하므로 보조 응답을 중복 추가하지 않아요.
- **DeepSeek 오류 처리**: `insufficient_system_resource` 또는 `aborted`로 응답이 종료된 경우 수신된 본문과 최종 사용량을 보존하고 미완료로 기록해요. 불완전한 도구 호출은 실행하지 않으며 자동 재요청하지 않아요. 원격 중단 사유는 지원하지 않는 응답 형식과 구분해 실행 기록에 남겨요.

### Anthropic Batch 아키텍처
- 자체 배치 스케줄러를 두지 않고, 단일 모델 호출마다 Anthropic Batch API에 요청 하나를 넣고 기존 `runMain` 도구 루프를 그대로 사용해요.
- Claude가 도구를 요청하면 로컬에서 도구를 실행한 후 다음 턴을 새 Batch로 전송해요. `story.submit` 도구가 호출되면 추가 호출 없이 작업을 종료해요.
- SQLite에 `runId`, `attemptId`, `batchId`, `customId`와 요청 해시를 저장해 서버 재기동 시에도 동일 Run과 Batch를 다시 조회해 복구해요. 저장된 Batch 결과와 도구 영수증도 재사용해 중복 실행을 방지해요.
- `batchId` 저장이 누락된 모호한 생성 실패 상태에서는 중복 과금을 막기 위해 자동 재전송하지 않고 실패로 확정해요.
- JEV와 Responses를 포함한 프로바이더 응답 본문 읽기는 작업 취소와 시간 제한에 따라 중단돼요. 완료나 오류가 확정된 뒤에는 응답 스트림 정리를 요청하되 원격 정리 확인을 기다리지 않아 지연에 막히지 않아요.

### 캐시 기준점 진단과 도구 규약 (`cacheBoundaries`)
- OpenAI Responses 및 Anthropic 실행 요청 기록에는 명시적 캐시 기준점 진단 정보인 `cacheBoundaries`가 포함돼요.
- 각 항목은 기준점 위치, 직전 입력과 도구·생성 설정을 포함한 해시, 진단 JSON 바이트 수를 담아요. 로어 뒤 내용이 바뀌어도 앞 기준점 해시는 유지되지만 도구 schema·순서·기준점 앞 사전 도구 이력이 바뀌면 달라져요.
- 기존 `stablePrefixSha256`은 공통 계약·도구만의 해시로 유지하며 전체 프롬프트의 캐시 재사용 근거로 쓰지 않아요. 암묵적 캐시만 있는 요청에는 기준점을 추정해서 추가하지 않아요. 이 진단은 실시간·Batch 모두 로컬 요청 기록에만 추가되고 프로바이더 본문에는 들어가지 않아요.
- Anthropic Messages는 `anthropic-version: 2023-06-01` 헤더를 사용해요. Uimori 도구 이름은 프로바이더 호환용 별칭으로 전송되며, 저장된 도구 이름·인수·결과와 호출 ID는 유지해요. 현재 도구 목록에서 제외한 사전 평가 이력은 원래의 유효한 이름으로 남겨요. 도구 정의 규격은 [공식 도구 정의 계약](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)을 따라요.

### 로어 포함 기록 메타데이터
- 본문·번역 요청을 전송할 때 호스트가 기존 요청 JSON에 작은 메타데이터로 로어 포함 기록을 저장해요.
- 자료 목록에 이름만 있거나 판단 모델에서 선별됐다는 사실만으로 실제 본문 포함을 확정하지 않으며, 프롬프트 가공 등으로 확인하지 못한 후보는 별도로 표시하고 기록이 없는 과거 요청은 미포함으로 추정하지 않아요.
- 로어 본문을 중복 저장하거나 이 기록을 모델에 전송하지 않으며, 기존 요청 기록 보관 범위를 그대로 따라요.

### 동시 수정 및 스트리밍 본문 조립
- 프로바이더와 모델 활성/비활성 상태는 자료를 삭제하지 않고 저장 즉시 다음 호출부터 적용돼요.
- 편집 화면 전환 시 미저장 입력은 보호되며, 다른 곳에서 먼저 저장된 경우 현재 초안을 유지한 채 최신 설정을 불러오도록 안내해요. 설정 조회 API는 편집 가능한 설정만 반환하고 API 키 원문은 일체 반환하지 않아요. 미저장 초안의 키 입력은 브라우저 메모리에만 존재하며 로컬 복구 저장소에 기록되지 않아요.
- 실시간 스트리밍은 디코더가 검증한 추가 청크와 UTF-16 끝 인덱스를 전달해 매 청크마다 전체 문자열을 재비교하지 않아요. 전체 본문 스냅샷이나 앞선 내용 변경 경계에서는 접두사 검증을 유지하고, 종료 시 누적 청크의 합과 최종 본문의 일치 여부를 검증해요. 사고 과정, 도구 인수, 최종 제출 envelope, 구조화 번역은 공개 조각에 포함되지 않아요.

## Codex App Server protocol and isolation

이 섹션은 Codex App Server의 프로세스 라이프사이클, 프로토콜 사양, 격리 환경 및 검증 계약을 설명하는 개발자/에이전트 규약이에요.

### App Server 통신 및 턴 라이프사이클
- Uimori는 공식 CLI의 App Server 프로토콜인 `initialize`, `account/*`, `model/list`, `thread/start`, `turn/start`를 호출해요.
- 본문 Run의 작가, 조언자, 도우미는 각각 **작업 하나를 하나의 thread/turn**에서 끝까지 실행하고 호스트 도구 결과를 동일 턴 안에서 처리해요.
- 번역 및 컨텍스트 정리는 기존의 요청별 ephemeral 실행을 유지하며, 도우미의 별도 가정 장면 실행은 제공하지 않아요.
- 본문 평가 시 `preloaded + economized` 첫 단계만 기존 저비용 요청으로 처리한 후 원래 추론 수준의 native 작문으로 전환돼요. 작업 간 native thread 재개 정보나 불투명한 continuation 상태는 DB에 저장하지 않아요.
- 텍스트 역할은 `thread/start.baseInstructions`로 간결한 Uimori 작문·번역·요약 지침을 전달해 모델 기본 코딩 지침을 대체해요. 도우미(`helper`)는 자료 조회·편집과 저장 결과 확인에 맞는 전용 지침을 사용해요.
- 초기 요청에 작업·이전 대화·자료 범위와 등록된 도구를 전달해요. 도우미의 초기 이력이 입력 예산을 넘으면 Uimori가 시작 전에 컨텍스트 정리를 수행할 수 있어요. native 턴이 시작된 뒤 도구 결과를 받을 때마다 이력을 다시 묶거나 새 턴을 만들지 않으며, 턴 내부 진행·컨텍스트 정리는 Codex가 담당해요.
- RisuPrompt의 논리적 역할·순서·빈 메시지를 JSON으로 전달해요. 메시지 ID·출처 종류·원문 revision/hash는 유지하며 호스트 내부 block/run ID와 항상 완료된 메시지의 중복 상태는 모델 입력에서 제외해요. 현재 user 메시지 하나가 요청 본문과 정확히 같을 때만 별도 `input.task` 중복을 생략해요. Codex 자체 지침이 추가되므로 native API와 메시지 역할 해석이 다를 수 있으며, assistant prefill과 필수 cache는 실행 전에 거절해요.
- `reasoningEffort`와 timeout을 전달해요. 일반 역할의 `maxOutputTokens`는 프로바이더 강제 상한이 아닌 `outputTokenBudget` 소프트 예산으로 전달되며, 이 값을 채우려고 출력을 억지로 늘리지 않아요. 프롬프트에 단어 수 같은 명시적 분량 지시가 있으면 그 지시를 우선해요. temperature 설정은 허용되지 않아요.
- 일반 역할의 구조화 출력과 내부 역할별 결과 검증은 유지하며, native 도우미에는 최종 JSON envelope나 `outputSchema`를 강제하지 않아요.
- 전송 전에 RPC attempt를 기록해요. 동시 실행은 2개, 대기는 최대 32개이며 취소할 수 있어요. Uimori는 재시작·전송 실패·불확실한 실행을 자동 재생하지 않아요. 공식 CLI 0.153은 retry 설정 덮어쓰기를 거절하므로 CLI 내부 재시도나 중복 호출이 발생할 수 있어요. 기존 하네스의 명시적 재요청 및 정상 종료된 결과에 대한 제한된 재시도는 별도 판단 요청으로 기록돼요.
- 한 attempt는 호스트가 시작한 Codex 턴 하나이며 내부 모델 호출 수와 같지 않아요. native 도우미는 여러 도구·모델 판단을 수행해도 한 attempt로 기록하고, 시작 전 컨텍스트 정리 호출은 별도예요. 실제 비용과 내부 모델 호출 수는 `null`로 남기고 턴 전체 timeout·취소와 호스트 도구 권한을 적용해요. Vertex의 USD 예산을 Codex 구독 예산으로 해석하지 않아요.
- 프로바이더가 보고한 `tokenUsage.total`과 `last`의 입력·캐시·출력·추론 토큰은 숫자만 raw usage에 보존해요. 입력·출력 합계는 가장 최근 total 스냅샷으로 갱신하며, 중복 업데이트나 캐시 토큰을 다시 더하지 않아요. 프로바이더가 주지 않은 수치는 0으로 채우지 않아요. 삽화 raw usage에는 완료 항목 종류별 횟수(`itemCounts`)와 사용량 이벤트 횟수(`tokenUsageUpdates`)도 보존해요 (이미지 바이트나 도구 내용은 미포함).

### 본문과 조언의 native 실행

새 프로바이더를 추가하거나 사용자가 스위치를 조작할 필요 없이, 실제 본문 Run에서 Codex 작가나 조언자를 선택하면 자동으로 적용돼요.

- **독립 실행 지원**: 메인 모델이 다른 외부 프로바이더여도 조언자 모델이 Codex라면 native 실행 방식을 사용해요.
- **컨텍스트 및 도구 전달**: 메인 작가는 `buildMainProviderRequest` 및 `editRequest` 결과의 역할·순서·원문·로어·플롯·사전 결과를 그대로 유지하고 도구 스키마만 native 도구 등록으로 전달해요. 조언자는 전용 요청·모델·지침·명시적 초안/근거를 사용하며 작가의 전체 프롬프트를 무단 복사하지 않아요. 기존 `agents.consult` 계약을 유지하며 조언자가 다시 하위 조언자를 호출하거나 본문을 저장하지 못해요. 사전 조언은 기존 순서대로 실행해요.
- **제출 감지와 조기 종료**: 작가의 `story.submit` 또는 유효한 `eval_submit_artifact` 도구 호출이 확인되면 일반 도구 응답을 보내지 않고 즉시 `turn/interrupt`를 호출하고 프로세스를 정리해요. 호스트가 확정한 해당 제출만 성공으로 처리하며, 사용자 취소·timeout·접속 변경·기록 실패는 성공으로 바꾸지 않아요. 새 확인 문장을 요청하지 않고 원문 저장은 기존 판단 모델 판정·응답 후처리·원자적 완료 경로에서 수행해요. 평가 도구가 꺼진 본문은 일반 최종 텍스트도 지원하고, 평가가 켜진 `model-selected`·`preloaded`는 모두 유효한 `eval_submit_artifact`가 필요해요. 본문·조언자 스트리밍은 추가하지 않아요. 호스트 제출 종료의 usage는 `completion: host-submission`, `usageComplete: false`를 남겨 최종 청구량으로 오해하지 않게 해요.
- **컨텍스트 계획 및 근거 기록**: native 실행 중에는 Uimori가 도구마다 프롬프트를 다시 만들거나 별도 컨텍스트 압축을 중복 실행하지 않아요. `editRequest`는 실제 호스트 요청 시작 때만 실행하므로 내부 추론마다 실행되는 훅이 아니에요. 초기 컨텍스트 계획은 기존/네이티브 입력 중 큰 추정치를 사용해 절약형 첫 단계에서도 재사용하고 전송 직전에 실제 native descriptor로 다시 확인해요. 초기 입력의 `requestLore`와 이후 `tool_events` 및 조언자의 `agents.read`는 별도 근거이며 뒤에 읽은 자료를 초기 입력에 포함됐다고 소급 기록하지 않아요.
- **호스트 콜백 및 호출 한도**:
  - 호출 한도는 호스트가 시작한 요청 및 native 실행 건수를 기준으로 계산돼요 (내부 추론 횟수와 일치하지 않으며 읽기 도구마다 모델 호출 1회를 추가하지 않음).
  - 조언 캐시는 재청구하지 않으며 판단 모델·별도 조언 실행은 각각 집계해요. 진행 중인 native 작가는 조언 뒤 같은 turn에서 계속 쓰므로 다음 작가 호출을 예약하지 않지만, 사전 조언과 기존 프로바이더 루프는 작가 호출 1회를 남겨요 (후처리용 예약 유지).
  - 평가의 수동 라운드 설정은 없으며, native 본문은 실패한 제출을 포함한 비최종 호스트 도구 콜백을 고정 10회까지 처리하고 유효한 최종 제출은 별도로 받아요.
  - HTTP 본문 및 번역은 최대 11회의 프로바이더 요청 한도와 기존 전체 호출·시간 한도를 함께 적용해요.
- **합성 stdio 통합 검증**: `tests/codex-writing.test.ts`에서 작성, 조언, 캐시 재사용, 자식 슬롯 할당, 취소 전파, 제출 감지 및 절약형 전환 로직을 검증해요.

### 내장 도구 및 격리 환경 경계
- **비활성화 도구**: 터미널 셸, 파일 시스템 읽기/쓰기, Node REPL, 로컬 이미지 보기, 브라우저/컴퓨터 직접 제어, 외부 앱/MCP, 외부 스킬, 지속 메모리, 내장 하위 에이전트 및 추가 권한 승인 요청은 모두 제공하지 않아요. 호스트 파일·인증·외부 변경 권한을 보호하고 Uimori의 저장·협업·컨텍스트 관리 경계를 유지하기 위함이에요.
- **Code Mode 격리 사양**: `code_mode`는 Node REPL과 다른 격리된 V8 JavaScript 실행기예요. 등록된 도구만 호출하고 Node·파일·네트워크 API 및 모듈 import를 일체 제공하지 않는 계약을 사용해요 (`core/codex-protocol.ts`, `server/codex-runtime.ts`).
- **네임스페이스 격리**: 기본 `functions` 네임스페이스를 제외해 셸·파일 계열 도구가 중첩 실행 경로로 다시 노출되지 않게 해요. Uimori 호스트 도구는 experimental `dynamicTools`의 `uimori` 네임스페이스(`type: "function"`) 아래에만 등록되며, API 제약에 맞춰 `uimori_...` 접두사로 전달되고 호스트에서 원래 이름으로 복원돼요. 호스트는 현재 thread/turn과 `uimori` 네임스페이스가 일치하는 호출만 수락하고 중복 call ID는 거절해요.
- **도구 결과 반환과 응답 스트리밍**: 번역 등 기존 역할은 JSON envelope로 최종 응답을 반환하지만, 본문·조언자·도우미의 native 실행은 `item/tool/call` 요청에 `contentItems`/`success`로 응답해요. 도우미 최종 응답은 일반 텍스트이며 `final_answer`의 공개 텍스트를 스트리밍하고 commentary는 별도 진행 이벤트로 기록해 최종 답변과 섞지 않아요. 내장 검색·계산의 중간 결과와 계획은 본문으로 저장하지 않으며 phase가 없는 구형 응답은 후속 작업이 없을 때 마지막 메시지를 최종 후보로 사용해요.

### 서버 내부의 명시적 다중 턴 세션
- `CodexRuntime.createSession(connection)`은 호출자가 소유하고 `finally`에서 `close()`하는 메모리 내 세션 객체예요.
- `execute`, `executeAgent`, `generateImage`를 순서대로 호출하면 첫 턴의 격리 프로세스와 ephemeral thread를 재사용해요 (기존 단일 턴 메서드는 요청마다 프로세스를 닫음).
- 세션은 연결·모델·기본/개발자 지침·도구 권한을 고정하며 동시 턴 실행을 거절해요. 다른 사용자나 독립 작업에 세션을 공유하거나 DB에 재개 정보를 저장하지 않아요.
- 각 턴의 취소·시간 제한·접속 검사를 유지하고, 실패하거나 결과가 불확실한 턴 뒤에는 세션을 닫아 재사용하지 않아요.
- **연속 삽화 컷 재사용**: 동일 원문 hash와 storyboard 계획의 연속된 Codex 삽화 컷은 이 세션을 사용하되 **컷마다 별도 턴·작업·attempt·결과**를 유지해요. 성공한 컷은 즉시 저장하고 실패한 컷만 기존 정책에 따라 재시도해요. 다른 계획·채팅·연결, 다시 그리기, 세션 입력 예산이나 고정 설정에 맞지 않는 요청은 독립 실행해요. 한 컷의 변형 여러 장을 서로 다른 컷으로 배정하지 않아요.
- **세션 누적 토큰 검사**: 세션의 로컬 이력에는 호스트 도구의 인수·텍스트 응답도 포함해요. Codex가 보고한 누적 입력·출력 토큰이 있으면 다음 턴은 그 값에 새 요청 추정을 더한 값도 모델 입력 예산 안에 들어야 해요. 도구·이미지·추론 항목이 있었는데 사용 가능한 토큰 보고가 없으면 그 세션의 다음 턴은 거절하고 삽화는 독립 실행해요. 누적 사용량은 실제 활성 문맥보다 크게 잡힐 수 있어요.

### 로컬 검증 및 공식 계약

```powershell
npx vitest run tests/codex-process.test.ts tests/codex-runtime.test.ts tests/codex-protocol.test.ts tests/codex-image.test.ts tests/codex-integration.test.ts

# 설치된 CLI 초기화와 experimental 도구 schema 확인: 새 빈 인증 폴더, 로그인/모델 호출 없음
$env:UIMORI_CODEX_PREFLIGHT='1'
npx vitest run tests/codex-installed.test.ts
Remove-Item Env:UIMORI_CODEX_PREFLIGHT
```

- **사전 검사 결과**: 설치 사전 검사 결과는 `output/codex-preflight/summary.json`에 기록되며, 실제 바이너리 버전과 빈 인증 상태를 확인하고 `generate-json-schema --experimental`에서 `dynamicTools`의 function 형식, `item/tool/call` 요청, 텍스트 도구 응답 계약을 검증해요.
- **단위 및 통합 검사**: 합성 stdio 검사는 인증 취소, 오류 은닉 방지, 정상 이벤트 처리, 시간 초과, 종료 경합, 내장 도구 진행과 최종 응답 분리, 환경/승인 경계, 대기 취소, attempt 선기록, 한 턴 내 연속 도구 호출, 중복 호출 차단, 취소 후 늦은 응답을 확인해요. 앱 통합 검사는 일반 역할과 native 도우미, 등록 제안, export/import, 비활성 프로바이더 및 인증/Origin 경계를 확인해요.
- **프로바이더 검증**: `npm run verify:providers`를 통해 390px 뷰포트의 Codex 설정, 모의 로그인, 취소 및 연결 해제 검사를 수행해요.
- **공식 참조 문서**: [App Server 사양](https://learn.chatgpt.com/docs/app-server), [인증 가이드](https://learn.chatgpt.com/docs/auth), [설정 Schema](https://learn.chatgpt.com/config-schema.json).

## Model parameters, cache quirks and connection tests

현재 옵션 정의는 [모델 계열](../../core/model-family.ts), [프로토콜 정의](../../core/provider-definitions.ts), [모델별 힌트와 값 검증](../../core/model-capabilities.ts)이 기준이에요. 모델 ID·한도·옵션 목록을 문서에 별도로 복제하지 않아요. 계열의 옵션 목록을 보여주는 것과 특정 모델이 모든 옵션을 지원한다고 확인하는 것은 달라요. 프로바이더 목록이나 검토 표에서 확인한 값만 확인된 힌트로 표시해요.

- **Claude Opus 5.5**: 정확한 모델 ID `claude-opus-5-5`의 캐시 지원을 확인했어요. 캐시 설정을 미지정해도 작성한 기준점을 보내요. Adaptive thinking은 항상 켜지고 기본 effort는 `medium`이며 강제 도구 호출은 지원하지 않아요. 저장된 생성 설정을 자동으로 바꾸지는 않아요.
- **Claude Fable 5.2 · Mythos 5.2**: 정확한 모델 ID `claude-fable-5-2`와 `claude-mythos-5-2`의 캐시 지원을 확인했어요. Mythos 5.2는 Anthropic 검증을 받은 조직만 쓸 수 있는 같은 사양의 모델이에요. Adaptive thinking은 항상 켜지고 기본 effort는 `high`이며 강제 도구 호출은 지원하지 않아요. 이 모델은 thinking 블록보다 앞선 `system`·`tools`·이전 메시지가 달라진 요청을 400으로 거절해요. 한 실행의 도구 왕복에서는 처음 보낸 `system`·`tools`·메시지와 응답 블록을 그대로 다시 보내고 뒤에만 덧붙이며, 지침·도구·입력이 달라진 후속 요청은 전송 전에 거절해요.
- **GPT-5.6 이후 Responses**: 현재 확인한 TTL은 30분(`30m`)뿐이에요. 선택한 mode는 `prompt_cache_options.mode`, 기준점은 `prompt_cache_breakpoint`로 전달해요.
- **GPT-6.2 Responses**: `gpt-6.2-astra`와 `gpt-6.2-sol`은 최상위 `instructions`를 `input` 뒤에 붙여요. 그래서 모델 ID가 `gpt-6.2` 또는 `gpt-6.2-…` 형태이면(`provider/` 접두사가 붙은 ID 포함) 공통 지침을 `input`의 첫 `developer` 메시지로 보내고 최상위 `instructions`는 생략해요. 캐시 기준점과 `prompt_cache_options`의 위치는 그대로이고, 이전 모델의 요청 형식도 바뀌지 않아요. 두 모델은 사고 강도 `none`을 거절해요.
- TTL을 명시하려면 명시/자동 모드를 선택해요. 캐시 OFF 또는 모드 미지정에 TTL만 남은 조합은 수정 전 저장하지 않아요.
- **Gemini**: 기존 암묵적 캐시는 프로바이더가 처리해요. Gemini 4 Argon과 Carbon은 `cachedContents` 명시적 캐시를 지원하지 않아요. 암묵적 캐시는 Argon의 경우 Vertex 약 6,144토큰·Google AI Studio 약 4,096토큰, Carbon의 경우 두 경로 모두 약 4,096토큰 이상의 공통 접두부에서 적용될 수 있어요(적중 보장 아님). 두 모델의 사고 강도는 `LOW`/`MEDIUM`/`HIGH`만 지원하고, 모델이 무시하는 temperature·top_p는 보내지 않으며, 직접 REST 스트리밍 요청의 출력은 65,536토큰 이내로 제한해요. Gemini 4 Neon은 `LOW`/`MEDIUM`/`HIGH`/`XHIGH`를 지원하고 기본값이 `HIGH`예요. temperature·top_p 생략과 65,536토큰 제한은 Argon·Carbon과 같아요. 긴 출력의 `continuation_token` 자동 재호출은 아직 지원하지 않아요.  이번 앱에는 `cachedContents` 생성·갱신·삭제 기능이나 프로젝트 전체 암묵적 캐시 제어가 없으므로 OFF·TTL 선택을 제공하지 않아요. Chat/Vercel/호환 프로바이더에도 캐시 지원을 추정하지 않아요.

서버는 전송 전에 별도 로컬 진단을 기록해요. 같은 idempotency key는 재전송하지 않고, 같은 모델의 동시 테스트는 하나로 제한해요. 재시작으로 미완료된 테스트는 interrupted로 끝내며 자동 재생하지 않아요. `provider_connection_tests`는 개별 자료·채팅의 휴대용 백업에서 제외하고 전체 SQLite 백업에는 포함해요.

## 저장·실행 경계

모델 revision은 생성 옵션을 보관해요. Run/job snapshot은 이를 고정하며, 본문·번역·컨텍스트 정리·도우미·카드 스크립트 보조 등의 모델 호출은 공통 추출기로 같은 필드를 전달해요. 호출 시 현재 프로바이더의 활성 상태와 인증을 확인해요. 평가 절약 모드는 명시 opt-in일 때만 출력 한도·effort를 줄이고 나머지 binding을 바꾸지 않아요.

## Model pricing and cost estimation

## 실행·저장 계약

- 모델의 `pricing` 설정은 일반 revision CAS로 저장해요. 새 작업을 예약할 때 `ModelSnapshot.pricingSnapshot`에 단가·출처·확인일·컨텍스트 구간 등을 고정해요. 이후 현재 모델의 가격을 수정해도 과거 실행을 재가격하지 않아요.
- 요청의 가격 정보는 host metadata예요. 프로바이더 HTTP/RPC 본문에 전송하지 않아요. 전송 직전 attempt에 가격과 시작 시각을 기록하며 서버가 강제한 Vertex Flex도 예약 당시 보존한 Flex 단가를 사용해요.
- 완료 시 `response.estimatedCost`에 계산 결과·항목별 토큰/단가/금액을 기록해요. 기존 `cost_usd`는 프로바이더가 보고한 실제 비용 전용이고 `null`을 추정 금액이나 0으로 바꾸지 않아요. schema·운영 DB 이관은 필요 없어요.
- 프로바이더별 입력/캐시 합산 의미를 구분해 중복 계산하지 않아요. Anthropic normalized 입력은 이미 캐시를 포함하며 원 usage의 입력·캐시 분할을 사용해요. 출력에 포함된 reasoning/thinking을 다시 더하지 않아요.
- Vercel 캐시 쓰기는 최상위 `cache_creation_input_tokens`를 우선 사용하고, 그 필드가 없을 때만 기존 `prompt_tokens_details.cache_write_tokens`를 사용해요. 쓰기 토큰이 있어도 해당 단가를 모르면 부분합으로 남겨요. 원 usage의 `cost`를 프로바이더 보고 비용으로 자동 해석하지 않아요.
- 사용량이나 단가가 없으면 전체 추정 금액은 미확인이에요. 확인된 항목은 부분합으로 보여요. 사용량이 명시적으로 0이면 단가가 미확인이어도 그 항목의 금액은 0이에요. Vertex는 유효한 `promptTokenCount`가 있는 usage에서 생략된 캐시 읽기 필드만 proto3 기본값 0으로 해석해요. 누락된 usage 전체나 명시적인 `null`은 미확인으로 남겨요.
- 프로바이더가 요청 한도 초과(HTTP 429)로 돌려보낸 호출은 입력·출력 토큰을 0으로 기록해요. 이 상태 코드는 응답 본문이 시작되기 전에 오므로 모델이 실행되지 않았어요. 전체 입력이 0이면 캐시 읽기·쓰기 항목도 0으로 계산해서 추정 금액이 0이 돼요. 그 밖의 HTTP 오류와 끊긴 연결은 프로바이더가 요청을 처리했는지 알 수 없어서 미확인으로 남겨요. 도우미가 한도 초과로 다시 보낸 호출이 작업의 사용량 합계를 미확인으로 만들지 않게 하려는 규칙이에요. `core/provider-http-error.ts`의 `rateLimitedCallUsage`가 정하고 `tests/provider-http.test.ts`, `tests/vertex-transport.test.ts`, `tests/pricing-estimate.test.ts`가 확인해요.
- 실제 서비스 tier가 고정 가격과 다르면 금액을 추정하지 않아요. Anthropic의 `standard_only`는 응답의 `standard`와 같은 기준이에요. 새 Anthropic Batch 예약은 명시적으로 입력한 Batch 단가를 고정하고 추가 할인하지 않아요. 업데이트 전에 예약된 Batch의 기존 가격 snapshot에는 당시의 50% 할인 계산을 유지해요. 기존 미확인 호출은 최신 요금으로 소급 계산하지 않아요.
- 본문에는 작문과 작문 보조의 추정 비용을 표시해요. 번역·제목 등 후속 작업은 작업 현황에서 별도로 확인해요. 상세에는 프로바이더 보고 비용과 추정 비용을 분리해 표시해요.
- 과거 도우미 가정 장면 생성의 사용량은 `helper-artifact`, 당시 컨텍스트 요약 호출은 `summary`로 보존해요. 가정 장면 생성 기능이 종료돼도 이 기록은 유지해요.
- 전체 SQLite 백업은 저장된 가격 snapshot과 추정 결과를 보존해요. 개별 자료·채팅의 휴대용 백업은 프로바이더와 모델 설정과 호출 기록을 옮기지 않아요. 가격은 실행 허가나 누적 금액 차단 조건이 아니에요. 취소·중복·불확실 실행·원문 귀속 계약은 유지해요.

검증은 `tests/model-pricing.test.ts`, `tests/pricing-estimate.test.ts`, `tests/pricing-store.test.ts`, `tests/pricing-transport.test.ts`, `tests/model-pricing-browser.spec.ts`에서 수행해요.

## Global models and prompt workspace

`GET /api/model-workspace`는 `{revision, routes, translationPolicy, summaryLength, mainJudgmentEnabled, mainJudgmentThreshold, judgment, titleModel, helperModel, helperTaskTimeoutMinutes, helperConfirmPaidGeneration, contextModel, scriptModel}`을 반환하고, `PUT`은 `expectedRevision`으로 동시 편집을 보호해요. 선택 기능 모델과 `scriptModel`은 `{id}` 참조 또는 `null`이며 PUT에서 생략하면 기존 값을 유지해요. `helperTaskTimeoutMinutes`와 `helperConfirmPaidGeneration`(도우미의 유료 생성 요청 전 확인, 기본 `false`, [도우미 도구](../HELPER-TOOLS.md#confirmation-before-destructive-or-bulk-operations))도 생략하면 기존 값을 유지해요. `judgment`는 `{provider:'typesafe'}` 또는 `{provider, connectionId, modelId, images}`예요. 이전 DB는 JEV 기본값으로 읽으며, PUT에서 생략하면 저장된 판단 프로바이더를 유지해요. `summaryLength`는 본문·도우미의 [요약 길이](../CONTEXT-LIMITS.md#공통-요약-지침과-출력-여유)를 정해요. 프롬프트 선택과 같은 `prompt_workspace` JSON 행에 저장하므로 모델·프롬프트의 동시 저장 충돌도 CAS로 처리해요. 작문·번역 프롬프트는 프리셋 ID와 명시적인 기본 옵션만 저장하고, 본문과 기본 옵션은 원본의 최신 저장본에서 읽어요. 과거 실행은 접수 당시 스냅샷을 유지해요.

DB·archive의 버전과 지원 이관은 [migration](../DATA-MIGRATIONS.md)을 봐요. 새 DB의 역할 모델은 미지정으로 시작하고 채팅 body의 모델 값을 기본값으로 채택하지 않아요. API의 채팅 `profile.routes`는 고정 본문 모델을 포함한 현재 적용 설정의 읽기 전용 projection이에요. 채팅별 선택은 `profile.pinned.mainPromptPresetId`와 `profile.pinned.mainModel`에 ID로 저장해요. 프로필 수정에서 `pinned` 생략은 유지, `{}`는 전체 고정 해제이며 `expectedRevision`으로 충돌을 보호해요. 보관된 Run의 `snapshot.profile.routes/models`는 과거 실행의 고정 정보예요. 지원하지 않는 과거 DB/archive를 임의로 변환하지 않아요.

## 화면의 기본값 읽기

같은 탭에서 `usePromptWorkspace()`를 사용하는 화면은 하나의 읽기 상태와 변경 알림 구독을 공유해요. 읽는 도중 저장·다른 탭의 변경·포커스 복귀 알림이 오면, 오래된 응답을 반영하지 않고 이어서 다시 읽어요. 마지막 화면 구독이 끝나면 진행 중 읽기를 취소하고 캐시를 비워요. 편집 초안과 예약된 실행 스냅샷은 이 읽기 캐시와 별개이며 변경하지 않아요. 구현은 `web/prompt-workspace-store.ts`, 경합·취소 검증은 `tests/prompt-workspace-store.test.ts`에 있어요.

`CurrentPrompt.defaultValues`는 프리셋의 최신 저장값이며 `optionValues`는 명시적인 기본 사용자 옵션이에요. `values`는 두 값을 합친 현재 실효값이에요. 설정에서 기본값을 선택하면 기본 사용자 옵션을 해제하고 최신 프리셋 저장값을 사용해요. `defaultValues`와 `optionValues`는 Run snapshot에 넣지 않고 실효값만 고정해요. 이전 독립·무명 현재 본문은 부팅 시 별도 프리셋으로 보존하며, 구형 기본값과 다른 옵션은 사용자 지정값으로 유지해요.

- 채팅 제목 모델은 설정 → 역할별 모델의 선택 항목 `titleModel`이에요. 기본은 미지정이며 자동 제목 생성을 끄고, 본문 모델로 대체하지 않아요. 지정하면 새 채팅의 첫 성공 응답 뒤 제목을 한 번 생성하며 사용자가 직접 바꾼 제목은 덮어쓰지 않아요. 본문·번역·이미지의 `TaskRole`이나 채팅 `profile.routes`에는 추가하지 않아요.
  - 새 채팅에서 제목을 직접 입력한 경우와 기존 채팅·포크는 자동 생성 대상이 아니에요. 생성 시작 시 모델·프로바이더와 첫 응답을 고정하고 새 채팅을 만들 때의 화면 언어로, 장면의 이미지·긴장·분위기를 살린 작품명을 짓도록 요청해요. 제목 전용 길이 제한 없이 선택 모델의 출력 예산으로 최대 1회, 제목 모델의 timeout(미지정 시 300초) 안에서 실행해요. 검토 표(`core/model-capabilities.ts`)에 사고 강도·effort 목록이 있는 모델은 제목 요청에만 그중 가장 낮은 값을 보내고, 목록이 없는 모델은 프리셋 값을 그대로 보내요. 전송 전 attempt를 기록하며 실패·재시작 후 자동 재호출하지 않아요. 수동 제목 저장·원문 변경·채팅 삭제가 발생하면 늦은 결과를 적용하지 않아요.
  - 채팅 메뉴에서 제목을 직접 수정할 수 있어요. `PATCH /api/chats/:id/title`의 `expectedTitleRevision`은 제목 이벤트 revision을 사용해 같은 문자열로 저장한 수동 의사와 ABA 충돌도 보호해요. 제목 변경은 원문·설정·폴더 revision을 바꾸지 않아요.

## Execution input lifetime, Batch recovery and response streams

참고 이미지는 `RunSnapshot.requestImages`의 사용자 요청 첨부로 보존하고, 이미지 바이트는 `image_blobs`에 해시별 한 번만 저장해요. 보존본은 정지 이미지의 픽셀을 손실 없이 WebP로 정규화하며, 전송본은 긴 변 2048px·2MiB 이내로 따로 고정해요. 입력 파일과 보존본은 각각 64MiB 이내예요. 변환은 DB 트랜잭션 밖에서 기존 이미지 처리 동시 실행 제한을 공유하고, 최종 바이트와 요청의 귀속은 같은 수락 트랜잭션에 저장해요. 접수 재확인은 소비되거나 만료된 업로드 파일을 읽기 전에 기존 영수증을 확인해요.

미전송 초안의 본문은 입력 즉시 sessionStorage에 보관해요. IndexedDB에는 본문과 첨부 목록을 한 트랜잭션으로 저장하며, 이미지 파일은 추가하거나 제거할 때만 기록을 변경해요. sessionStorage의 세대와 수락 토큰으로 오래된 복구본이 최신 글이나 수락된 요청을 되살리지 않게 해요. Web Locks로 활성 탭의 초안 이름 공간을 소유하고 복제된 탭은 별도 공간에 복사해요. Web Locks 미지원 브라우저에서도 일반 새 탭은 분리하지만 sessionStorage를 복제하는 탭의 동시 편집은 분리되지 않을 수 있어요.

요청 이미지의 원본 메시지 식별자를 프롬프트 가공까지 유지해요. 선택된 `chat` 범위의 사용자 메시지만 첨부를 전달하며 CBS로 복사한 ChatML 문자열에는 이미지를 추정해 붙이지 않아요. Lua `editRequest`는 메시지 `id`를 보존해야 이미지의 재정렬을 지원해요. 이미지가 있는 메시지의 식별자가 유실·중복되거나 역할이 바뀌면 명확한 오류로 중단해요. 빈 텍스트의 이미지 턴과 삭제된 턴을 구분하고, 삭제된 이미지 턴을 다시 생성하지 않아요. 이미지를 쓰지 않는 기존 스크립트의 텍스트 계약은 유지해요.

네이티브 버튼·수동 트리거가 장면을 다시 저장할 때도 사용자 메시지별 첨부 연결을 보존해요. 여러 메시지를 한 장면으로 합쳐 첨부가 8장을 넘으면 저장 전에 중단하고 기존 본문·첨부·변수 상태를 유지해요. 서로 다른 장면에 각각 8장이 있는 대화는 그대로 이어갈 수 있어요.

모델 요청·후속 도구 상태·진단에는 이미지의 불변 참조만 보관하고, 실제 전송 직전에 고정된 첨부와 SHA-256을 확인해 바이트를 해결해요. Anthropic Batch 복구도 고정된 전송본으로 같은 요청 해시를 사용해요. 이미지 base64를 텍스트 토큰으로 계산하지 않으며 `conservative-dimensions-v1`의 해상도 기반 여유량을 별도로 더해요. 이는 모델별 공식 계산식이나 실제 청구값이 아닌 추정치예요. 전송 바이트 제한은 토큰 예산과 별도로 검사해요.

본문 입력의 대화 이력은 원문 검증이 반환한 새 항목을 사용해요. 곧 덮어쓸 전체 이력 사본이나 최근 장면을 선택한 뒤의 추가 복제는 만들지 않아요. 요청용 항목과 원본 snapshot의 분리는 유지해요. 같은 원문 객체의 텍스트가 그대로면 계산한 hash를 재사용하고, 텍스트가 달라지면 다시 계산해요. 제공된 hash와 현재 원문의 일치 여부는 계속 확인해요. 캐시는 객체 수명에 따르는 WeakMap이라 별도 만료 설정·무효화 서비스·원문 복제본을 만들지 않아요.

본문은 유효한 이전 로어를 불러오고 필요한 대화 정리를 마친 뒤 필요하면 로어를 선별해요. 작은 목록이 입력 예산에 들어가면 전체를 판단해요. 큰 목록은 실행에 고정된 모든 첨부 자료의 선택 가능한 로어를 먼저 로컬 검색하고, 현재 요청·최근 대화와 관련된 순서로 본문 전체를 판단 모델의 입력 예산에 넣어요. 폴더나 앞쪽 첨부 위치로 검색 대상을 제한하지 않으며, 한 항목이 남은 예산보다 크면 다음 항목도 검토해요. `core/candidate-search.ts`는 제목·본문의 단어 희소성과 반복 빈도, 한국어·일본어의 두 글자 단서를 사용해요. 추가 API·임베딩 모델·영구 색인 설정은 없어요.

완료되지 않고 끝난 본문 실행(실패·취소·중단·거절·부분 결과)도 끝나는 시점에 고정했던 대화 기록·자료·프롬프트 사본을 정리해요. 표시와 재시도에 쓰는 요청, 첨부 이미지, 모델 표시 이름, 컨텍스트 계획, 읽었던 장면의 ID 목록은 남겨요. 재시도는 현재 원문에서 컨텍스트를 다시 만들어요. 보존한 본문의 판단 모델 판정을 다시 받을 수 있는 실행만 고정 입력 전체를 유지해요. 요청 접수·재시도·후보·재판정·취소 요청에 `Prefer: return=minimal` 헤더를 보내면 실행 ID와 상태 같은 영수증만 돌려줘요. 웹 화면은 이 헤더를 보내서 고정 입력 전체를 내려받지 않아요. 헤더가 없으면 기존처럼 실행 전체를 돌려주고, 고정 입력과 진단 기록은 `GET /api/runs/:id`로도 조회할 수 있어요.

`server/execution-snapshot.ts`가 완료 상태를 작은 표현으로 바꿔요. 일반 Run 조회는 저장된 작은 메타데이터를 그대로 반환하고, 새 작업이 실제 컨텍스트를 요구할 때만 `readRunSnapshot`으로 현재 자료와 메시지에서 다시 구성해요. 로어 승계는 완료된 부모 Run을 되살리지 않고 채팅별 최신 `chat_lore_state`의 원문·조상·메모 출처를 검증해요. SQL 컬럼 이름에 따라 JSON이 자동으로 펼쳐지는 DatabaseSync 하위 클래스나 텍스트 공유 트리거는 사용하지 않아요.

완료된 스트리밍 청크는 최종 원문·도우미 메시지와 중복 보관하지 않아요. 진행 중 재접속과 실패·중단 시 부분 출력용 청크는 유지하고, 완료 조회는 종료 상태와 저장된 최종 메시지로 전환해요. 서버를 시작할 때 화면이 더 이상 보여 줄 수 없는 본문 실행의 청크를 지워요(`pruneUnreachableResponseChunks`, `tests/response-stream.test.ts`). 장면을 남긴 실행, 같은 채팅에서 다시 시도한 끝난 실행이 대상이에요. 다시 시도했더라도 부분 결과 없이 취소된 실행은 작업 목록이 청크로 부분 응답을 보여 주므로 남겨요.

상태 확인은 `server/run-projections.ts`의 경량 조회를 사용해요. Reader는 과거 실패 전체 대신 현재 페이지·최신 실패·활성 작업을 조회하고, 전체 작업 이력은 별도로 불러와요. 저장된 읽기 위치의 페이지가 확정된 뒤 원고를 표시해요. 일반 원고의 논리 대화 구성은 원본·선택한 편집본의 무결성을 검증하되 Reader 문단 블록이나 번역 저장본을 만들지 않아요. 표시 변환은 전역 이벤트 커서가 아니라 원문·변수·자료·이미지 결과 변경에 반응해요. 원문 전체를 읽어야 하는 요청에서만 본문을 가져와요. 중간 장면에서 다시 쓰기는 [독립 채팅 사본](../CHAT-BACKUP.md)으로 만들어요. 마지막 완료 응답은 새 채팅에서 다시 요청하거나 기존 응답을 교체할 수 있으며, 교체는 새 본문 저장이 성공한 뒤에만 적용해요. 두 방식 모두 현재 설정과 해당 응답 직전의 대화·변수 체크포인트를 사용하고 과거 전체 실행의 결정적 재생을 제공하지 않아요.

일반 실시간 provider 요청은 서버가 끊기면 결과를 확정할 수 없으므로 기존처럼 active Run을 `interrupted`로 바꿔 자동 재전송하지 않아요. 반면 main 모델의 Anthropic Batch 실행은 `anthropic_batches`의 durable 상태가 있고 모든 외부 호출이 Batch 기록에 연결된 Run만 다시 `queued`로 되돌려 worker가 이어 받아요. 실시간 요약·판정·스크립트 모델 호출 등이 섞였으면 완료 기록이 있어도 자동 재진입하지 않아요. 원격 호출 완료와 로컬 재생 영수증 저장 사이의 중단을 구분할 수 없기 때문이에요. 안전하게 저장된 실시간 준비 호출이 있는 경우도 수동 확인 대상으로 남기는 보수적인 경계예요.

복구 worker는 Run을 처음부터 임의 재실행하는 대신 같은 `runMain`을 재진입해 Batch 라운드 순서와 요청 해시를 대조해요. 이미 `batchId`가 있는 라운드는 생성 API를 다시 호출하지 않고 조회부터 시작하고, 이미 결과 JSONL을 회수한 라운드는 저장된 결과를 다시 decode해요. provider tool call 뒤에 저장된 `tool_events`도 replay receipt로 사용하므로 읽기·도우미·평가 도구나 terminal 제출을 중복 실행하지 않아요. 거절된 도구 기록은 상태 변경으로 재생하지 않아요. Lua `editRequest`는 저장된 요청 순번·입력 hash·수정 prompt를 대조해 재사용하며, 같은 입력이라도 정상 후속 라운드는 별도로 실행해요. 도구 후속 요청의 크기 추정에는 실제 전송된 수정 prompt를 사용하고, 추정을 위해 Lua를 추가 실행하지 않아요. 실제 전송은 해당 라운드의 수정 결과와 프로바이더 연결 조건을 다시 확인해요.

새 Batch를 만들기 전에는 로컬 row를 `reserved`로 먼저 기록해요. `reserved` 상태는 아직 원격 생성 시도를 시작하지 않았으므로 재시작 후 안전하게 생성할 수 있어요. 원격 생성 시도 직전에 `creating`으로 바꾸며, `creating`인데 `batchId`가 없으면 응답 수신 전 서버가 끊긴 것인지 알 수 없으므로 자동 재전송하지 않아요. 중복 과금 방지가 자동 복구보다 우선이에요.

평가 도구의 세션은 같은 Run ID와 예약된 실행 시각을 사용하고, case·receipt ID는 세션과 도구 호출 ID에서 정해져요. 같은 실행 계약에서는 재시작 때 새로운 임의 값을 만들지 않으므로 preloaded 초기 요청과 후속 평가 영수증도 동일하게 재구성돼요. 평가·제출의 의미나 모델의 판단 단계를 합치지는 않아요. 임의 세션으로 시작한 Batch, 제거된 컨텍스트 도구를 사용 중인 Batch와 함께, 평가 도구 단순화 전 계약으로 예약·제출된 모든 대기·진행 중 평가 Batch는 구버전에서 완료한 뒤 업데이트해야 해요. `model-selected`·`preloaded`의 최종 제출 필수화, 고정 10회 비최종 도구 교환 한도, `source-bound`·찾아바꾸기 제거는 기존 요청·영수증을 새 계약으로 재해석하지 않아요. 과거 snapshot·receipt 원본은 읽을 수 있게 보존하지만 구형 평가 실행 엔진이나 버전별 실행 경로는 제공하지 않아요. 서로 다른 계약의 요청 해시를 무시하는 복구나 자동 재전송도 제공하지 않아요. 자세한 현재 계약은 [평가 도구](../EVALUATION-TOOLS.md)를 봐요.

재개가 승인된 Batch Run은 기존 응답 스트림을 새 writer에게 인계해요. 일반 실행은 같은 스트림을 중복 생성할 수 없고, 이전 writer는 더 이상 기록하거나 종료할 수 없어요. 본문 스트림은 사용자 취소를 `cancelled`, 서버 종료를 `interrupted`로 구분해요.

응답 스트림(`server/response-stream.ts`)은 받은 글을 50ms 또는 1,024자 단위의 청크로 묶어 메모리에서 바로 구독자에게 알리고, SQLite에는 750ms, 4,096자, 시도·구간 전환, 종료 가운데 먼저 오는 때에 한 트랜잭션으로 써요. 저장을 전달과 분리한 이유는 생성 중 커밋 횟수와 구독자의 SQLite 재조회를 줄이는 데 있어요. 청크의 순번은 저장소가 전달 전에 직접 배정하고 저장할 때 같은 순번과 같은 경계로 넣으므로, `read()`는 저장된 행과 아직 저장하지 않은 꼬리를 한 순서로 돌려주고 다른 탭이나 재접속한 화면도 같은 청크를 받아요. 순번은 `sqlite_sequence`에 1,024개씩 미리 예약해서, 서버가 꼬리를 저장하기 전에 죽어도 다음 실행이 이미 전달한 순번을 다시 쓰지 않아요. 이때 잃는 것은 중단된 시도의 마지막 꼬리뿐이고 재개된 실행은 새 시도로 이어져요. 실행이 아직 유효한지는 토큰마다 묻지 않고 저장할 때 확인하며, 그 사이 취소와 종료는 `AbortSignal`이 막아요. `tests/response-stream.test.ts`가 이 순서와 재시작을 확인해요.

번역 작업도 작업 ID로 `translation` 스트림을 가져요(`server/app.ts`의 작업 훅, `server/product-auxiliary.ts`). 스트림은 진행 표시일 뿐이고 `job_results`에는 기존과 같이 판정 단계에서만 써요. 거절 뒤 재시도는 구간 번호와 시도 ID가 달라 따로 구분돼요. 번역 스트림은 완료·실패·취소·재시작 어느 쪽으로 끝나도 청크를 지우고 상태만 남기며, 같은 작업 ID가 다시 실행되면 스트림을 새로 시작해요.

서명이 없는 요약 부분은 다음 호출에 다시 보내는 모델 응답에서 빼요. 요약은 표시용 글이고 모델의 추론 맥락은 서명이 들고 있어서, 요약을 되돌려 보내면 입력만 늘어나요. 서명이 붙은 부분은 받은 그대로 돌려보내야 해서, 그 부분의 글은 다른 모델 응답 부분처럼 연속 상태에 남아요. 프로바이더가 요약 요청이 든 호출을 HTTP 400으로 거절하면 그 작업은 요약 없이 한 번 다시 보내고, 남은 호출에서도 요청하지 않아요. 400의 원인이 요약 요청이 아니면 다시 보낸 호출도 같은 오류로 끝나요.

본편 실행과 Gemini가 아닌 프로바이더는 요약을 요청하지 않아요. 요청 플래그는 `ProviderRequest.thoughtSummary`, 전달은 `ProviderExecutionOptions.onThought`와 응답 스트림 작성기의 `thought`, 표시는 `web/StreamingResponse.tsx`예요. `tests/vertex-protocol.test.ts`, `tests/vertex-transport.test.ts`, `tests/response-stream.test.ts`, `tests/chat-event-stream.test.ts`, `tests/helper-workspace.test.ts`와 `tests/helper-browser.spec.ts`의 `HELPUI08`이 확인해요.

성공해 source가 commit되면 복구에 필요했던 원본 Batch 결과 본문은 제거하고 Batch/attempt 식별 메타데이터만 남겨요.

도우미 활동 조회(`server/helper-activity.ts`)는 도구가 끝나기 전에도 `tool.started`로 지금 실행 중인 도구를 보여 줘요. 대상 이름은 시작 기록에 남긴 구조화된 대상(`helperActivityTarget`의 종류와 ID, 또는 일괄 작업의 개수)에서 조회 시점의 현재 제목으로 만들어요. 인자 미리보기 문자열은 보여 주지 않으므로, 장면 삭제가 지운 미리보기나 작업 완료 뒤 보존 정리가 비운 도구 세부가 활동 표시로 돌아오지 않아요. 지워진 장면과 숨긴 자료는 대상 이름 없이 도구 종류만 남아요. `tests/helper-activity.test.ts`가 완료 전후의 표시를 확인해요.

화면은 시작과 끝을 호출 ID로 짝지은 뒤, 이어지는 읽기·목록·검색·확인 호출을 한 줄로 접어 본 장면과 자료 수, 그 밖의 조회 횟수를 보여 줘요. 펼치면 호출마다 대상과 도구 이름이 보여요. 저장하는 호출과 실패한 읽기는 따로 한 줄씩 남아요. 분류와 묶기는 `web/helper-activity-groups.ts`가 React 없이 맡고 `tests/helper-activity-groups.test.ts`가 확인해요.

실행 중 상태 줄의 문구는 `web/helper-activity.ts`의 `helperActivitySummary`가 마지막 실행 중 단계에서 만들어요. 호출 순번(`helperCalls`)은 조회가 돌려주는 최근 80개 기록과 따로 작업 전체에서 세요. 도구를 많이 쓴 긴 작업일수록 앞쪽 기록이 창에서 밀려나기 때문이에요. 프로바이더 오류 뒤의 대기는 실행기가 기다리기 직전에 남기는 `provider.retry` 기록에서 오고, 다음 기록이 생기면 지난 일로 봐요. 이 기록은 오류 필드를 쓰지 않아요. 실패한 호출은 이미 자기 줄에 오류로 남고, 대기 자체는 실패가 아니기 때문이에요. 펼친 기록은 호출의 결과를 말로 보여 주고 도구의 기술 이름만 그대로 둬요. `tests/helper-activity.test.ts`가 문구와 펼친 기록을, `tests/helper-workspace.test.ts`가 대기 기록을 확인해요.

성공한 도우미 작업의 큰 도구 결과와 일반 작업 영수증 본문은 축약해요. 과거 가정 장면의 원문·요청·수정 이력은 읽기와 복사용으로 보존하며 새 생성·재작성·편집은 제공하지 않아요. 실패 작업은 재시도 판단에 필요한 결과를 유지해요.

도우미 화면 갱신 API는 이벤트 종류·순번만 조회하며 도구 결과 본문을 보내지 않아요. 요약 체크포인트는 실제 저장된 대화 메시지의 출처를 유지하고, 완료 후 제거되는 도구 payload의 사용하지 않는 해시 목록은 보관하지 않아요. 실행 중의 요약·컨텍스트 전환에서는 실제 도구 결과와 완료된 변경을 전달하되 반복 실행하지 않는 기존 동작을 유지해요.

서버의 스트리밍 완료와 최종 메시지 조회는 도착 순서가 다를 수 있어요. 이미 표시한 응답은 브라우저에서 유지하고, 최종 메시지가 준비될 때 교체해요. 서버 청크 영구 보관으로 이 화면 문제를 해결하지 않아요.

## 실행과 브라우저의 경계

`server/run-executor.ts`는 본문 준비·모델 호출·판정·원자적 저장·종료 처리를 맡고, `server/app.ts`는 HTTP 경로와 후속 작업을 연결해요. 삽화와 보조 작업 큐는 서로 분리해 유지해요. 예약된 입력과 준비 중인 실행 입력을 구분하고, 네이티브 준비·로어 선택·컨텍스트 준비·프롬프트 컴파일은 같은 실행 입력을 순서대로 갱신해요.

전송 버퍼가 차면 해당 구독자만 다음 페이지 읽기를 쉬고 `drain`에서 이어 보내요. 이미 수락한 페이지의 cursor는 전진하므로 같은 청크를 다시 보내지 않으며 다른 구독자나 모델 실행을 기다리게 하지 않아요.

도우미 화면은 현재 대화와 최근 네 대화를 메모리에 유지해요. 현재 대화에서 펼친 과거 메시지는 자르지 않고 캐시에서 비운 대화는 다시 조회해요. 관련 cursor와 요청 식별자도 함께 정리하며 이전 조회가 늦게 끝나 새 조회를 덮어쓰지 않아요.

## Generation, queued next request and automatic refusal retry

채팅당 실행 중인 생성은 하나(`one_active_run_per_chat`)라서, 집필 중에 보낸 다음 요청은 서버 대기열이 아니라 그 탭에만 있는 한 건으로 예약해요. 예약은 서버의 실행과 1회 옵션 예약(`chat_option_pending`)을 미리 차지하거나 순서를 바꾸지 않아요. 보낼 때는 일반 전송과 같은 경로와 멱등 키를 지나가므로, 접수가 불확실한 요청은 기존의 **이전 요청 확인**이 이어받고 새로고침이나 다른 탭에서도 두 번 나가지 않아요.

자동 전송은 앞선 실행이 `completed`로 끝났고, 이 탭이 같은 채팅을 보고 있고, 요청이 함께 보낼 설정의 수정 번호가 예약 때와 같고, 확인 대화상자(Codex 내용 경고 등)나 다른 전송 조건이 막고 있지 않을 때만 해요. 비교하는 수정 번호는 채팅 설정, 채팅 프로필(입력창의 모델, 페르소나, 모듈과 작가 노트, 로어 정책, 고정 프롬프트), 창작 옵션, 전역 모델과 프롬프트 설정 네 가지예요. 서재 자료, 로어 항목, 플롯의 진행 중 항목, 이야기 가이드는 비교하지 않고 직접 보낼 때처럼 보내는 순간의 내용을 써요. 조건은 실행이 끝난 것을 탭이 본 순간에 확인해요. 숨은 탭은 화면을 갱신하지 않으므로, 다시 보일 때 확인하고 보내요. 하나라도 어긋나면 보내지 않고 예약 내용을 입력창 초안으로 되돌린 뒤 이유를 알려요. Codex 내용 확인 요청 자체가 실패해도 확인이 필요한 것으로 보고 되돌려요. 직접 보낼 때는 같은 실패에서 그대로 보내지만, 자동 전송에는 결과를 지켜보는 사람이 없기 때문이에요. 채팅을 떠나면 그 자리에서 예약을 끝내요. 보내기 직전의 확인 중에 떠났다가 돌아와도 그 예약은 보내지 않아요. 새로고침 뒤에는 예약을 보내지 않고 초안으로 되돌려요. 실행이 끝났는지 확인할 수 없는 상태에서 자동으로 보내지 않기 위해서예요. 자동으로 보낸 요청도 직접 보낸 요청과 같은 전송 함수(`web/main.tsx`의 `generate`)를 거치므로, 리더가 새 글을 따라 내려가요.

로어 초기화 표시는 예약에 함께 담겨 그 요청에만 적용되고, 입력 번역의 원문 되돌리기는 예약하는 순간 전송할 때처럼 끝나요. 예약은 새로고침에 대비해 텍스트만 세션 저장소에 두므로, 참고 이미지가 있는 요청은 예약하지 않아요. 동작은 `web/useStory.ts`의 `queueRequest`, `sendQueuedRequest`가 맡고 `tests/composer-next-request-browser.spec.ts`가 확인해요.

다시 생성은 수동 **다시 시도**와 같은 `retryRun` 경로로 `retryOf`가 앞 실행을 가리키는 일반 실행을 만들어요. 그래서 채팅당 실행 하나, 멱등 키, 수정 번호 확인이 그대로 적용되고, 각 시도는 자기 호출 한도(`maxCalls`)와 사용량을 따로 가져요. 거절된 실행의 글·오류·사용량·attempt는 바뀌지 않아요. 횟수는 `retryOf` 사슬에서 자동 재시도 키(`auto-refusal-retry:<거절된 실행 ID>`)를 가진 실행을 거슬러 세므로, 사용자가 직접 다시 시도하면 새로 0부터 세요. 한도에 닿으면 마지막 거절 실행이 그대로 남아 수동 다시 시도를 기다려요.

사용자 취소, 서버 종료·점검, 인증·연결 실패, 결과를 알 수 없는 오류, 호출 한도·컨텍스트 한도 초과, 판정 실패, 판정만 다시 시도한 실행의 거절, 실행 뒤 이야기가 진행됐거나 장면이 삭제된 경우는 다시 보내지 않아요. 거절 기록과 다음 실행 접수는 한 트랜잭션이라 둘 다 남거나 둘 다 남지 않아요. 접수 뒤 시작 전에 서버가 멈추면 다음 실행은 다른 실행처럼 `interrupted`로 끝나요. 같은 거절 실행의 키는 하나뿐이라 두 번 접수되지 않아요. 다음 실행이 접수된 거절에는 실패 푸시 알림을 보내지 않고, 다시 보내지 않아 거절이 최종 결과가 될 때만 보내요. 구현은 `server/run-retry.ts`의 `finishRefusalWithAutomaticRetry`, `server/run-executor.ts`이고 `tests/run-auto-refusal-retry.test.ts`, `tests/main-judgment.test.ts`가 확인해요.

구현 진입점은 `server/model-runner.ts`, `server/run-retry.ts`, `server/main-judgment.ts`, `server/product-auxiliary.ts`, `server/source-editing.ts`예요. 합성 테스트로 데이터 흐름과 저장 동작을 확인해요.

## Context limits, compaction and request measurement

**채팅 설정 → 생성 설정 → 고급 실행 설정 → 작업당 모델 호출 한도**는 정수 1~128회예요. `PATCH /api/chats/:id/settings`도 같은 범위를 허용해요. 본문 요청의 조회 후속 호출·컨텍스트 요약은 이 한도를 함께 사용하고, 설정 변경은 이후 예약에 반영돼요. 번역은 별도 정책의 2~64회를 사용해요. 새 도우미 작업은 내부 정책인 도우미 판단 64회·전체 모델 호출 128회, 호스트 도구 호출 256회와 설정의 도우미 작업 제한 시간(기본 60분)을 사용하며 대화별 한도를 편집하지 않아요. 한도가 허용하는 마지막 호출에는 도구 없이 완료한 일·저장한 변경·결과가 불확실한 변경·남은 일을 정리해 답하라는 표시(`finalCall`)를 붙여요. 그 호출에서도 도구를 요청하면 도구를 실행하지 않고 한도 소진으로 실패 처리해요. 이미 접수한 작업은 저장된 호출 한도를 유지해요. 네이티브 Codex 내부 모델 요청은 관측할 수 없으므로 이 한도는 비용 상한을 뜻하지 않아요. 호출 횟수는 입력 토큰 한도·출력 한도와 다른 제한이에요.
`GET/PUT /api/chat-generation-defaults`는 `{revision,maxCalls,storyUi,storyUiStyle,autoRefusalRetryEnabled,autoRefusalMaxRetries}`를 읽고 저장해요. PUT에서 뒤의 두 값은 생략하면 기존 값을 유지해요. PUT은 `expectedRevision`으로 동시 수정을 검사해 충돌 시 409를 반환해요. 기본값은 `app_metadata`에 저장해요.

사전 정리가 끝난 뒤에도 같은 요청 안에서 `story.read` 등을 반복하면 조회 결과가 입력을 채울 수 있어요. `server/model-runner.ts`는 다음 모델 호출 직전에 반환된 결과를 포함한 실제 전송 body를 다시 추정해요. 입력이 85%를 넘고 정리할 성공한 읽기 결과가 있으면 `server/context-tool-compaction.ts`가 예약 당시 컨텍스트 정리 모델로 그 결과를 요약해요. 이 경로는 평가 도구 실행을 제외한 본문 실행기에 자동으로 적용해요.
구조화 요청은 완료된 도구 기록까지 구성한 뒤 `withNativeHostContext`로 참고 메시지를 확정해요. 본문·번역의 동적 참고 자료는 `system`/`instructions`가 아닌 별도 사용자 역할의 참고 메시지에 두며, 사용자가 작성한 프리셋의 역할과 순서는 보존해요. 인코더는 참고 컨텍스트 불일치를 지침 문자열에 덧붙여 보정하지 않아요. Codex는 같은 자료를 JSON `input`으로 이미 전달하므로 내용이 동일한 호스트 참고 메시지만 생략해 중복을 피하고, 현재 요청·원래 프롬프트·완료 영수증은 유지해요.
`core/context-summary-policy.ts`는 자동 대화 요약, 실행 중 읽기 요약, 도우미 요약에 공통 정보 보존 지침을 제공해요. 주체·상대·행동·해당 행동의 조건, 관찰·계획·믿음·전언, 이행 여부 미확인, 명시적 사용자 정정과 정확한 식별자·알려진 출처를 구분해요. 이행 확인이 없다는 사실을 실패나 미이행 확정으로 바꾸지 않도록 지시해요. 지침 공유가 실행기나 저장 범위를 합치는 것은 아니에요.

`GET /api/chats/:id/context`, `PUT /context/summary`, `POST /context/compact`와 `/context/jobs/:jobId`의 조회·취소가 이 계약을 사용해요. 각 짧은 경로 앞에는 `/api/chats/:id`가 붙어요. 자동·수동 결과는 `context_checkpoints`, 활성 포인터는 `context_heads`, 수동 실행과 전송 영수증은 `context_jobs/context_job_attempts`에 보존해요.

도우미의 `context.read`와 화면 상세는 같은 현재 요약·원문 출처·유효한 메모·사용 가능 여부를 읽어요. 화면만 최근 10개 정리 작업의 작은 상태를 더 제공해요. 완료 작업의 전체 입력이나 과거 checkpoint 본문을 조회해서 버리는 경로는 없어요. 요약이 현재 자료와 맞지 않으면 `usable: false`와 이유를 반환해요.

`server/context-dependency.ts`는 실제 작문 program과 적용값·자료·정정·네이티브 이력에 따라 재사용을 판단해요. 기본값 수정 번호나 도우미/번역 모델만 바뀐 것은 본문 요약 무효화 사유가 아니에요. `tests/context-checkpoint-storage.test.ts`와 `tests/helper-context-read.test.ts`가 저장 수명과 조회 경계를 검사해요.

채팅 입력창의 **다음 요청 미리보기**는 현재 초안과 저장된 원문 head·설정·작문 모델·프롬프트·페르소나로 다음 첫 본문 요청을 투영해요. `POST /api/chats/:id/request-preview`는 `request`, 선택적인 `loreContextReset`과 `requestImages`를 받아요. 이미지 항목은 `name`·`width`·`height`만 사용하며 바이트를 올리거나 저장하지 않아요. 실제 요청과 같은 초안 길이 검사를 적용하고 이미지가 있으면 빈 텍스트도 허용해요. 응답에는 선택 항목과 revision, 로컬 토크나이저·실효 입력 예산·요청 추정량, 이미지 개수와 보수적 이미지 토큰 추정치, 로어 보존·고정 항목 수, 기존 요약의 재사용 여부가 포함돼요. 원문·프롬프트 본문·연결 주소·인증 정보는 돌려주지 않아요.
`tests/request-preview.test.ts`는 실제 API와 임시 SQLite, 네이티브 미리보기 경로에서 조회 전후 DB 변경 수·프로바이더/콜백 미실행·초안 및 현재 설정 반영·유효 요약 재사용·조회 중 revision 변경을 확인해요.
로컬 텍스트 분절이 맞더라도 JSON 계수는 프로바이더의 실제 입력 포맷이나 청구 토큰과 같지 않아요. 토크나이저 세대·프로바이더 내부 포맷·조각 경계 차이 때문에 이 수치는 여전히 추정이며 상한 보장도 아니에요. 같은 내용의 body라도 실행마다 새로 만드는 Run·메시지 ID와 해시 때문에 추정값이 조금씩 달라져요. 기존 `o200k_base-v1`에서 관측한 예로 직렬화 길이가 15,887 UTF-16 단위로 동일한 body가 6,943–7,011 토큰(약 1%) 범위로 움직였어요. 85%·75% 판정은 이 편차보다 큰 여유가 있을 때만 결정적이므로, 합성 검사도 픽스처를 경계 1% 안쪽에 두지 않아요.

Gemini 계열 요청이 이어 보내는 프로바이더 서명(`thoughtSignature`)과 추론 본문은 입력 추정에서 빼요. 프로바이더는 이 불투명 값을 글자 수대로 세지 않아서, 그대로 토큰화하면 도구 호출이 쌓일수록 추정이 실제 입력의 몇 배로 커지고 필요 없는 정리가 일어나요. 운영 기록에서 서명을 포함한 추정이 258,852였던 시점에 프로바이더가 보고한 입력은 92,495였고, 서명을 뺀 추정은 Vertex 도우미 호출 1,146건에서 실제 입력의 0.88–1.22배(호출 순서 구간별 중앙값)였어요. 정리 판정(`measureProviderRequest`), 전송 전 한도 검사(`core/vertex.ts`), attempt에 남는 추정치가 모두 같은 기준을 써요. 회귀는 `tests/helper-compaction.test.ts`와 `tests/vertex-transport.test.ts`에 있어요.

구현은 `core/context-budget.ts`, `core/context-plan.ts`, `core/context-projection.ts`, `core/notes.ts`, `core/story-context.ts`, `server/context-planning.ts`, `server/context-compaction.ts`, `server/context-tool-compaction.ts`, `server/model-runner.ts`, `server/context-store.ts`, `server/story-notes.ts`에 있어요. `tests/context-integration.test.ts`와 관련 context/story 검사는 실제 앱 경로와 fresh SQLite, 합성 provider body로 경합·취소·입력 귀속·보관을 확인해요. 기존 모델 작성 checkpoint 보존과 실행 중 조회 결과 정리는 해당 context 저장·도구 검사로 확인해요. 단계별 EOF는 `tests/context-compaction.test.ts`와 `tests/helper-compaction.test.ts`에 회귀가 있어요.

### 파생 컨텍스트 검증

`tests/context-provenance.test.ts`는 조건부 약속, 인물의 전언, 보조의 해석, 작가 정정, 미채택 전개를 여러 번 투영해도 호스트가 본문이나 출처를 바꾸지 않는지 검사해요. 이는 모델이 여러 번 요약해도 의미를 보존한다는 증거는 아니에요. `tests/context-tools.test.ts`는 실제 요청 빌더를 통해 다섯 전송 경로의 지침 영역과 참고 자료를 구분하고, `tests/agent-collaboration-context.test.ts`는 실제 도구 루프에서 캐시·전달·원문 범위를 확인해요.

실제 모델을 평가할 때는 같은 사례를 1회·3회·5회 요약한 뒤 조건·주체·불확실성·정정·제안 구분이 남는지 비교해요. 정보가 이미 충분한 경우의 불필요한 재조회도 함께 세요. 자동 감독 모델, 문장별 확신 점수, 매번 원문 재검증하는 단계는 추가하지 않아요.

## Custom agent collaboration

## 호출과 저장 계약

`RisuPrompt.collaboration`은 아래 데이터를 보관해요. `validateRisuPrompt`과 `validateAgentCollaboration`이 알 수 없는 필드·ID 중복·공유 옵션 참조·수치 한도를 검사해요.

```ts
type AgentCollaboration = {
  enabled: boolean;
  sharedInstructions: string;
  sharedControls: string[];
  maxCalls: number; // 모든 보조가 나눠 쓰는 1~12회
  agents: {
    id: string;
    title: string;
    description: string;
    instructions: string;
    model: { id: string } | null; // null이면 메인 모델 상속
    trigger: 'before' | 'on-demand';
    tools: ('knowledge' | 'skills' | 'notes' | 'story')[];
    maxCalls: number; // 한 에이전트의 호스트 요청/native 실행 한도 1~6회
  }[]; // 최대 6명
};
```

API는 기존 `POST/PUT /api/prompt-presets`의 `program`을 사용하며 수정은 `expectedRevision` CAS로 보호해요. 협업을 끈 상태에서는 빈 이름·지침·미입력 호출값과 삭제된 공유 옵션 참조도 보관하므로 다른 프롬프트 편집을 저장할 수 있어요. 다시 켤 때 필수값·공유 옵션과 실행 한도를 검증해요. 데이터 형식과 중복 ID 검사는 저장할 때도 유지해요. 별도 협업 편집 후 오래된 본문 undo가 협업 설정을 지우지 않아요.

현재 프롬프트와 모델을 Run 예약 시 고정해요. `ProfileSnapshot.collaborationModels`에 에이전트 ID별 모델·프로바이더·파라미터를 보관하므로 진행 중 설정 수정은 다음 Run부터 적용돼요. 각 보조 실행을 시작할 때 현재 프로바이더 연결을 확인하고 전송 전에 attempt를 기록해요. 기존 `role: main` 전송을 사용하되 attempt의 host 전용 `agentId`로 보조 호출을 구분해요. 이 ID는 프로바이더에게 보내거나 모델 출력에서 받지 않아요.

모든 보조 호출은 요약·메인과 같은 `settings.maxCalls`에 포함돼요. 보조 전체 한도와 각 에이전트 한도는 작성 전 상담·후속 질문·조회 왕복의 호스트 요청을 합산하며 메인의 다음 호출 1회분을 남겨요. 단, 실제 본문의 Codex native 작가 안에서 하는 자문은 이미 진행 중인 turn으로 복귀하므로 다음 작가 요청을 예약하지 않아요. 새 질문으로 한도가 초기화되지 않아요. 수정 가능한 조회 오류는 같은 예산과 timeout 안에서 교정할 수 있어요. 기본 전체 추가 호출 한도는 3회, 템플릿별 한도는 2회예요. 최종 작문이 더 많은 도구 왕복을 요구하면 기존 전체 한도에서 끝날 수 있어요. 켜진 협업은 호출 여부와 별개로 도구 설명·공유 지침만큼 메인 입력이 늘어나요.

모델별 `maxOutputTokens`·입력 토큰 한도와 timeout을 사용해요. 보조의 timeout은 한 상담의 여러 호출이 나눠 써요. 완료된 의견은 별도 글자 수로 자르지 않고 메인에게 전달해요. 과거 프리셋·백업의 `maxOutputChars`는 값과 관계없이 무시하고 새 저장 시 제거해요. 과거 상담 영수증의 `truncated` 표시는 보존해요. 이름·역할 설명·지침에도 협업 전용 글자 수 제한을 두지 않으며 프롬프트 파일·API의 공통 저장 크기 경계를 따라요.

보조 실패·거절·부분 응답·불확실 연결 종료는 사용 불가 결과로 전달하고 자동 재호출하지 않아요. 이미 소비한 호출과 usage는 유지하며 실제 비용 미제공 값 `null`을 0으로 바꾸지 않아요. 취소하면 보조와 메인을 함께 멈추고 늦은 결과를 원문으로 저장하지 않아요. 서버 재시작·보관 복원도 불확실 실행을 자동 재생하지 않아요.

작성 전 상담은 등록 순서를 유지해요. 보조들이 공유 호출 예산을 사용하고 전송 직전에 attempt와 사용량을 기록하므로, 병렬 실행은 별도의 예산 예약 계약 없이 추가하지 않아요.

Run의 `agents.consult` tool event에 의견·상태·호출량·질문·출처·명시 컨텍스트 해시를 남겨요. `agents.read`에는 실제 읽기 결과를 남기고, 모델 입력은 `agentId`로 구분하며 `consultationContext`에 실제 전달한 의견·근거·초안을 기록해요. 이 정보는 실행 중 상담에 사용하고 완료 후 영구 아카이브로 보존하지 않아요. 독립 채팅 백업에는 최종 원문과 이어쓰기 자료만 담아요. 원문에는 메인의 최종 응답만 저장해요. 보조가 읽은 본문을 다음 Run의 유지 로어로 자동 승격하지 않아요.

협업 설정은 기존 JSON 필드에 보관하고 협업 전용 DB 테이블은 없어요. DB 버전·지원 이관은 [데이터 형식](../DATA-MIGRATIONS.md)을 따라요. 복원은 에이전트 모델 귀속을 검사하고 메인·보조 snapshot의 인증 참조를 제거하며 프로바이더를 비활성화해요. 모델·프로바이더 삭제는 새 선택과 전송 권한에 적용하며 과거 실행 snapshot은 보존해요. 현재 작업본의 전용 보조 모델이 삭제되면 협업을 끄고 모델 선택을 해제해요. 자세한 처리는 [항목 삭제](../DELETION.md)를 참고해요.

## 검증 범위

설정·보관 검사는 `tests/agent-collaboration-config.test.ts`, `tests/agent-collaboration-store.test.ts`예요. `tests/agent-collaboration-runtime.test.ts`는 실제 loopback Responses 서버와 새 SQLite DB로 순서·추가 조회·권한·호출량·중복·취소·설정 변경을 검사해요. `tests/agent-collaboration-context.test.ts`는 선택 컨텍스트·초안·구성·컨텍스트별 캐시와 호출 예산, 새 컨텍스트 창 뒤 참조, 수정 가능한 오류를 확인하고 실행 입력은 테스트에서 실행 시점에 관찰하며, 실제 DB의 완료 후 정리도 별도로 검사해요. 브라우저는 `tests/agent-collaboration-browser.spec.ts`의 AGENTUI02에서 데스크톱 편집과 실제 저장/미리보기 API를 확인해요.

합성 검사로 구현 계약을 확인해요.

## Optional evaluation tools

## Implementation

Settings and runtime coverage are in `tests/evaluation-settings.test.ts`, `tests/evaluation-tools.test.ts`, and `tests/evaluation-runtime.test.ts`. `npm run verify:evaluation` exercises the settings UI with synthetic data. Select checks according to [DEVELOPMENT](DEVELOPMENT.md#verification).

## Codex main native turns

Real main Codex Runs keep evaluation definitions, bootstrap and artifact processing in native tool callbacks. Both modes require terminal artifact submission. `preloaded` with `economized` keeps its first low-effort request in the old transport, then starts the native writer with the configured effort and completed results. The session and prior effects are not recreated. The fixed ten-exchange limit counts nonterminal Uimori host tool callbacks, including unsuccessful submissions; valid terminal submission is accepted separately. It does not count hidden model samples. HTTP main and translation runs retain request-based accounting, with at most eleven provider requests and the existing overall execution limits. See [Codex](#본문과-조언의-native-실행) for final submission, usage and cancellation boundaries.

## Scene illustrations

### 작업 큐와 동시성 제어

- **작업 펌프 구조**: 하나의 삽화 펌프 안에서 텍스트 작업 1개와 렌더 작업 1개를 독립적으로 병행 실행해요. 같은 계획의 대표 컷부터 순서대로 렌더를 진행하며, 본문 작성 슬롯이나 사용자 입력 상태를 잠그지 않아요.
- **중복 방지 잠금**: 한 응답 내에서 장면 전체의 컷을 고르는 계획 작업은 1개만 진행돼요 (`ILLUSTRATION_PLAN_ACTIVE`). 다른 컷의 렌더는 독립 예약할 수 있지만 동일한 컷의 중복 실행은 방지돼요 (`ILLUSTRATION_ACTIVE`).
- **상태 머신**: `queued → running → completed | failed | cancelled | interrupted`. 사용자가 작업을 취소하면 `generation` 카운터를 증가시켜 지연 도착한 결과를 폐기해요. 서버가 재시작되면 실행 중이던 작업은 `interrupted`로 변경되며 자동 재실행하지 않아요 (`queued` 작업은 재개).
- **작업 단위**: `illustration_jobs.input.task`는 `plan`, `render`, `placement`로 나뉘어요.

### 데이터베이스 스키마와 메타데이터

- **테이블 구성**:
  - `illustration_settings`: 앱 전체 실행 환경과 정책
  - `illustration_references`: 채팅별 참조 이미지 및 인물 외형 설정
  - `illustration_jobs`: 비동기 작업 큐 및 실행 상태
  - `illustration_images`: 생성된 이미지 BLOB 참조 및 메타데이터
- **프리셋 영속화**: 프리셋 엔티티는 공통 `versions` 테이블의 `illustration-preset` 리소스로 저장되고, 사용자 선택 상태는 `app_metadata`의 `illustration-preset-preferences`에 저장돼요. [데이터 형식](../DATA-MIGRATIONS.md)
- **표시 소유권**: `app_metadata`의 `illustration-presentation:<sourceId>`가 대표 타깃, 컷별 최신 요청/표시 작업 ID, 번역문 hash와 위치 매핑을 소유해요. 작업 실행 입력과 화면 표시 선택을 엄격히 분리해 늦게 완료된 이전 요청이 새 선택을 덮어쓰지 못하게 방어해요.
- **원문 리비전 귀속**: 작업은 `source_revision`과 예약 당시의 `source_hash`에 귀속돼요. 사용자가 나중에 원문을 수정하더라도 완료된 삽화는 요청 당시 원문에 귀속되어 남으며 **수정 전 원문의 삽화**로 표시돼요. 실행 시점에는 예약 hash의 원문을 다시 조회해요 (`sourceAtHash`).
- **Reader 통신**: `GET /api/chats/:id/reader`는 현재 장면의 `illustrations` 목록을 반환하고, SSE 이벤트 `illustration.*` 및 `illustration-layout.updated`를 통해 해당 장면의 변경만 실시간 갱신해요. 작업 현황(`reader.activity`)에는 `kind: 'illustration'`으로 표시되며 본문 생성 진행 표시(`activeJobs`)를 방해하지 않아요.

### 도구 및 컨텍스트 계약

- **프롬프트 모델 읽기 도구**:
  - `illustration.sources.search`와 `illustration.sources.read`를 제공해요.
  - 예약 시점에 고정된 캐릭터 카드, 페르소나, 모듈의 native CHARX 설명과 로어북, 기존 성공 삽화의 캡션과 프롬프트를 검색하거나 페이지 단위로 읽을 수 있어요.
  - 별도의 쓰기 도구는 제공되지 않으며, 번역 위치 연결 작업에는 이 도구를 제공하지 않아요.
- **일관성 가이드 (`visualCanon`)**: 계획 수립 시 선택적으로 `visualCanon: [{name, appearance}]`를 구성해 같은 응답의 모든 컷이 인물 정체성을 공유하도록 프롬프트에 결정적으로 포함해요.
- **입력 토큰 예산**: 계획 단계에서는 응답 전체를 검토하며 모델의 전체 컨텍스트 예산을 초과하면 즉시 실패해요. 컷별 렌더와 번역 위치 연결에는 고정된 focus·visualBrief 및 관련 원문의 끝부분 최대 2,000 추정 토큰을 발췌해 전달해요.

### 이미지 처리와 저장소

- **이미지 파이프라인**: 모든 생성 결과는 64MiB 입력 한도 내에서 실제 이미지 디코더를 거쳐 고품질 WebP로 변환된 후 공통 `image_blobs` 저장소에 영속화돼요. `/api/illustration-images/:id`로 서빙돼요.
- **참조 이미지 처리**: 참조 이미지는 긴 변을 최대 1536px로 축소하여 Codex에 전달하며 확대나 자르기는 하지 않아요. 원본 bytes와 hash는 저장소에서 불변으로 보존돼요.
- **채팅 복사와 백업**: 독립 채팅 복사 및 개별 백업은 현재 화면에 표시된 성공 결과, 동일 컷의 변형 그룹, 대표 지정, 검증 가능한 원문/번역 위치만 복원해요. 문단 index와 텍스트 hash를 검증해 새 anchor를 부여하고, 불일치 시 보조 영역으로 이동해요. 미완료 작업이나 실패 기록은 복제하지 않아요.

### Codex 경로 기술 계약

- **턴 분리**: 계획 수립(프롬프트 모델)과 이미지 생성(Codex)은 완전히 다른 턴으로 실행돼요. 계획, 번역 위치 연결, ComfyUI 프롬프트 작성 턴에서는 웹 검색, code mode, 이미지 생성을 모두 끄고 `features.image_generation=false`를 명시해요.
- **프롬프트 다듬기**: 컷을 예약할 때 설정을 고정해 재시도에 사용해요. 켜면 기존 이미지 턴에서 초안과 선택된 순간, 스타일 지침 원문, 참고 이미지를 바탕으로 Codex가 지시를 다듬고 캡션을 작성해요. 캡션을 받지 못하면 초안의 캡션을 사용해요.
- **프로세스 및 세션 재사용**: 동일한 계획의 연속 컷들은 단일 Codex 프로세스와 임시 ephemeral thread를 재사용해 컷마다 `turn/start`를 호출해요. 이미지 턴에서는 웹 검색과 JS 계산을 끄고 `features.image_generation=true`를 사용해요. [Codex 실행 경계](../CODEX.md)
- **동시성 슬롯**: 텍스트 턴과 분리된 별도 슬롯(동시 실행 1개, 대기 8개)을 사용하며 `role: 'illustration'`으로 기록해요.
- **결과 수신**: `item/completed`의 `imageGeneration` 항목에서 base64 `result`를 우선 읽고, 비어 있다면 전용 디렉터리의 `savedPath` 파일을 읽은 뒤 삭제해요.
- **실패 코드**:
  - `CODEX_IMAGE_USAGE_LIMIT`: 유료 한도 초과 (자동 재요청 안 함)
  - `CODEX_IMAGE_UNAVAILABLE`: 명시적 생성 거부 (자동 재요청 안 함)
  - `CODEX_IMAGE_NOT_GENERATED`: 일반 생성 실패 (재요청 가능)

### 번역 위치 연결의 판단 모델 사용

번역 위치 연결은 [판단 프로바이더](../PROVIDERS.md#판단-프로바이더)를 먼저 사용해요. 번역 문단 전체를 공통 입력에 한 번 넣고 컷마다 "이 순간의 서술이 끝나는 번역 문단"을 묻는 선택 질문을 하나씩 만들어 한 번의 호출로 보내요. 판단 모델이 `none`을 고른 컷은 위치 없음으로 저장해요.

- **기존 경로를 쓰는 경우**: 판단 키가 없거나 선택한 판단 연결을 쓸 수 없을 때, 요청이 판단 API의 토큰 한도를 넘을 때, 번역 문단이 선택지 한도(`none` 포함 255개)를 넘을 때는 요청을 보내지 않고 기존처럼 프롬프트 모델이나 Codex 텍스트 턴이 위치를 정해요.
- **전송 후 실패**: 판단 요청을 보낸 뒤의 HTTP 오류·시간 초과·응답 형식 오류는 작업 실패로 기록하고 프롬프트 모델로 대신 처리하지 않아요. **번역 위치 다시 연결**로 다시 요청할 수 있어요.
- **기록**: 판정 호출은 `illustration-placement` 사용량으로 귀속돼요. 실제 판단 모델의 문단 선택 정확도는 합성 테스트로 확인한 범위가 아니에요.

### Codex 이미지 요청의 사전 판정

이미지 생성 직전에 Codex로 보낼 텍스트(프롬프트 모델이 작성한 프롬프트와 참조 이미지 라벨)를 판단 프로바이더(기본 TypeSafe AI / JEV)로 사전 검사해요. 다듬기를 켠 경우에도 사전 판정의 범위는 이미지 턴에 보내는 텍스트까지예요.

- **판정 기준**: 컷을 묘사한 텍스트에 노골적인 성적 묘사가 필요한지 여부를 `noul` 지표로 판정하며, 점수가 0.9 이상이면 해당 컷의 이미지 요청을 보내지 않고 차단해요. (일반적인 로맨스나 키스, 비노골적인 연출은 일괄 차단 대상이 아니에요.)
- **차단 처리**: `ILLUSTRATION_CODEX_CONTENT_BLOCKED` 오류로 기록되며 자동 재시도 및 동일 입력 수동 재시도를 차단해요. 다른 컷의 작업이나 본문·번역 작업, 기존 성공 이미지는 정상적으로 유지돼요.
- **예외 처리**: 판단 프로바이더 키 미설정, 응답 오류, 8초 시간 초과, 입력 토큰 예산 초과는 `unavailable`로 기록하고 프로바이더의 자체 판단에 맡겨 생성을 계속 진행해요. 판정 호출은 `illustration-content` 사용량으로 귀속돼요.

### ComfyUI 경로 기술 계약

- **실행 순서**: 계획 모델 호출 → 컷별 워크플로의 `{{prompt}}`, `{{negative}}`, `{{seed}}` 치환 → `POST /prompt` → `GET /history/{prompt_id}` 폴링 → `GET /view` 이미지 다운로드.
- **워크플로 검증**: API 형식(`노드 ID → {class_type, inputs}`)만 지원하며 UI 형식(`nodes`/`links`)은 `COMFYUI_WORKFLOW_UI_FORMAT` 오류로 거절해요. 노드 구조는 변경하지 않고 `inputs` 문자열 내의 자리표시자만 1회 치환해요.
- **네트워크와 프록시**: `http://`와 `https://`만 허용하며 주소에 인증 정보나 쿼리를 포함할 수 없어요. 프록시 인증이 필요한 경우 **인증 헤더 환경변수**에 지정된 환경변수 값을 읽어 `Authorization` 헤더로 전달해요. 브라우저는 원격 서버에 직접 접근하지 않아요.
- **타임아웃과 결과 회수**: 요청 시간 초과(`COMFYUI_TIMEOUT`)가 발생해도 원격 서버의 렌더를 강제 중단하지 않아요. 작업은 `prompt_id`를 보존한 채 실패 상태로 남으며, 사용자가 **결과 확인**(`POST /api/illustrations/:id/reconcile`)을 누르면 원격 히스토리를 다시 조회해 완료된 이미지를 가져와요.
- **취소**: 사용자의 명시적 취소 시에만 `POST /api/jobs/{prompt_id}/cancel`을 호출해요. 해당 API가 없으면 `POST /queue` `{delete: [id]}`로 대기열에서만 제거해요. (전역 `/interrupt`는 호출하지 않아요.)
- **실패 진단 코드**: `COMFYUI_PROMPT_REJECTED` (노드 설정 오류), `COMFYUI_EXECUTION_FAILED` (실행 도중 오류), `COMFYUI_SUBMISSION_UNCERTAIN` (접수 불확실, 자동 재제출 금지), `COMFYUI_RESULT_UNAVAILABLE` (접수 후 조회 실패).

### NovelAI 경로 기술 계약

- **요청**: 계획 모델 호출 → 컷마다 `POST https://image.novelai.net/ai/generate-image` 한 번. 본문은 `input`, `model`, `action: "generate"`, `parameters`이고, 장면 프롬프트는 `v4_prompt.caption.base_caption`, 제외 프롬프트는 `negative_prompt`와 `v4_negative_prompt.caption.base_caption`에 넣어요.
- **캐릭터 참조**: 고른 참조마다 이미지를 1024×1536, 1536×1024, 1472×1472 중 비율이 가장 가까운 캔버스에 검은 여백으로 맞춘 PNG로 `director_reference_images`에 넣어요. 설명은 `character`, 정보 추출은 1, 강도는 0.6, 보조 강도는 0이에요. 강도 값은 에셋 메이드의 기본값을 따랐고 화면에서 바꿀 수는 없어요. 프롬프트 모델이 고르지 않았거나 고정 목록에 없는 번호는 보내지 않고, 보낸 장수는 진단의 `novelai.references`에 남아요.
- **인물별 캡션**: `characters`를 같은 순서로 `v4_prompt`와 `v4_negative_prompt`의 `char_captions`에 넣어요. 인물은 최대 6명(V4/V4.5 한도)이고, 넘는 항목은 뒤에서부터 버려요. 모든 인물에 위치가 있을 때만 `use_coords`를 켜고, 일부만 있으면 위치를 모두 비워 NovelAI가 배치하게 해요. 위치는 0.1~0.9로 제한하고, V4/V4.5 모델은 5×5 격자(0.1, 0.3, 0.5, 0.7, 0.9)에, V5는 0.01 단위로 맞춰요. 계획 단계의 공유 인물 외형(`visualCanon`)은 프롬프트 모델 입력으로만 쓰고, 다른 생성기와 달리 장면 프롬프트 뒤에 붙이지 않아요. 붙이면 인물별로 나눈 특징이 다른 인물에게 번지기 때문이에요. 생성 상세에서 인물별 캡션과 위치를 볼 수 있어요. 인증은 `Authorization: Bearer <Persistent API 토큰>`이고 리다이렉트는 따라가지 않아요.
- **응답**: ZIP 안의 첫 이미지(또는 이미지 본문 자체)를 실제 이미지 서명으로 검증해 공통 WebP 저장 경로로 보내요. 사용한 시드는 진단의 `novelai.seed`에 남아요.
- **실패 코드**: `NOVELAI_TOKEN_MISSING`(토큰 없음, 요청 안 보냄), `NOVELAI_UNAUTHORIZED`(401/403), `NOVELAI_ANLAS_INSUFFICIENT`(402), `NOVELAI_BUSY`(429, 같은 계정의 다른 생성), `NOVELAI_REQUEST_REJECTED`(그 밖의 4xx, 모델 ID·크기 확인), `NOVELAI_UNREACHABLE`(연결 전 실패), `NOVELAI_RESULT_UNCERTAIN`(전송 후 시간 초과·연결 끊김·5xx), `NOVELAI_RESPONSE_INVALID`, `NOVELAI_IMAGE_INVALID`. 진단에는 HTTP 상태와 최대 300자의 NovelAI 메시지만 남겨요.
- **불확실한 결과**: NovelAI는 작업 ID를 돌려주지 않아 결과를 다시 조회할 수 없어요. 불확실한 실패도 **다시 요청**은 허용하며, 이때 저장된 프롬프트를 재사용해 이미지 요청만 다시 보내요. 취소하면 연결은 끊지만 NovelAI 쪽 생성은 끝까지 진행될 수 있어요.
- **사전 판정**: Codex 전용 노골성 사전 판정은 적용하지 않아요.

### API 명세

| 경로 | 메서드 | 설명 |
| --- | --- | --- |
| `/api/illustration-settings` | `GET` / `PUT` | 앱 전체 실행 환경과 정책. `PUT`은 `expectedRevision` CAS를 사용해요. 응답의 `novelaiTokenConfigured`는 토큰 저장 여부만 알려 주고, `PUT`의 쓰기 전용 `novelaiToken`은 문자열이면 교체, `null`이면 삭제, 생략하면 유지해요. |
| `/api/illustration-presets` | `GET` | 내장 및 저장된 프리셋 목록과 범위별 선택 상태를 반환해요. |
| `/api/resources/save` | `POST` | 프리셋 저장 (`kind: 'illustration-preset'`). `expectedRevision` 지원. |
| `/api/resources/illustration-preset/:id` | `GET` | 프리셋 단일 항목을 조회해요. |
| `/api/resources/illustration-preset/:id/undo` | `POST` | 직전 저장본으로 되돌려요. |
| `/api/illustration-presets/selection` | `POST` | 범위별 프리셋 선택 (`scope: 'global'/'bot'/'chat'`, `targetId`, `presetId`, `expectedRevision`). |
| `/api/illustration-presets/:id/export` | `GET` | 프리셋을 JSON 파일로 내보내요. |
| `/api/illustration-presets/:id` | `DELETE` | 프리셋을 삭제해요 (`expectedRevision` 필요). |
| `/api/illustration-settings/comfyui/test` | `POST` | ComfyUI 연결을 점검해요 (`GET /system_stats`). |
| `/api/illustration-settings/novelai/test` | `POST` | 저장된 토큰(또는 본문의 `token`)으로 NovelAI 구독 등급을 조회해요. |
| `/api/chats/:id/illustration-references` | `GET` / `PUT` | 채팅별 참조 역할 및 인물 외형 설정. |
| `/api/sources/:id/illustrations` | `POST` | 수동 삽화 계획을 예약해요 (`maxTargets`, `direction` 등 전달). `task: plan` 반환. |
| `/api/sources/:id/illustration-presentation` | `PATCH` | 대표 삽화 타깃 선택을 변경해요. |
| `/api/sources/:id/illustration-usage` | `GET` | 현재 원문의 단계별 삽화 누적 호출 수와 토큰 사용량을 조회해요. |
| `/api/sources/:id/illustration-placement` | `POST` | 기존 컷의 번역 문단 위치 재연결을 요청해요. |
| `/api/illustrations/:id/regenerate` | `POST` | 동일 타깃을 최신 설정으로 다시 그리는 새 작업을 예약해요 (`changeRequest` 지원). |
| `/api/chats/:id/illustrations`, `/api/illustrations/:id` | `GET` | 삽화 목록 및 단일 작업의 고정 입력을 포함한 상세를 조회해요. |
| `/api/illustrations/:id/retry` | `POST` | 실패한 작업의 고정 입력을 그대로 재시도해요. |
| `/api/illustrations/:id/cancel` | `POST` | 진행 중인 삽화 작업을 취소해요. |
| `/api/illustrations/:id` | `DELETE` | 해당 삽화 컷 및 생성 기록을 삭제해요. |
| `/api/illustrations/:id/reconcile` | `POST` | 기록된 ComfyUI `prompt_id`의 원격 결과를 회수해 저장해요. |
| `/api/illustration-images/:id` | `GET` | 영속화된 이미지 바이너리(WebP)를 스트리밍해요. |

테스트 모드(`UIMORI_TEST_MODE=1`)에서는 `/api/test/control`의 barrier·failure point `illustration`과 가상 생성기 `fixture`가 활성화돼요.

### 검증과 테스트

- **단위 및 계약 테스트**:
  - `tests/illustration-research.test.ts`: 고정 native 자료 읽기와 공통 cast 검증
  - `tests/illustration-profiles.test.ts`: 인물 기본 외형 상속 및 CHARX 왕복 보존 검증
  - `tests/illustration-presets.test.ts`: 범위별 선택, 직전 저장 되돌리기, v1 파일 생성기 인식, 고정 작업 입력 검증
  - `tests/illustration-storyboard.test.ts`: 컷 계획 원자성, 중복 실행 방지, 재생성 중 기존본 유지, 번역 위치 연결 검증
  - `tests/illustration-runner.test.ts`: 번역 위치 연결의 판단 모델 선택, `none`, 키 미설정 시 기존 경로, 전송 후 실패
  - `tests/comfyui-client.test.ts`, `tests/codex-image.test.ts`: 각 생성기 클라이언트 및 가상 응답 계약 검증
  - `tests/novelai-illustration.test.ts`: NovelAI 요청 본문·인물별 캡션과 좌표 맞춤·캐릭터 참조 선택과 캔버스 맞춤·잔여 Anlas와 V5 게이지 해석·상태 코드 분류, 토큰 저장 경계, 자동 재시도 0회와 수동 재요청의 프롬프트 재사용 검증 (`fetch` 가로채기, 실제 NovelAI 호출 없음)
  - `tests/illustration-*.test.ts`: 저장, 실행 큐, API 엔드포인트 계약 검증
- **통합 검증 명령어**: `npm run verify:illustration`
  - 대표/문단 배치, 접기 상태 보존, 생성 중 다음 채팅 전송, 재요청, 삭제, 충돌 처리, 새로고침 후 표시 복원을 검증해요.
  - 프리셋 생성·복제·JSON 지침 파일 왕복, 동시 수정 충돌 시 사본 저장, 미저장 편집 보호를 확인해요.
  - ComfyUI 워크플로 오류 포커스 및 모바일/데스크톱 입력 레이아웃을 점검해요.
  - `--visual` 옵션 사용 시 화면 캡처 결과가 보고서에 포함돼요. 검사 기준은 [DEVELOPMENT](DEVELOPMENT.md#verification)를 따라요.

## Input translation

## 구현 경계

- `core/input-translation.ts`: 지원 언어, 입력/컨텍스트 한도, 독립 번역 지침과 표기 선택.
- `server/input-translation.ts`: `POST /api/chats/:id/input-translation`의 읽기·단일 프로바이더 호출. 본문/source/job를 생성하지 않으며 앱 DB에 초안이나 입력 번역 호출 본문을 기록하지 않아요. 공유 프로바이더 어댑터와 인증 경로를 사용해요.
- `web/useInputTranslation.ts`: 작성 화면/초안 수정 번호 식별, 취소, 임시 원문·오래된 결과의 처리.
- `web/useStory.ts`: 기존 초안과 전송 수락 시점 연결. 요청 기록 형식은 변경하지 않아요.
- `web/InputTranslation.tsx`: 입력창 도구와 원문/이전 초안 결과 표시.
- `web/RequestMessage.tsx`: 저장된 요청의 정확한 클립보드 복사. 표시 문자열과 분리해요.

임시 원문은 `sessionStorage`의 `input-translation:<기존 draft 키>`에 보관하며, 목표 언어는 `localStorage`의 `uimori:input-translation-language`에 저장해요. 브라우저 저장소가 제한되면 원문은 활성 편집기 메모리에만 남을 수 있어요. 프로바이더 자체의 기록 정책과 앱의 임시 저장은 별개예요.

## 검증

```sh
npm run quality
npm test -- tests/input-translation.test.ts tests/request-edit.test.ts tests/api-errors.test.ts
npm run build
npm run verify:input-translation
```

서버 검증은 모델/프리셋 분리, 표기와 현재 채팅 컨텍스트, 성공/실패의 DB 비변경, 잘린 결과 거부와 서버 종료 취소를 확인해요. 브라우저 검증은 입력 번역·원문 복구·수정·새로고침·취소·오래된 응답·전송 실패/불확실성·최종 전송문만 남기기·복사 성공/실패를 확인해요. 기존 요청 수정과 Reader 전송 복구 검사도 함께 실행해요. 테스트는 임시 DB, 합성 응답과 로컬 브라우저를 사용해요.
