# Oracle 릴리스

Oracle 운영 진입점은 `npm run release:oracle` 하나예요. 소스 검증은 정확한 커밋의 GitHub Actions가 담당하고, 실제 이미지·데이터·접속 검증은 Oracle 호스트가 담당해요. main push는 자동 배포하지 않아요.

## 준비

컨트롤러에는 Node 24.x, Git, 로그인된 GitHub CLI(`gh`, 저장소 Actions 읽기 권한), SSH/SCP가 필요해요. CI의 Node 기준은 `.nvmrc`, Oracle 이미지의 Node 기준은 Dockerfile에 명시돼 있어요. 로컬 Docker·Playwright·미리 만든 `dist`·운영 접속 토큰 사본은 배포 조건이 아니에요.

Oracle에는 기존 Uimori 앱, Docker/Compose, Python 3, Git, Tailscale 경로가 있어야 해요. 운영 앱은 healthy이고 checkout은 clean이어야 해요. 진행 중인 생성이나 기존 maintenance가 있으면 먼저 정상 종료·해제하고 배포해요. 배포 도구는 사용자 작업을 강제로 취소하지 않아요.

[예시 설정](../deploy/oracle-release.example.json)을 ignored `.local/oracle-release.json`에 복사해요.

```json
{
  "host": "ubuntu@oracle.example",
  "identityFile": "C:/private/uimori-oracle.pem",
  "knownHostsFile": "C:/private/known_hosts",
  "appDirectory": "/opt/uimori/app",
  "releaseRoot": "/opt/uimori/releases",
  "expectedOrigin": "https://uimori.example.ts.net",
  "sourceRef": "main"
}
```

`expectedOrigin`은 운영 `.env.self-host`의 `UIMORI_PUBLIC_ORIGIN`과 같은 HTTPS origin이며 경로나 후행 `/`를 넣지 않아요. `releaseRoot`는 `/opt/uimori/releases`로 고정돼요. 키와 `known_hosts` 파일은 기존 개인 파일 경로를 사용해요. **이전 설정의 `accessEnvFile`과 `area`는 제거하고 `expectedOrigin`으로 바꿔요.** 컨트롤러는 운영 접속 토큰 파일을 더 이상 읽지 않아요. 서버의 기존 origin·토큰·인증 파일은 유지해요.

## 검증과 배포

```bash
npm run release:oracle -- --config .local/oracle-release.json --plan
npm run release:oracle -- --config .local/oracle-release.json --source-ref main
```

배포 시작 시 clean HEAD와 `origin/<sourceRef>`의 전체 SHA가 일치해야 해요. 도구는 그 SHA를 고정하고 `Quality` workflow의 해당 branch/SHA 실행을 GitHub에서 조회해요. `static`, `tests (1/4)`부터 `tests (4/4)`, `tooling`, `linux-core`, `selfhost`, 최종 `quality`가 모두 성공해야 해요. PR 임시 merge commit, 다른 SHA, docs-only 성공, 취소·누락·실패한 job은 대체 증거가 아니에요. 같은 SHA의 더 최신 실행이 실패했으면 오래된 초록불로 돌아가지 않아요. GitHub 조회 실패도 검증 생략으로 처리하지 않아요.

문서 전용 커밋을 실제 배포하려면 해당 branch의 정확한 SHA에 workflow를 수동 실행해 전체 필수 검사를 통과시켜요. `workflow_dispatch`의 `browser=true`는 전체 브라우저 회귀까지 추가해요. 다른 branch 배포도 같은 전체 검증이 필요해요. 진행 중 main이 앞서가더라도 이미 선택한 검증 SHA를 바꾸거나 정상 전환을 롤백하지 않아요.

`release:check -- --area <verify:*>`는 별도의 로컬 개발 검증 명령으로 남아요. 기본 `quality`·build·선택한 synthetic 테스트와 내용 기반 영수증 재사용 규칙은 유지하지만, 이 영수증으로 Oracle의 CI 관문을 대체하지 않아요. 로컬에서 동일한 E2E를 다시 실행하거나 영수증을 수동 수정할 필요가 없어요.

## 실행 모드

| 옵션 | 동작 |
| --- | --- |
| `--plan` | 설정과 선택한 로컬 소스를 표시해요. GitHub·SSH 접속이나 서버 변경은 없어요. |
| `--check-only` | CI 확인 후 실제 이미지를 만들고 빈 DB 및 운영 DB 복제본을 검증해요. 운영 앱을 중지하거나 maintenance를 변경하지 않아요. 상태 조회용 인증 세션은 만들 수 있어요. |
| 기본 실행 | 검증·쓰기 중지·백업·전환·호스트 HTTPS smoke·쓰기 재개까지 진행해요. |
| `--image <image ID 또는 digest>` | 기본 서버 build 대신 이미 준비한 이미지 하나를 검사해 사용해요. `--check-only` 결과의 immutable image ID를 재사용할 수 있어요. |
| `--status` | 현재 checkout, image/volume/health, 배포 lock과 최근 서버 기록을 읽어요. CI를 재실행하거나 배포를 재개하지 않아요. |
| `--status --run-id <id>` | 지정한 실행 기록과 실제 운영 상태를 나란히 읽어요. 없는 실행은 `release: null`로 표시해요. |
| `--fresh` | 명시적 초기화예요. 새 데이터 볼륨을 만들고 외부 로그인 파일만 복사해요. 기존 DB·설정·앱 API 키는 새 앱에 이어지지 않아요. |

