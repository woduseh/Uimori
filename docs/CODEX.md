# Codex 에이전트 연결

Uimori 서버에서 공식 Codex CLI의 App Server를 실행하고 개인 ChatGPT 구독으로 로그인해요. 프로토콜은 `codex-app-server-v1`, 프로바이더 주소는 고정값 `codex://local`이에요. 본문·번역·장면 상태 표시·이미지 작업 지시·상태 계산·문맥 정리·도우미에서 같은 Codex 모델 프리셋을 선택할 수 있어요. 이미지 역할은 기존 Uimori의 이미지 작업 지시(배치)를 만들어요. Codex의 공식 이미지 생성 도구는 **설정 → 삽화**의 장면 삽화 생성에서만 사용하며, 텍스트 판단 턴에는 `features.image_generation=false`를 명시해요. 삽화 턴의 계약은 [장면 삽화](ILLUSTRATIONS.md)를 봐요.

## 준비와 로그인

1. 서버에 공식 Codex CLI를 설치해요. 기본 연결은 **0.153.0 이상**을 요구하며, 본문·조언자·도우미의 native 도구 프로토콜은 실제 배포된 **0.158.0**에서 생성한 experimental schema로 확인했어요. 이전 버전의 native 도우미 호환성까지 검증한 것은 아니에요. 설치·업데이트 후 아래 사전 검사로 해당 바이너리의 계약을 확인하세요.
2. 서버 환경에 `UIMORI_CODEX_ENABLED=1`을 설정하고 앱을 시작해요. 기본값은 비활성이에요. PATH의 네이티브 실행 파일과 일반적인 npm 설치를 탐색해요. 자동 탐색이 안 되면 `UIMORI_CODEX_EXECUTABLE`에 실제 `codex`/`codex.exe`의 절대 경로를 지정해요. `.cmd`, `.bat`, `.ps1` 래퍼나 명령 문자열은 허용하지 않아요.
3. **설정 → Codex 연결 → ChatGPT로 Codex 로그인**을 눌러요. 표시된 코드를 공식 `https://auth.openai.com/codex/device` 페이지에 직접 입력해요. 로그인은 공식 Codex 프로세스가 처리해요. 계정에서 device-code 로그인을 허용해야 하며 Uimori는 토큰 붙여넣기나 기존 CLI 로그인 가져오기를 제공하지 않아요.
4. **프로바이더·모델 등록**에서 **Codex · ChatGPT 구독** 프로바이더를 저장하고 모델 목록을 조회해 프리셋을 저장해요. 각 기능의 모델 선택에서 해당 프리셋을 선택해요. 모델 목록 조회는 생성 요청을 보내지 않아요.

연결은 브라우저가 아닌 서버에 속해요. PC·휴대폰은 같은 Uimori 로그인과 같은 서버 Codex 구독 한도를 사용해요. 다중 사용자 구독 중계 서비스로 설계하지 않았어요. **Codex 연결 해제**는 진행 중인 Codex 작업과 대기를 중단하고 Uimori 전용 로그인을 해제해요. 이미 공급자에서 시작한 작업의 처리·사용량까지 되돌린다는 뜻은 아니에요.

## 개인 서버 / Docker

`.env.self-host`에 다음을 추가하고 앱 이미지를 다시 빌드해요. 기본 이미지는 Codex를 설치하지 않아요.

```dotenv
UIMORI_CODEX_VERSION=latest
UIMORI_CODEX_ENABLED=1
```

```sh
docker compose --env-file .env.self-host build app
docker compose --env-file .env.self-host up -d
```

