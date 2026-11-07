# Codex 에이전트 연결

Uimori 서버에서 공식 Codex CLI의 App Server를 실행하고 개인 ChatGPT 구독 계정으로 로그인해 사용하는 연동 안내예요.

- **프로토콜 및 주소**: 프로토콜은 `codex-app-server-v1`, 프로바이더 접속 주소는 고정값 `codex://local`을 사용해요.
- **지원 역할**: 본문 집필, 번역, 컨텍스트 정리, 도우미, 카드 스크립트 보조에서 동일한 Codex 모델 프리셋을 지정해 활용할 수 있어요.
- **이미지 및 삽화 처리**: 등록된 이미지의 본문 배치는 별도의 TypeSafe JEV가 담당해요. Codex의 공식 이미지 생성 도구는 **설정 → 삽화**의 장면 삽화 생성에서만 사용하며, 텍스트 판단 턴에는 `features.image_generation=false`를 명시해요. 자세한 삽화 규약은 [장면 삽화](ILLUSTRATIONS.md)를 참고해 주세요.

---

## 준비와 로그인 절차

### 1. Codex CLI 설치 및 버전 확인
서버 환경에 공식 Codex CLI를 설치해요.
- **요구 버전**: 기본 연결은 **0.153.0 이상**을 요구하며, 본문·조언자·도우미의 native 도구 프로토콜은 **0.158.0**에서 생성한 experimental schema를 기준으로 검증되었어요.
- 설치 및 업데이트 후에는 문서 하단의 사전 검사 명령어로 해당 바이너리의 동작을 확인해 주세요.

### 2. 서버 환경변수 설정
서버 환경에 다음 변수를 설정하고 Uimori 앱을 시작해요 (기본값은 비활성화 상태예요).
- `UIMORI_CODEX_ENABLED=1`: Codex 연동을 활성화해요.
- 시스템 PATH의 실행 파일 및 일반적인 npm 전역 설치 경로를 자동으로 탐색해요. 자동 탐색이 되지 않으면 `UIMORI_CODEX_EXECUTABLE`에 실제 `codex` (Windows의 경우 `codex.exe`) 바이너리의 절대 경로를 직접 지정해요.
- `.cmd`, `.bat`, `.ps1` 래퍼 스크립트나 임의의 명령 문자열은 보안상 허용되지 않아요.

### 3. ChatGPT 디바이스 로그인
1. 브라우저에서 **설정 → Codex 연결**로 이동해요.
2. **ChatGPT로 Codex 로그인** 버튼을 눌러요.
3. 화면에 표시된 인증 코드를 OpenAI 공식 디바이스 인증 페이지(`https://auth.openai.com/codex/device`)에 직접 입력해요.
4. 로그인은 서버의 공식 Codex 프로세스가 직접 처리해요. 계정에서 device-code 로그인이 허용되어 있어야 하며, 토큰 직접 붙여넣기나 기존 로컬 CLI 로그인 가져오기 기능은 제공하지 않아요.

### 4. 모델 프리셋 등록 및 배정
1. **설정 → 프로바이더와 모델**로 이동해 **Codex · ChatGPT 구독** 프로바이더를 저장해요.
2. 모델 목록을 조회한 후 원하는 모델 프리셋을 저장해요 (모델 목록 조회 시에는 생성 요청이 발생하지 않아요).
3. 각 기능의 모델 선택 화면에서 해당 Codex 프리셋을 지정해요.

### 다중 기기 공유 및 연결 해제
- **서버 단위 연동**: 연결 상태는 개별 브라우저가 아니라 Uimori 서버에 저장돼요. PC와 모바일 브라우저 모두 같은 서버의 단일 Codex 로그인과 구독 한도를 함께 공유해요 (다중 사용자 구독 중계 서비스로는 설계되지 않았어요).
- **구독 상태 조회**: 연결 화면에서는 공식 `account/rateLimits/read`가 반환하는 구독 사용량과 사용 가능한 크레딧을 실시간으로 표시해요. 크레딧 정보가 없으면 해당 행을 생략하고, 잔액 수치가 없으면 사용 가능 여부만 표시해요 (조회 시 모델 생성이나 결제가 발생하지 않음). 연결 완료 화면은 공식 계정 한도의 최근 조회값과 윈도 길이를 사용해 남은 비율·초기화 시각을 표시하며, 연결 전의 단계 안내는 완료 후 접어 상태 카드로 대체해요.
- **연결 해제**: **Codex 연결 해제**를 누르면 진행 중인 Codex 작업과 대기열을 즉시 중단하고 Uimori 전용 로그인을 해제해요.

---

## 개인 서버 및 Docker 환경 구성

Docker Compose 환경에서는 `.env.self-host` 파일에 환경변수를 추가하고 앱 이미지를 다시 빌드해요 (기본 배포 이미지는 용량 최적화를 위해 Codex CLI를 포함하지 않아요).

```dotenv
UIMORI_CODEX_VERSION=latest
UIMORI_CODEX_ENABLED=1
```

```sh
docker compose --env-file .env.self-host build app
docker compose --env-file .env.self-host up -d
```

