# Uimori

긴 원고를 읽고 다음 장면을 이어 쓰는 개인용 창작 웹앱이에요. 봇별 채팅·폴더, 봇·페르소나·모듈 패키지, 프롬프트와 창작 프리셋, 원문·번역 편집, 포크, 상태·장기기억과 백업을 제공해요.

개인 ChatGPT 구독으로 에이전트를 실행하려면 [Codex 연결 안내](docs/CODEX.md)를 따라 서버 실행기를 준비하고 **설정 → 에이전트**에서 로그인해요.

M0와 M1·M2 로컬 기능을 바탕으로 봇 중심 화면과 패키지·프롬프트 편집을 확장했어요. 실제 휴대폰 사용, 모델의 창작·번역·장기기억 품질과 특정 사용자 자료의 완전한 이식은 별도 확인이 필요해요. [현재 상태와 남은 작업](project-plan/CURRENT.md)

## Windows에서 실행

Node **24.14 이상 24.x**, npm, Chrome 또는 Edge가 필요해요. SQLite는 Node에 포함된 기능을 사용해요.

```powershell
npm ci
npm run doctor
npm run dev
```

프로젝트 루트에서 실행한 뒤 [로컬 앱](http://127.0.0.1:4310)을 열어요. `dev`는 빌드 후 서버를 시작하며, 이미 빌드했다면 `npm start`로 실행할 수 있어요. 이전 서버를 사용 중이면 해당 터미널에서 Ctrl+C로 종료한 뒤 다시 시작해요.

1. **봇**에서 자료를 만들거나 고른 뒤 **채팅 시작** 또는 봇의 **새 채팅**을 눌러요. 봇은 필수이고, 만든 채팅의 소속 봇은 바꾸지 않아요. 페르소나·프롬프트·창작 프리셋은 선택할 수 있어요.
2. 실제 모델을 쓰려면 **설정 → 연결과 모델**에서 연결·모델을 등록하고 채팅의 역할별 모델로 선택해요. 모델을 선택하지 않은 역할은 검증용 합성 경로로 동작해요.
3. 하단 입력창에 장면 요청을 보내요. 기본 전송 키는 Ctrl/Cmd+Enter예요.
4. 원고의 **번역 보기**를 누르면 번역을 시작해요. 저장된 번역의 보기 전환과 원문·번역 직접 저장은 모델을 호출하지 않아요.

## 개인 Linux 서버에서 사용

[Self-host 안내](docs/SELF-HOST.md)에 Docker Compose와 Nginx HTTPS 구성을 준비했어요. 도메인·인증서·접속 토큰을 설정하면 PC와 휴대폰에서 같은 작업실에 접속하는 방식이에요. 앱 포트는 내부 네트워크에 두고 SQLite는 영구 volume에 저장해요. 실제 Linux 이미지 빌드·기동과 실제 기기 접속은 아직 검증하지 않았으며, 로컬 HTTPS 검증의 결과와 한계는 [현재 상태](project-plan/CURRENT.md)에 기록해요.

## 사용·설정 안내

| 문서 | 내용 |
| --- | --- |
| [사용 안내](docs/USAGE.md) | 봇별 채팅·폴더, 패키지, 프롬프트·창작 프리셋, 번역·포크, 백업 |
| [Native JSON 가져오기](docs/RISU-IMPORT.md) | 자료·프롬프트 편집기에서 검증·검토 후 저장 |
| [에이전트의 Risu 자료 이식](docs/RISU-PORTING.md) | RisuToki MCP·스킬로 조사하고 native JSON·손실 보고·검증 결과 작성 |
| [패키지](docs/PACKAGES.md) · [상태와 행동](docs/PACKAGE-BEHAVIOR.md) | 역할별 자료·옵션, 상태 전이·자동/사용자/모델 행동·기록된 추첨 |
| [프롬프트 제작 방식](docs/PROMPT-AUTHORING.md) | 선택형 템플릿 문법과 TypeScript 제작 API 비교 |
| [공급자 연결](docs/PROVIDERS.md) | Vertex, Responses·Chat 호환, Anthropic, Vercel, Codex 연결과 선택형 평가 도구·합성 시험 |
| [개발과 검증](docs/DEVELOPMENT.md) | 검사·정리 명령, 격리 실행, 코드 구조와 증거 보관 |
| [개인 서버 배포](docs/SELF-HOST.md) | Docker Compose, HTTPS, 로그인, 영구 데이터, 모델 API 키와 업데이트 |
| [계획과 인수 기준](project-plan/README.md) | M0–M3 범위, 설계 계약과 단계별 결과 |

## 데이터와 접속

- 기본 DB는 `.local/narrative.sqlite`예요. 현재 DB·JSON archive는 **v8**이며 정식 배포 전에는 구버전 호환·자동 이관을 지원하지 않아요. 개발 DB를 초기화하려면 서버 종료 후 `npm run reset:dev`를 실행해요.
- **설정 → 내보내기와 복원**에서 JSON 또는 SQLite 백업을 저장해요. JSON은 새 빈 DB로 복원해요. [백업·격리 DB 사용법](docs/USAGE.md)
- 기본은 `127.0.0.1` 로컬 모드이며 `NR_ACCESS_TOKEN` 인증을 선택할 수 있어요. 개인 서버 모드는 `NR_PUBLIC_ORIGIN`에 HTTPS 주소 하나를 지정하고 32자 이상 접속 토큰을 필수로 사용해요. `NR_HOST`로 수신 주소를 정하며 외부 수신은 개인 서버 모드에서만 허용해요. [접속 조건](docs/SELF-HOST.md#프록시와-접속-조건)
- 인증 정보는 서버 환경변수·서버가 읽는 파일로 설정해요. 사용자 데이터·인증 파일·실행 산출물은 Git에서 제외해요.

## 검증 상태

검사 수·실행 시점·소스와 빌드 일치 여부는 [현재 검증 근거와 한계](project-plan/CURRENT.md)에서 확인해요. 합성 로컬 검증은 실제 모델 품질과 실제 기기 검증을 대신하지 않아요. 상세 결과의 `output/` 링크는 Git에 포함되지 않은 로컬 실행 기록이에요.