이 선택적 빌드는 npm에서 지정한 공식 CLI 버전을 받아요. `latest`는 npm의 stable dist-tag를 뜻해요. Oracle 배포 러너는 배포마다 `latest`를 조회한 뒤 `0.157.1` 같은 실제 버전 번호로 고정해서 이미지를 만들고 그 번호를 image label과 배포 기록에 남겨요. 따라서 다음 배포에서는 새 stable을 자동으로 따라가지만 이미 만들어진 이미지와 롤백 대상은 바뀌지 않아요. 완전한 재현성을 우선하면 `0.153.0`처럼 버전을 직접 고정해도 돼요. 일반 Compose 빌드에서도 `latest`를 사용할 수 있지만 Oracle 러너처럼 별도의 해석 기록은 남기지 않아요. Compose의 `/data` volume에 DB와 별도로 전용 로그인 디렉터리 `/data/uimori.sqlite.codex`가 유지돼요. 일반 실행도 `UIMORI_DB`의 절대 경로 뒤에 `.codex`를 붙인 디렉터리를 사용해요. JSON 내보내기와 SQLite 백업에는 Codex 인증 파일이 포함되지 않아요. 서버를 옮기면 새 서버에서 다시 로그인하세요. 서버 파일 백업에 이 디렉터리를 포함한다면 인증 자료로 보호해야 해요. 기본 Compose의 단일 앱 프로세스, HTTPS, 접근 인증 조건을 유지해요.

Linux Docker의 실제 이미지 빌드·기동과 실계정 로그인·구독 모델 실행은 이 구현의 로컬 합성 검사로 확인되지 않아요.

## 실행 계약과 한계

