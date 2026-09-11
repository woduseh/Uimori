# Codex 에이전트 연결

Uimori 서버에서 공식 Codex CLI의 App Server를 실행하고 개인 ChatGPT 구독으로 로그인해요. 프로토콜은 `codex-app-server-v1`, 프로바이더 주소는 고정값 `codex://local`이에요. 본문·번역·장면 상태 표시·이미지 작업 지시·상태 계산·문맥 정리·도우미에서 같은 Codex 모델 프리셋을 선택할 수 있어요. 이미지 역할은 기존 Uimori의 이미지 작업 지시(배치)를 만들어요. Codex의 공식 이미지 생성 도구는 **설정 → 삽화**의 장면 삽화 생성에서만 사용하며, 텍스트 판단 턴에는 `features.image_generation=false`를 명시해요. 삽화 턴의 계약은 [장면 삽화](ILLUSTRATIONS.md)를 봐요.

## 준비와 로그인

1. 서버에 공식 Codex CLI **0.153.0 이상**을 설치해요. 현재 프로바이더 계약은 설치된 0.153.0에서 생성한 공식 schema를 기준으로 구현했어요. 버전을 올릴 때는 아래 사전 검사를 다시 실행하세요.
2. 서버 환경에 `NR_CODEX_ENABLED=1`을 설정하고 앱을 시작해요. 기본값은 비활성이에요. PATH의 네이티브 실행 파일과 일반적인 npm 설치를 탐색해요. 자동 탐색이 안 되면 `NR_CODEX_EXECUTABLE`에 실제 `codex`/`codex.exe`의 절대 경로를 지정해요. `.cmd`, `.bat`, `.ps1` 래퍼나 명령 문자열은 허용하지 않아요.
3. **설정 → 에이전트 → ChatGPT로 Codex 로그인**을 눌러요. 표시된 코드를 공식 `https://auth.openai.com/codex/device` 페이지에 직접 입력해요. 로그인은 공식 Codex 프로세스가 처리해요. 계정에서 device-code 로그인을 허용해야 하며 Uimori는 토큰 붙여넣기나 기존 CLI 로그인 가져오기를 제공하지 않아요.
4. **프로바이더·모델 등록**에서 **Codex · ChatGPT 구독** 프로바이더를 저장하고 모델 목록을 조회해 프리셋을 저장해요. 각 기능의 모델 선택에서 해당 프리셋을 선택해요. 모델 목록 조회는 생성 요청을 보내지 않아요.

연결은 브라우저가 아닌 서버에 속해요. PC·휴대폰은 같은 Uimori 로그인과 같은 서버 Codex 구독 한도를 사용해요. 다중 사용자 구독 중계 서비스로 설계하지 않았어요. **Codex 연결 해제**는 진행 중인 Codex 작업과 대기를 중단하고 Uimori 전용 로그인을 해제해요. 이미 공급자에서 시작한 작업의 처리·사용량까지 되돌린다는 뜻은 아니에요.

## 개인 서버 / Docker

`.env.self-host`에 다음을 추가하고 앱 이미지를 다시 빌드해요. 기본 이미지는 Codex를 설치하지 않아요.

```dotenv
UIMORI_CODEX_VERSION=0.153.0
NR_CODEX_ENABLED=1
```

```sh
docker compose --env-file .env.self-host build app
docker compose --env-file .env.self-host up -d
```

이 선택적 빌드는 npm에서 지정한 공식 CLI 버전을 받아요. Compose의 `/data` volume에 DB와 별도로 전용 로그인 디렉터리 `/data/narrative.sqlite.codex`가 유지돼요. 일반 실행도 `NR_DB`의 절대 경로 뒤에 `.codex`를 붙인 디렉터리를 사용해요. JSON 내보내기와 SQLite 백업에는 Codex 인증 파일이 포함되지 않아요. 서버를 옮기면 새 서버에서 다시 로그인하세요. 서버 파일 백업에 이 디렉터리를 포함한다면 인증 자료로 보호해야 해요. 기본 Compose의 단일 앱 프로세스, HTTPS, 접근 인증 조건을 유지해요.

Linux Docker의 실제 이미지 빌드·기동과 실계정 로그인·구독 모델 실행은 이 구현의 로컬 합성 검사로 확인되지 않아요.

## 실행 계약과 한계

