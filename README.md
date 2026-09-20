# Uimori

긴 원고를 읽고 다음 장면을 이어 쓰는 개인용 창작 웹앱이에요. 봇별 채팅·폴더, Risu 원본 봇·페르소나·모듈, 프롬프트와 모델의 독립 설정, 원문·번역 편집, 분기, 이야기 기억과 백업을 제공해요.

현재는 `0.0.1` 개발 버전이에요. Risu 원본의 저장·편집·실행 범위는 [가져오기 안내](docs/RISU-IMPORT.md), 설치와 업데이트의 현재 제한은 [업데이트 안내](docs/UPDATES.md)를 확인해요.

개인 ChatGPT 구독으로 에이전트를 실행하려면 [Codex 연결 안내](docs/CODEX.md)를 따라 서버 실행기를 준비하고 **설정 → 에이전트**에서 로그인해요.

## Windows에서 실행

Node **24.14 이상 24.x**, npm, Chrome 또는 Edge가 필요해요. SQLite는 Node에 포함된 기능을 사용해요.

```powershell
npm ci
npm run dev
```

프로젝트 루트에서 실행한 뒤 [로컬 앱](http://127.0.0.1:4310)을 열어요. `dev`는 빌드 후 서버를 시작하며, 이미 빌드했다면 `npm start`로 실행할 수 있어요. 이전 서버를 사용 중이면 해당 터미널에서 Ctrl+C로 종료한 뒤 다시 시작해요.

1. **서재 → 봇**에서 자료를 만들거나 고른 뒤 **봇으로 새 채팅**, 또는 왼쪽 탐색에서 봇을 고르고 **새 채팅**을 눌러요. 봇은 필수이고, 만든 채팅의 소속 봇은 바꾸지 않아요. 페르소나·프롬프트·창작 프리셋은 선택할 수 있어요.
2. **설정 → 프로바이더와 모델**에서 프로바이더·모델을 등록하고 채팅의 역할별 모델로 선택해요. 모델 없이 채팅을 만들거나 작성된 시작문을 사용할 수 있지만, 본문 생성·번역 등 모델을 실행하는 역할에는 모델 선택이 필요해요. 프로바이더 추가에서 **TypeSafe AI**를 선택하면 **JEV**가 모델 목록에 등록돼요. 본문·번역 거절 판정, 로어 관련성, 기존 이미지 선택은 JEV가 담당해요. 실제 본문 생성 전에는 JEV 연결도 설정해요.
3. 하단 입력창에 장면 요청을 보내요. 기본 전송 키는 Ctrl/Cmd+Enter예요.
4. 원고의 **번역 보기**를 누르면 번역을 시작해요. 저장된 번역의 보기 전환과 원문·번역 직접 저장은 모델을 호출하지 않아요.

## 개인 Linux 서버에서 사용

[Self-host 안내](docs/SELF-HOST.md)에 Docker Compose와 Nginx HTTPS 구성이 있어요. 도메인·인증서·접속 토큰을 설정하면 PC와 휴대폰에서 같은 작업실에 접속할 수 있어요. SQLite는 영구 volume에 저장해요. 업데이트 CLI와 앱 내 Update UI의 지원 차이는 [업데이트 안내](docs/UPDATES.md)를 확인해요.

## 사용·설정 안내

| 문서 | 내용 |
| --- | --- |
| [사용 안내](docs/USAGE.md) | 봇별 채팅·폴더, 패키지, 프롬프트·창작 프리셋, 번역·포크, 백업 |
| [서재와 프롬프트](docs/LIBRARY.md) · [항목 삭제](docs/DELETION.md) | 자료 분류·폴더·대표 이미지, 삭제 위치와 참조 보호 |
| [Risu 원본 가져오기](docs/RISU-IMPORT.md) | `.charx` 카드·모듈·`.risup` 프롬프트 원본, CBS·Lua·정규식·CSS 실행과 지원 범위 |
| [Risu 자료 내보내기](docs/RISU-EXPORT.md) | 저장한 카드·모듈·프롬프트를 CHARX·RISUM·RISUP으로 내보내기 |
| [문제 보고용 진단](docs/DIAGNOSTICS.md) | 원문·키를 제외한 보고서 미리보기와 다운로드 |
| [Risu 콘텐츠](docs/PACKAGES.md) | 원본 카드·모듈과 채팅별 연결, 카드 변수·이야기 기억의 책임 |
| [장면 삽화](docs/ILLUSTRATIONS.md) | Codex 이미지 생성·원격 ComfyUI로 응답별 삽화 생성, 자동 생성·재요청·개수 한도 |
| [프로바이더](docs/PROVIDERS.md) | Vertex, Responses·Chat 호환, Anthropic, Vercel, Codex 프로바이더와 선택형 평가 도구·합성 시험 |
| [개발과 검증](docs/DEVELOPMENT.md) | 검사·정리 명령, 격리 실행, 코드 구조와 증거 보관 |
| [개인 서버 배포](docs/SELF-HOST.md) | Docker Compose, HTTPS, 로그인, 영구 데이터, 모델 API 키와 업데이트 |
| [Oracle 릴리스](docs/ORACLE-RELEASE.md) | 검증·배포 명령, 데이터 보존과 실패 복구 |
| [코드 지도](docs/CODE-MAP.md) | 기능별 현행 문서와 구현 진입점 |

## 데이터와 접속

- 기본 DB는 `.local/uimori.sqlite`예요. 빈 DB와 현재 지원하는 DB만 열어요. 구체적인 기준 버전은 [현재 데이터 형식](docs/DATA-MIGRATIONS.md#현재-버전)을 확인해요. 이전 DB·백업을 읽거나 변환하는 호환 경로는 없고 기존 파일을 자동으로 변경하지 않아요. 새 작업은 별도의 빈 경로에서 시작해요. [DB와 자료 교환 형식](docs/DATA-MIGRATIONS.md) 테스트용 개발 DB를 초기화하려면 서버 종료 후 `npm run reset:dev`를 실행해요.
- **설정 → 데이터 관리 → 내보내기와 복원**에서 JSON 또는 SQLite 백업을 저장해요. JSON은 새 빈 DB로 복원해요. [백업·격리 DB 사용법](docs/USAGE.md)
- 기본은 `127.0.0.1` 로컬 모드이며 `UIMORI_ACCESS_TOKEN` 인증을 선택할 수 있어요. 개인 서버 모드는 `UIMORI_PUBLIC_ORIGIN`에 HTTPS 주소 하나를 지정하고 32자 이상 접속 토큰을 필수로 사용해요. `UIMORI_HOST`로 수신 주소를 정하며 외부 수신은 개인 서버 모드에서만 허용해요. [접속 조건](docs/SELF-HOST.md#프록시와-접속-조건)
- 인증 정보는 서버 환경변수·서버가 읽는 파일로 설정해요. 사용자 데이터·인증 파일·실행 산출물은 Git에서 제외해요.

## 라이선스

Uimori 프로젝트 소스는 [AGPL-3.0-only](LICENSE)로 제공해요. RPack을 포함한 제3자 구성 요소의 원본 조건·저작권은 [제3자 고지](THIRD_PARTY_NOTICES.md)를 확인해요. 사용자 자료·채팅·생성 결과의 권리는 각자의 이용 조건에 따르며 앱 소스 라이선스가 자동 적용되지 않아요. 서버로 제공하거나 수정본을 배포할 때는 [실행 빌드에 맞는 대응 소스 제공 안내](docs/SELF-HOST.md#라이선스와-대응-소스)를 따라요.