- **버전 지정 방식**: `latest`는 npm의 stable dist-tag를 의미해요. 완전한 빌드 재현성을 확보하려면 `0.153.0`처럼 구체적인 버전 번호를 직접 고정할 수도 있어요.
- **Oracle 배포 러너**: 배포마다 `latest` 버전을 조회한 뒤 `0.157.1` 같은 실제 버전 번호로 고정해 이미지를 빌드하고 image label과 배포 기록에 남겨요. 따라서 다음 배포 시 새로운 stable 버전을 자동으로 반영하되, 기존 이미지와 롤백 대상은 유지돼요.
- **인증 파일 보관 경로**: Compose 환경에서는 `/data` 볼륨 내에 DB와 별도로 `/data/uimori.sqlite.codex` 디렉터리가 생성되어 전용 로그인 세션이 보관돼요. 일반 호스트 실행에서도 `UIMORI_DB` 절대 경로 뒤에 `.codex`를 붙인 디렉터리를 사용해요.
- **백업 주의사항**: JSON 내보내기와 SQLite DB 백업에는 Codex 인증 파일이 포함되지 않아요. 서버를 이전할 때는 새 서버에서 다시 로그인해야 해요. 서버 파일 백업에 이 디렉터리를 포함할 경우 민감한 인증 자료로 취급해 보호해야 해요.
- **환경 조건**: 단일 앱 프로세스, HTTPS 보안 접속 및 인증 접근 조건이 필요해요.

---

## 실행 한도와 주요 정책 요약

| 항목 | 한도 및 동작 정책 |
| --- | --- |
| **일반 텍스트 동시 실행** | 최대 **2개**까지 동시에 진행해요. |
| **요청 대기열 (Queue)** | 최대 **32개**까지 대기 가능하며 언제든 취소할 수 있어요. |
| **자식 조언자 전용 슬롯** | 메인 작가나 도우미가 호스트 조언·컨텍스트 정리를 기다리는 동안 전용 슬롯 **1개**를 제공해요. 두 일반 슬롯이 모두 차 있어도 자식 호출이 시작될 수 있어요. |
| **삽화 동시 실행** | 삽화 생성은 별도의 독립 슬롯 **1개**를 사용해요. |
| **도우미 작업 한도** | 호스트 기준 도우미 요청 64회, 전체 모델 요청 128회, 도구 콜백 256회, 최대 20분의 실행 시간 한도를 적용해요 (Codex 내부 모델 판단 수나 금액 상한을 뜻하지 않음). |
| **웹 검색 (Web Search)** | 도우미는 `web_search=live`, 기타 텍스트 역할은 `web_search=cached`를 사용해요. 최신 웹 정보는 출처가 확인된 경우에만 답변에 인용해요 ([도우미 검색과 단가](HELPER-TOOLS.md#web-search-and-model-pricing)). |
| **삽화 생성 턴** | JEV 컷별 사전 판정을 거쳐 `features.image_generation=true`로 실행하며 검색과 Code Mode는 비활성화해요 ([장면 삽화](ILLUSTRATIONS.md#codex-이미지-요청의-jev-사전-판정)). |

---

## 구현 참고

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
- **컨텍스트 및 도구 전달**: 메인 작가는 `buildMainProviderRequest` 및 `editRequest` 결과의 역할·순서·원문·로어·구성·사전 결과를 그대로 유지하고 도구 스키마만 native 도구 등록으로 전달해요. 조언자는 전용 요청·모델·지침·명시적 초안/근거를 사용하며 작가의 전체 프롬프트를 무단 복사하지 않아요. 기존 `agents.consult` 계약을 유지하며 조언자가 다시 하위 조언자를 호출하거나 본문을 저장하지 못해요. 사전 조언은 기존 순서대로 실행해요.
- **제출 감지와 조기 종료**: 작가의 `story.submit` 또는 유효한 `eval_submit_artifact` 도구 호출이 확인되면 일반 도구 응답을 보내지 않고 즉시 `turn/interrupt`를 호출하고 프로세스를 정리해요. 호스트가 확정한 해당 제출만 성공으로 처리하며, 사용자 취소·timeout·접속 변경·기록 실패는 성공으로 바꾸지 않아요. 새 확인 문장을 요청하지 않고 원문 저장은 기존 JEV 판정·응답 후처리·원자적 완료 경로에서 수행해요. 평가 도구가 꺼진 본문은 일반 최종 텍스트도 지원하고, 평가가 켜진 `model-selected`·`preloaded`는 모두 유효한 `eval_submit_artifact`가 필요해요. 본문·조언자 스트리밍은 추가하지 않아요. 호스트 제출 종료의 usage는 `completion: host-submission`, `usageComplete: false`를 남겨 최종 청구량으로 오해하지 않게 해요.
- **컨텍스트 계획 및 근거 기록**: native 실행 중에는 Uimori가 도구마다 프롬프트를 다시 만들거나 별도 컨텍스트 압축을 중복 실행하지 않아요. `editRequest`는 실제 호스트 요청 시작 때만 실행하므로 내부 추론마다 실행되는 훅이 아니에요. 초기 컨텍스트 계획은 기존/네이티브 입력 중 큰 추정치를 사용해 절약형 첫 단계에서도 재사용하고 전송 직전에 실제 native descriptor로 다시 확인해요. 초기 입력의 `requestLore`와 이후 `tool_events` 및 조언자의 `agents.read`는 별도 근거이며 뒤에 읽은 자료를 초기 입력에 포함됐다고 소급 기록하지 않아요.
- **호스트 콜백 및 호출 한도**:
  - 호출 한도는 호스트가 시작한 요청 및 native 실행 건수를 기준으로 계산돼요 (내부 추론 횟수와 일치하지 않으며 읽기 도구마다 모델 호출 1회를 추가하지 않음).
  - 조언 캐시는 재청구하지 않으며 JEV·별도 조언 실행은 각각 집계해요. 진행 중인 native 작가는 조언 뒤 같은 turn에서 계속 쓰므로 다음 작가 호출을 예약하지 않지만, 사전 조언과 기존 프로바이더 루프는 작가 호출 1회를 남겨요 (후처리용 예약 유지).
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