- App Server `initialize`, `account/*`, `model/list`, `thread/start`, `turn/start`를 사용해요. 각 판단 요청은 새 ephemeral thread와 별도 프로세스로 실행하며 opaque continuation은 저장하지 않아요.
- 전용 Codex home과 빈 임시 작업 폴더를 사용해요. 기존 사용자 home/config와 서버의 provider API 키 환경변수를 넘기지 않아요. `environments: []`, `selectedCapabilityRoots: []`, read-only/never 정책은 유지해요. 내장 도구 전체 금지는 제거하고 `web_search=cached`와 `features.code_mode=true`로 검색과 격리된 JavaScript 계산을 사용할 수 있게 해요. 실제 도구 제공 여부는 설치된 CLI·모델에 따라 달라요.
- Codex는 JSON으로 최종 응답 또는 허용된 Uimori 도구 요청을 반환해요. Uimori 자료 조회·검증·저장은 기존 하네스가 담당하고, 내장 도구 이름을 이 JSON에 넣어 실행시키지는 않아요. 각 역할의 기존 원문/hash/revision·취소·작업 귀속 계약을 유지해요. 내장 검색·계산의 중간 결과, 계획, 진행 메시지는 본문으로 저장하지 않으며 `final_answer`만 채택해요. phase가 없는 구형 응답은 후속 작업이 없을 때 마지막 메시지를 최종 후보로 사용해요.
- 삽화 턴은 같은 검색·계산 도구에 `features.image_generation=true`를 더해 `imageGeneration` 항목을 받아요. 결과 base64 또는 전용 home의 `savedPath` 파일만 읽어요. 텍스트 턴에는 이미지 결과의 예약·귀속·저장 계약이 없으므로 이미지 생성은 계속 삽화 전용이에요. 삽화는 별도 동시 실행 슬롯(1개)을 써요.
- PromptProgram의 논리적 역할·순서·빈 메시지를 JSON으로 전달해요. Codex 자체 지침이 추가되므로 native API message role과 동일한 처리는 보장하지 않아요. assistant prefill과 필수 cache는 실행 전에 거절해요.
- `reasoningEffort`와 timeout을 전달해요. `maxOutputTokens`는 출력 목표이며 공급자의 강제 토큰 한도가 아니에요. temperature는 허용하지 않아요. 구조화 출력은 항상 외부 JSON envelope로 검증하며 내부 역할별 결과 검증도 유지해요.
- 전송 전에 RPC attempt를 기록해요. 동시 실행은 2개, 대기는 최대 32개이며 취소할 수 있어요. Uimori는 재시작·전송 실패·불확실한 실행을 자동 재생하지 않아요. 다만 공식 CLI 내부의 통신 재시도 정책은 Uimori가 제어하지 못해요. 0.153은 내장 OpenAI provider의 retry 설정 덮어쓰기를 거절하므로 내부 재시도 0회나 upstream exactly-once는 보장하지 않아요. 기존 하네스의 명시적 재요청 및 정상 종료된 결과에 대한 제한된 재시도는 별도 판단 요청으로 기록돼요.
- 한 attempt는 Codex 판단 작업 하나이며 Codex 내부 모델 호출 수와 같지 않아요. 응답에 토큰 사용량이 있으면 기록하지만 실제 비용과 내부 호출 수는 `null`이에요. Vertex의 USD 예산을 Codex 구독 예산으로 해석하지 않아요. 화면 사용률은 공식 계정 한도의 최근 조회값이에요.

### 내장 도구의 남은 경계

터미널·파일 읽기/쓰기·Node REPL·로컬 이미지 보기·브라우저/컴퓨터 제어·앱/MCP·외부 스킬·지속 메모·내장 하위 에이전트·추가 권한 요청은 제공하지 않아요. 이들은 호스트 파일·인증·외부 변경 권한, Uimori의 저장·협업·문맥 관리와 연결되므로 검색·계산과 같은 범위가 아니에요. `code_mode`는 Node REPL과 다른 V8 JavaScript 실행기예요. 등록된 도구만 호출하고 Node·파일·네트워크 API 및 모듈 import를 제공하지 않는 계약을 사용해요. Uimori 도구는 native registry에 등록하지 않고 JSON envelope로만 처리하므로 code mode에서 직접 저장 권한을 얻지 못해요. 지원하지 않는 승인/동적 도구 요청과 호스트 환경 도구 이벤트는 기존대로 실패 처리해요.