기본 경로는 Oracle에서 정확한 SHA를 한 번 빌드해요. 이후 모든 probe와 전환은 같은 immutable image ID를 사용해요. 이미지에는 `io.uimori.managed=true`, `org.opencontainers.image.revision=<전체 SHA>`, `io.uimori.codex-version=<설정값>` label이 있어야 해요. 새 registry나 멀티아키텍처 배포 체계를 만들지는 않아요. 외부 이미지도 이 label과 현재 Codex 빌드 설정이 일치해야 하며 실제 ARM64 부팅 검사를 통과해야 해요.

로컬 `dist`를 다시 만들어 원격 빌드와 비교하지 않아요. 컨트롤러는 소스 build fingerprint를 계산하고, 실제 이미지에서 해당 fingerprint와 이미지 내부 manifest·artifact hash를 검증해요. Node와 최종 dist hash는 서버 기록에 남아요.

## 서버 안전장치와 결과 해석

```text
CI 확인 → Oracle preflight → pinned SHA 이미지 준비
→ 빈 DB maintenance boot → 운영 DB 복제본 maintenance boot
→ maintenance 닫기 → 이미 승인된 작업/HTTP 쓰기 종료 확인
→ 앱 정지 → DB·동반 파일·기존 환경 백업과 무결성 확인
→ 후보 이미지 전환 (쓰기 계속 닫힘)
→ health·DB·외부 인증 파일·환경·라우팅 확인
→ Oracle 호스트의 실제 HTTPS/API smoke
→ 쓰기 재개 요청 및 상태 확인 → PASS
```

복제본 probe는 `UIMORI_MAINTENANCE=1`로 외부 작업과 복구 worker를 시작하지 않아요. 실제 전환에는 재시작 후에도 보존되는 DB maintenance 상태를 사용해요. 이미 승인된 비동기 HTTP 쓰기도 active work로 집계해요. 종료가 늦으면 배포를 중단하고 기존 앱의 admission을 돌려놓으며 생성 작업을 강제로 취소하지 않아요.

호스트 control은 기존 운영 환경 파일을 read-only mount한 일회성 컨테이너에서 실행돼요. admission 제어는 정확한 Host/Origin을 가진 loopback HTTP를 사용하고, 최종 smoke는 host network에서 실제 HTTPS 주소와 인증서를 검증해요. 컨트롤러의 Tailscale 라우팅 유무는 배포 조건이 아니에요. smoke는 인증 세션과 읽기 API·HTML/JS만 확인하며 유료 모델 호출은 하지 않아요. 호스트에서의 성공이 외부 인터넷·모든 휴대폰 경로의 성공을 증명하지는 않아요.

전환 전 실패는 기존 앱을 유지해요. 전환 후 **쓰기 재개 요청 전** 실패는 maintenance 소유권·닫힘·idle을 확인한 뒤 직전 이미지/DB/환경으로 롤백해요. 쓰기 재개 요청을 보내기 전에 `REOPENING`을 저장하므로 응답을 잃어도 DB를 과거 백업으로 자동 복원하지 않아요. 사용자가 새 앱에서 저장했을 가능성이 있는 상태를 덮어쓰지 않기 위해서예요. 이 경우 `REFUSED_AFTER_REOPEN` 또는 상태 불확실성을 보고하고 `--status`로 조사해요.

SSH가 끊기면 같은 명령을 바로 재실행하지 말고 알려진 run ID로 상태를 조회해요. 실제 image·volume·health와 lock이 확인되기 전에는 성공이나 실패를 추정하지 않아요. 실행 중인 작업을 자동 재개하거나 새로운 배포로 덮어쓰는 기능은 없어요.

컨트롤러 보고서는 `output/release/oracle/<run>/summary.json`, 서버 보고서는 `/opt/uimori/releases/<run>/oracle-summary.json`이에요. 단계 시작·종료와 경과시간을 바로 출력하고 CI 실행 번호, image identity, 백업, smoke, 쓰기 재개 및 롤백 결과를 분리해서 남겨요. 비밀 설정 전체는 출력하지 않으며 하위 명령 오류의 비공개 진단 로그 위치를 기록해요.

## 개인 작업실 v1 전환

일반 업데이트는 운영 데이터 볼륨을 유지하고 앱의 명시적 forward migration만 실행해요. unrelated legacy DB는 자동 초기화하지 않아요. schema 24→개인 작업실 v1은 [별도 사용자 자료 복사 도구](DATA-MIGRATIONS.md)를 사용해요.

`--fresh`는 새 볼륨에 기존 `<database>.vertex-credentials`와 `<database>.codex/auth.json`만 복사해요. 새 DB를 격리 부팅한 뒤 persisted maintenance를 닫고 전환하므로 검증 중 쓰기가 열리지 않아요. 이전 볼륨과 배포 전 백업은 보존하고, fresh 롤백은 이전 볼륨으로 돌아가며 새 사용자 자료를 이전 DB에 섞지 않아요.