- App Server `initialize`, `account/*`, `model/list`, `thread/start`, `turn/start`를 사용해요. 실제 본문 Run의 Codex 작가·Codex 조언자·도우미는 각각 **작업 하나를 하나의 thread/turn**에서 끝까지 실행하고 도구 결과를 같은 턴에 돌려줘요. 번역·상태 계산·문맥 정리와 도우미의 독립 가정 장면은 기존 요청별 ephemeral 실행을 유지해요. 본문 평가의 `preloaded + economized` 첫 단계만 기존 low 요청으로 처리한 뒤 원래 추론 수준의 native 작문으로 이어가요. 작업 간 native thread 재개 정보나 opaque continuation은 저장하지 않아요.
- 일반 텍스트 실행은 기본 2개까지 동시에 진행해요. native 작가·도우미가 호스트 도구의 조언·본문 생성·문맥 정리를 기다리는 동안에는 그 도구 안의 Codex 텍스트 및 native 조언 호출에 전용 슬롯 1개를 제공해요. 두 도우미가 일반 슬롯을 모두 점유해도 자식 호출이 시작할 수 있고, 자식끼리는 순서대로 실행해요. 독립 작업은 이 슬롯을 사용하지 않으며 대기 중 취소·인증 변경·서버 종료 경계도 동일하게 적용해요.
- 텍스트 역할은 `thread/start.baseInstructions`로 짧은 Uimori 작문·번역·요약 지침을 지정해 모델의 기본 코딩 지침을 대체해요. 도우미(`helper`)는 자료 조회·편집과 저장 결과 확인에 맞는 전용 지침을 사용해요. 초기 요청에 작업·이전 대화·자료 범위와 등록된 도구를 전달해요. 도우미의 초기 이력이 입력 예산을 넘으면 Uimori가 시작 전에 문맥 정리를 수행할 수 있어요. native 턴이 시작된 뒤 도구 결과를 받을 때마다 Uimori가 이력을 다시 묶거나 새 턴을 만들지는 않으며, 턴 내부 진행·문맥 정리는 Codex가 담당해요. 로컬 입력 추정에는 Codex 내부 도구 설명과 추가 문맥이 모두 포함되지는 않으므로 실제 공급자 입력 토큰과 차이가 있을 수 있어요.
- 전용 Codex home과 빈 임시 작업 폴더를 사용해요. 기존 사용자 home/config와 서버의 provider API 키 환경변수를 넘기지 않아요. `environments: []`, `selectedCapabilityRoots: []`, read-only/never 정책은 유지해요. 내장 도구 전체 금지는 제거하고 `web_search=cached`와 `features.code_mode=true`로 검색과 격리된 JavaScript 계산을 사용할 수 있게 해요. Code Mode에서는 기본 `functions` namespace를 제외해 셸·파일 계열 도구가 중첩 실행 경로로 다시 노출되지 않게 하고, Uimori 호스트 도구는 별도 `uimori` namespace로만 등록해요. 실제 도구 제공 여부는 설치된 CLI·모델에 따라 달라요.
- 번역 등 기존 역할은 JSON envelope로 최종 응답 또는 도구 요청을 반환해요. 본문·조언자·도우미의 native 실행은 이 envelope 대신 experimental `dynamicTools`의 `uimori` namespace 아래 `type: "function"` 도구를 등록하고 `item/tool/call` 요청에 `contentItems`/`success`를 응답해요. 도구 이름은 Responses API 제약에 맞는 `uimori_…` 이름으로 전송하고 호스트에서는 원래 이름으로 복원해요. 호스트는 현재 thread/turn뿐 아니라 `uimori` namespace까지 일치하는 호출만 받아요. Uimori 자료 조회·검증·저장은 기존 호스트 도구가 담당하며 원문/hash/revision·취소·작업 귀속 계약을 유지해요. 도우미 최종 응답은 일반 텍스트예요. `final_answer`의 공개 텍스트를 스트리밍하고 commentary는 별도 진행 이벤트로 기록해 최종 답변과 섞지 않아요. 내장 검색·계산의 중간 결과와 계획은 본문으로 저장하지 않아요. phase가 없는 구형 응답은 후속 작업이 없을 때 마지막 메시지를 최종 후보로 사용해요.
- 삽화 턴은 짧은 이미지 전용 base instructions와 `features.image_generation=true`를 사용하고 검색·code mode는 비활성화해요. 선택한 모델·추론 수준·참고 이미지와 역할 순서는 유지하며 `imageGeneration` 결과의 base64 또는 전용 home의 `savedPath` 파일만 읽어요. 텍스트 턴에는 이미지 결과의 예약·귀속·저장 계약이 없으므로 이미지 생성은 계속 삽화 전용이에요. 삽화는 별도 동시 실행 슬롯(1개)을 써요.
- RisuPrompt의 논리적 역할·순서·빈 메시지를 JSON으로 전달해요. 메시지 ID·출처 종류·원문 revision/hash는 유지하며 호스트 내부 block/run ID와 항상 완료된 메시지의 중복 상태는 모델 입력에서 제외해요. 현재 user 메시지 하나가 요청 본문과 정확히 같을 때만 별도 `input.task` 중복을 생략해요. Codex 자체 지침이 추가되므로 native API message role과 동일한 처리는 보장하지 않아요. assistant prefill과 필수 cache는 실행 전에 거절해요.
- `reasoningEffort`와 timeout을 전달해요. 일반 역할의 `maxOutputTokens`는 Codex 입력의 `outputTokenBudget`으로 전달하는 소프트 용량 예산이에요. 요청된 응답 길이나 공급자의 강제 상한이 아니며, 이 값을 채우려고 출력을 늘리지 않아요. 프롬프트에 단어 수 같은 명시적 분량 지시가 있으면 그 지시를 우선해요. temperature는 허용하지 않아요. 일반 역할의 구조화 출력과 내부 역할별 결과 검증은 유지하며, native 도우미에는 최종 JSON envelope나 `outputSchema`를 강제하지 않아요.
- 전송 전에 RPC attempt를 기록해요. 동시 실행은 2개, 대기는 최대 32개이며 취소할 수 있어요. Uimori는 재시작·전송 실패·불확실한 실행을 자동 재생하지 않아요. 다만 공식 CLI 내부의 통신 재시도 정책은 Uimori가 제어하지 못해요. 0.153은 내장 OpenAI provider의 retry 설정 덮어쓰기를 거절하므로 내부 재시도 0회나 upstream exactly-once는 보장하지 않아요. 기존 하네스의 명시적 재요청 및 정상 종료된 결과에 대한 제한된 재시도는 별도 판단 요청으로 기록돼요.
- 한 attempt는 호스트가 시작한 Codex 턴 하나이며 내부 모델 호출 수와 같지 않아요. native 도우미는 여러 도구·모델 판단을 수행해도 한 attempt로 기록하고, 시작 전 문맥 정리 호출은 별도예요. 도우미의 호출 예산·사용량에 기록되는 호스트 요청 횟수는 내부 샘플링 횟수의 상한이나 측정값이 아니에요. 실제 비용과 내부 모델 호출 수는 `null`로 남기고, 턴 전체 timeout·취소와 호스트 도구 권한을 적용해요. Vertex의 USD 예산을 Codex 구독 예산으로 해석하지 않아요. 연결 완료 화면은 공식 계정 한도의 최근 조회값과 윈도 길이를 사용해 남은 비율·초기화 시각을 표시하며, 연결 전의 단계 안내는 완료 후 접어 상태 카드로 대체해요.
- 공급자가 보고한 `tokenUsage.total`과 `last`의 입력·캐시·출력·추론 토큰은 숫자만 raw usage에 보존해요. 입력·출력 합계는 가장 최근 total 스냅샷으로 갱신하며, 반복된 업데이트나 캐시 토큰을 다시 더하지 않아요. 공급자가 주지 않은 수치는 0으로 채우지 않아요. 삽화 raw usage에는 완료 항목 종류별 횟수(`itemCounts`)와 사용량 이벤트 횟수(`tokenUsageUpdates`)도 보존해요. 이 진단 숫자는 내부 모델 호출 수를 뜻하지 않으며 이미지 바이트나 도구 내용은 포함하지 않아요.

