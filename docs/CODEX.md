# Codex 에이전트 연결

Uimori 서버에서 공식 Codex CLI의 App Server를 실행하고 개인 ChatGPT 구독으로 로그인해요. 프로토콜은 `codex-app-server-v1`, 연결 주소는 고정값 `codex://local`이에요. 본문·번역·장면 상태 표시·이미지 작업 지시·상태 계산·기억 추출에서 같은 Codex 모델 프리셋을 선택할 수 있어요. 이미지 역할은 기존 Uimori의 이미지 작업 지시를 만들며 Codex 이미지 생성 기능을 추가한 것은 아니에요.

## 준비와 로그인

1. 서버에 공식 Codex CLI **0.153.0 이상**을 설치해요. 현재 연결 계약은 설치된 0.153.0에서 생성한 공식 schema를 기준으로 구현했어요. 버전을 올릴 때는 아래 사전 검사를 다시 실행하세요.
2. 서버 환경에 `NR_CODEX_ENABLED=1`을 설정하고 앱을 시작해요. 기본값은 비활성이에요. PATH의 네이티브 실행 파일과 일반적인 npm 설치를 탐색해요. 자동 탐색이 안 되면 `NR_CODEX_EXECUTABLE`에 실제 `codex`/`codex.exe`의 절대 경로를 지정해요. `.cmd`, `.bat`, `.ps1` 래퍼나 명령 문자열은 허용하지 않아요.
3. **설정 → 에이전트 → ChatGPT로 Codex 로그인**을 눌러요. 표시된 코드를 공식 `https://auth.openai.com/codex/device` 페이지에 직접 입력해요. 로그인은 공식 Codex 프로세스가 처리해요. 계정에서 device-code 로그인을 허용해야 하며 Uimori는 토큰 붙여넣기나 기존 CLI 로그인 가져오기를 제공하지 않아요.
4. **연결과 모델**에서 **Codex · ChatGPT 구독** 연결을 저장하고 모델 목록을 조회해 프리셋을 저장해요. 각 기능의 모델 선택에서 해당 프리셋을 선택해요. 모델 목록 조회는 생성 요청을 보내지 않아요.

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
- 전용 Codex home과 빈 임시 작업 폴더를 사용해요. 기존 사용자 home/config와 서버의 provider API 키 환경변수를 넘기지 않아요. `environments: []`, `selectedCapabilityRoots: []`, read-only/never 정책과 기능 비활성화로 Codex의 파일·터미널·웹·MCP·앱·스킬 접근을 차단해요. 예상하지 않은 도구 실행은 실패로 처리해요.
- Codex는 JSON으로 최종 응답 또는 허용된 Uimori 도구 요청을 반환해요. 실제 도구 권한·자료 조회·검증·저장은 기존 Uimori 하네스가 담당해요. 각 역할의 기존 원문/hash/revision·취소·작업 귀속 계약을 유지해요.
- PromptProgram의 논리적 역할·순서·빈 메시지를 JSON으로 전달해요. Codex 자체 지침이 추가되므로 native API message role과 동일한 처리는 보장하지 않아요. assistant prefill과 필수 cache는 실행 전에 거절해요.
- `reasoningEffort`와 timeout을 전달해요. `maxOutputTokens`는 출력 목표이며 공급자의 강제 토큰 한도가 아니에요. temperature는 허용하지 않아요. 구조화 출력은 항상 외부 JSON envelope로 검증하며 내부 역할별 결과 검증도 유지해요.
- 전송 전에 RPC attempt를 기록해요. 동시 실행은 2개, 대기는 최대 32개이며 취소할 수 있어요. Uimori는 재시작·전송 실패·불확실한 실행을 자동 재생하지 않아요. 다만 공식 CLI 내부의 통신 재시도 정책은 Uimori가 제어하지 못해요. 0.153은 내장 OpenAI provider의 retry 설정 덮어쓰기를 거절하므로 내부 재시도 0회나 upstream exactly-once는 보장하지 않아요. 기존 하네스의 명시적 재요청 및 정상 종료된 결과에 대한 제한된 재시도는 별도 판단 요청으로 기록돼요.
- 한 attempt는 Codex 판단 작업 하나이며 Codex 내부 모델 호출 수와 같지 않아요. 응답에 토큰 사용량이 있으면 기록하지만 실제 비용과 내부 호출 수는 `null`이에요. Vertex의 USD 예산을 Codex 구독 예산으로 해석하지 않아요. 화면 사용률은 공식 계정 한도의 최근 조회값이에요.

## 로컬 검증

```powershell
npx vitest run tests/codex-process.test.ts tests/codex-runtime.test.ts tests/codex-protocol.test.ts tests/codex-integration.test.ts
# 설치된 CLI 연결만 확인: 새 빈 인증 폴더, 로그인/모델 호출 없음
$env:NR_CODEX_PREFLIGHT='1'
npx vitest run tests/codex-installed.test.ts
Remove-Item Env:NR_CODEX_PREFLIGHT
```

설치 사전 검사 결과는 `output/codex-preflight/summary.json`에 남아요. 합성 stdio 검사는 인증 취소·오류 가림·정상 이벤트·시간 초과·종료 경합·도구 차단·대기 취소·attempt 선기록을 확인해요. 앱 통합 검사는 6개 역할과 등록 제안, export/import, 비활성 연결 및 인증/Origin 경계를 확인해요. `npm run verify:providers`에는 390px의 Codex 설정·모의 로그인·취소·연결 해제 검사가 포함돼요. 이 검사들은 실제 구독 모델 응답 품질·소모량을 입증하지 않아요.

공식 계약: [App Server](https://learn.chatgpt.com/docs/app-server), [인증](https://learn.chatgpt.com/docs/auth), [설정 schema](https://learn.chatgpt.com/config-schema.json). 버전별 실제 생성 타입과 채택 근거는 [SOURCES](../project-plan/SOURCES.md)에 기록해요.