read-only sandbox만 남기고 셸을 열면 쓰기는 막아도 서버 파일과 전용 인증 파일의 읽기까지 격리하지는 못해요. 확인한 Codex Windows 제한 토큰 테스트는 루트 읽기 권한이 없는 파일시스템 정책을 지원하지 않는다고 명시하므로, 단순한 설정 삭제로 셸까지 허용하지 않았어요. 환경 도구를 추가하려면 별도 실행 환경과 읽기 범위를 먼저 정해야 해요. 검색은 Codex의 cached 모드이며 셸의 네트워크는 계속 차단해요.

2026-09-11 정적 근거는 로컬 `codex` 체크아웃 `459a79eb85400af759e9220c7bafb4429ae07516`의 `code-mode-runtime/src/runtime/{globals,module_loader,callbacks}.rs`(허용 전역·import 거부·등록 도구 인덱스), `core/src/tools/code_mode/execute_handler.rs`(현재 도구만 전달), `core/src/tools/spec_plan_tests.rs::disabling_shell_tools_disables_command_tools_for_all_environments`, `app-server/tests/suite/v2/thread_start.rs::create_config_toml_with_profile_workspace_root`예요. 경로는 모두 `codex-rs/` 아래예요. 이 원리를 Uimori의 `core/codex-protocol.ts`, `server/codex-runtime.ts`에 적용하고 합성 stdio 이벤트·실행 설정 검사를 추가했어요. 실제 설치 CLI에서의 도구 실행과 플랫폼 sandbox 검증은 사용자가 진행하며, 이 소스 조사와 합성 검사는 그 실증을 대신하지 않아요.

같은 소스의 `core/src/stream_events_utils.rs::{handle_output_item_done,handle_non_tool_response_item}`와 `app-server-protocol/src/protocol/v2/item.rs::ThreadItem`을 따라가면 code mode의 `exec`/`wait` 호출은 내부 도구 실행이며 별도 `codeMode` 공개 item을 만들지 않아요. 원시 이벤트를 요청한 경우 호출·출력은 `rawResponseItem/completed`에 해당하며 Uimori의 최종 응답 처리에 들어가지 않아요. 중첩한 검색은 `webSearch`, 삽화 생성은 `imageGeneration`처럼 해당 도구의 항목으로 나타나요. `core/src/tools/spec_plan.rs::register_code_mode_executors`는 환경 목록과 무관하게 실행기를 등록하고, `code-mode-runtime/src/service_contract_tests.rs::yields_and_resumes`는 빈 등록 도구 목록으로 계산을 실행하는 합성 사례예요. 단, `code-mode/src/remote_session.rs::ProcessOwnedCodeModeSessionProvider`는 설치 패키지의 `codex-code-mode-host` 실행 파일을 요구해요. 파일이 없으면 `core/src/tools/mod.rs::effective_tool_mode`에 따라 직접 도구로 돌아가거나 해당 모델의 code-mode-only 요청이 실패할 수 있으므로, 설정 허용을 모든 설치에서의 실제 계산 가능으로 해석하지 않아요.

## 로컬 검증

```powershell
npx vitest run tests/codex-process.test.ts tests/codex-runtime.test.ts tests/codex-protocol.test.ts tests/codex-image.test.ts tests/codex-integration.test.ts
# 설치된 CLI 연결만 확인: 새 빈 인증 폴더, 로그인/모델 호출 없음
$env:NR_CODEX_PREFLIGHT='1'
npx vitest run tests/codex-installed.test.ts
Remove-Item Env:NR_CODEX_PREFLIGHT
```

설치 사전 검사 결과는 `output/codex-preflight/summary.json`에 남아요. 합성 stdio 검사는 인증 취소·오류 가림·정상 이벤트·시간 초과·종료 경합·내장 도구 진행과 최종 응답 분리·환경/승인 경계·대기 취소·attempt 선기록을 확인해요. 앱 통합 검사는 6개 역할과 등록 제안, export/import, 비활성 프로바이더 및 인증/Origin 경계를 확인해요. `npm run verify:providers`에는 390px의 Codex 설정·모의 로그인·취소·연결 해제 검사가 포함돼요. 이 검사들은 실제 구독 모델 응답 품질·소모량을 입증하지 않아요.

공식 계약: [App Server](https://learn.chatgpt.com/docs/app-server), [인증](https://learn.chatgpt.com/docs/auth), [설정 schema](https://learn.chatgpt.com/config-schema.json). 버전별 실제 생성 타입과 채택 근거는 [SOURCES](../project-plan/SOURCES.md)에 기록해요.