### 본문과 조언의 native 실행

새 provider나 사용자 전환 스위치 없이 실제 본문 Run에서 선택한 Codex 작가·조언자에 적용해요. 메인이 다른 공급자여도 Codex 조언자는 native 실행을 사용해요. 메인은 기존 `buildMainProviderRequest`와 `editRequest` 결과의 역할·순서·원문·로어·구성·사전 결과를 유지하고 도구 schema만 native 등록으로 옮겨요. 조언자는 기존 전용 요청·모델·지침·명시적 초안/근거를 사용하며 작가의 전체 프롬프트를 복사하지 않아요. 기존 `agents.consult`는 유지하고 조언자가 다시 조언자를 만들거나 본문을 저장하게 하지 않아요. 사전 조언은 기존 순서대로 실행해요.

작가의 `story.submit` 또는 유효한 `eval_submit_artifact`를 기존 처리로 접수하면 일반 도구 응답을 보내지 않고 `turn/interrupt`와 프로세스 정리로 종료해요. 호스트가 확정한 해당 제출만 로컬 성공으로 반환하며 사용자 취소·timeout·접속 변경·기록 실패는 성공으로 바꾸지 않아요. 새 확인 문장을 요청하지 않고 원문 저장은 기존 JEV 판정·응답 후처리·원자적 완료 경로에서 수행해요. 일반 최종 텍스트도 지원하며 본문·조언자 스트리밍은 추가하지 않아요. 호스트 제출 종료의 usage는 `completion: host-submission`, `usageComplete: false`를 남겨 최종 청구량으로 오해하지 않게 해요.

Native 실행 중에는 Uimori가 도구마다 프롬프트를 다시 만들거나 별도 문맥 압축을 중복 실행하지 않아요. `editRequest`는 실제 호스트 요청 시작 때만 실행하므로 내부 추론마다 실행되는 훅이 아니에요. 초기 문맥 계획은 기존/네이티브 입력 중 큰 추정치를 사용해 독립 장면·절약형 첫 단계와 함께 재사용하고, 전송 직전에는 실제 native descriptor로 다시 확인해요. 초기 입력의 `requestLore`와 이후 `tool_events` 및 조언자의 `agents.read`는 별도 근거예요. 뒤에 읽은 자료를 초기 입력에 포함됐다고 소급 기록하지 않아요.

호출 한도는 호스트가 시작한 요청/native 실행 건수예요. 내부 추론 횟수는 미확인이고 읽기 도구마다 모델 호출 1회를 추가하지 않아요. 조언 캐시는 재청구하지 않으며 JEV·별도 조언 실행은 각각 집계해요. 진행 중인 native 작가는 조언 뒤 같은 turn에서 계속 쓰므로 다음 작가 호출을 예약하지 않지만, 사전 조언과 기존 공급자 루프는 작가 호출 1회를 남겨요. 후처리용 예약은 유지해요. 평가 `maximumToolRounds`는 native 본문에서는 비최종 도구 교환 한도이며 정상 최종 제출은 별도로 받아요. 기존 HTTP 라운드와 내부 추론 횟수와는 다른 단위예요.

합성 stdio 통합은 `tests/codex-writing.test.ts`에서 작성·조언·캐시·자식 슬롯·취소·제출·절약형 전환을 확인해요. 실제 모델의 후속 생성 여부·사용량·품질 개선은 별도 실계정 검증이 필요해요.

### 내장 도구의 남은 경계

터미널·파일 읽기/쓰기·Node REPL·로컬 이미지 보기·브라우저/컴퓨터 제어·앱/MCP·외부 스킬·지속 메모·내장 하위 에이전트·추가 권한 요청은 제공하지 않아요. 이들은 호스트 파일·인증·외부 변경 권한, Uimori의 저장·협업·문맥 관리와 연결되므로 검색·계산과 같은 범위가 아니에요. `code_mode`는 Node REPL과 다른 V8 JavaScript 실행기예요. 등록된 도구만 호출하고 Node·파일·네트워크 API 및 모듈 import를 제공하지 않는 계약을 사용해요. native 도우미에 등록된 Uimori 도구도 호스트의 자료 범위·검증·저장 권한을 그대로 거쳐요. 서버는 현재 thread/turn과 등록된 도구 이름만 받아들이고 중복 call ID를 거절해요. 지원하지 않는 승인 요청·미등록 도구·호스트 환경 도구 이벤트는 실패 처리해요. 취소된 작업의 늦은 도구 결과는 전달하지 않고, 호스트 쓰기 중 던져진 오류는 재시도를 유도하는 도구 결과로 바꾸지 않아요.

read-only만으로는 서버 파일과 전용 인증 파일의 읽기를 격리하지 못하므로 환경 도구는 별도 실행 환경·읽기 범위 없이는 제공하지 않아요. 실행 설정과 이벤트 경계는 `core/codex-protocol.ts`, `server/codex-runtime.ts`에서 관리해요. `code_mode` 설정을 허용해도 설치 패키지의 실행기 제공 여부에 따라 실제 계산이 불가능할 수 있어요. 합성 stdio 검사는 설치 CLI의 도구 실행이나 플랫폼 sandbox 실증을 대신하지 않아요.

## 로컬 검증

```powershell
npx vitest run tests/codex-process.test.ts tests/codex-runtime.test.ts tests/codex-protocol.test.ts tests/codex-image.test.ts tests/codex-integration.test.ts
# 설치된 CLI 초기화와 experimental 도구 schema 확인: 새 빈 인증 폴더, 로그인/모델 호출 없음
$env:UIMORI_CODEX_PREFLIGHT='1'
npx vitest run tests/codex-installed.test.ts
Remove-Item Env:UIMORI_CODEX_PREFLIGHT
```

설치 사전 검사 결과는 `output/codex-preflight/summary.json`에 남아요. 실제 바이너리 버전과 빈 인증 상태를 기록하고 `generate-json-schema --experimental`에서 `dynamicTools`의 function 형식, `item/tool/call` 요청, 텍스트 도구 응답 계약을 확인해요. schema 적합성은 실제 모델의 도구 선택·실행 성공과는 별도예요. 합성 stdio 검사는 인증 취소·오류 가림·정상 이벤트·시간 초과·종료 경합·내장 도구 진행과 최종 응답 분리·환경/승인 경계·대기 취소·attempt 선기록·한 턴 안의 연속 도구 호출·중복 호출 차단·취소 후 늦은 응답을 확인해요. 앱 통합 검사는 일반 역할과 native 도우미, 등록 제안, export/import, 비활성 프로바이더 및 인증/Origin 경계를 확인해요. `npm run verify:providers`에는 390px의 Codex 설정·모의 로그인·취소·연결 해제 검사가 포함돼요. 이 검사들은 실제 구독 모델 응답 품질·소모량을 입증하지 않아요.

공식 계약: [App Server](https://learn.chatgpt.com/docs/app-server), [인증](https://learn.chatgpt.com/docs/auth), [설정 schema](https://learn.chatgpt.com/config-schema.json).
