# Oracle 릴리스

이 문서는 기존 Oracle Uimori 서비스에 검증한 `origin/main`을 반복 배포하는 현재 절차예요. 실행기 도입 전 운영 기준은 commit `6a2cc79`, schema v15, `/opt/uimori/app`, loopback `127.0.0.1:4310`, 공개 주소 `https://pocketrisu.taila7874d.ts.net:8443/`예요. 주소의 hostname은 유지하지만 PocketRisu 서비스와 라우팅은 제거된 상태이므로 배포 전후 검사에서 PocketRisu를 요구하지 않아요.

과거 v14/v15 일회성 스크립트와 `output/oracle-release-*` 기록은 당시 배포 증거일 뿐 현재 실행 절차가 아니에요. 특히 과거 볼륨명, 선택적 행 삭제, 70개 표 전체 hash, PocketRisu 보존 검사를 새 배포에 복사하지 않아요.

## 준비

Node 24.14 이상 24.x에서 clean checkout을 사용해요. 실행기는 `HEAD`와 `origin/main`의 전체 SHA가 같아야 진행하며 source를 stage, commit, push하지 않아요. 변경 검토와 push는 배포 명령 전에 직접 끝내요.

로컬 전체 검사에는 원격 실행기의 회귀 검사를 위한 Python 3가 필요해요. Windows에서는 `python`, Linux에서는 `python3`를 사용해요. Oracle 서버에도 Python 3, Docker와 Compose, Git이 준비돼 있어야 해요.

SSH 키, `known_hosts`, 운영 접속 설정은 Git에 넣지 않고 `.local/oracle-release.json` 같은 ignored 경로에 둬요. 저장소의 [예시 설정](../deploy/oracle-release.example.json)을 복사해 절대 경로를 채워요.

```json
{
  "host": "ubuntu@168.110.23.8",
  "identityFile": "C:/private/uimori-oracle.pem",
  "knownHostsFile": "C:/private/known_hosts",
  "appDirectory": "/opt/uimori/app",
  "releaseRoot": "/opt/uimori/releases",
  "accessEnvFile": "C:/private/production.env",
  "area": "verify:browser-smoke"
}
```

`releaseRoot`는 실행기가 사용하는 전용 staging 경로 `/opt/uimori/releases`로 고정돼요. 다른 경로로 바꾸는 설정이 아니며 `appDirectory`와 겹칠 수 없어요.

`accessEnvFile`에는 기존 `NR_PUBLIC_ORIGIN`과 `NR_ACCESS_TOKEN`이 있어야 해요. 토큰과 키 내용은 명령 인자, 로그, 저장소에 남기지 않아요. 배포는 이 공개 주소와 접근 토큰을 바꾸지 않아요.

로컬 Docker는 필요하지 않아요. 기본 경로는 서버에서 이미 받은 정확한 SHA를 한 번 빌드하고 immutable image ID로 이후 검사와 전환을 이어 가요. 이미 관리 중인 registry image가 있다면 `--image registry.example/uimori@sha256:...`처럼 전체 image reference를 줄 수 있어요. 이 입력 기능만 있으며 현재 절차는 Docker를 설치하거나 새 image repository·registry를 만들지 않아요.

현재 Oracle 호스트는 `aarch64`예요. 다른 컴퓨터에서 이미지를 만든다면 `docker buildx build --platform linux/arm64 ... --push`처럼 Linux ARM64 대상을 포함해야 해요. 같은 검증 커밋과 운영의 `UIMORI_CODEX_VERSION`으로 만들고, 서버에서 접근 가능한 registry에 올린 digest를 `--image`로 전달해요. 실제 업로드·registry 인증 설정은 이 명령에 포함되지 않아요. 플랫폼 지정은 [Docker 공식 문서](https://docs.docker.com/build/building/multi-platform/#build-multi-platform-images)를 따라요.

## 검증과 배포

기본 릴리스 검사는 전체 단위·통합·빌드, 최소 앱 smoke, 선택한 기능 영역을 실행해 내용 지문이 포함된 영수증을 남겨요.

```powershell
npm run release:check -- --area verify:browser-smoke
npm run release:oracle -- --config .local/oracle-release.json --area verify:browser-smoke
```

`release:oracle`도 같은 검증을 요구해요. 현재 source와 실행 환경·검사 계약 지문이 모두 같은 성공 영수증은 검사별로 재사용해요. 성공 검사의 빌드만 없거나 stale이면 검사를 반복하지 않고 build만 복구한 뒤 현재 source와 artifact 일치를 다시 확인해요. source나 실행 환경·검사 계약이 달라졌으면 stale로 판정해 다시 실행해요. 같은 source에 실패 기록이 있으면 `--area`를 줄이거나 `--full`을 빼서 우회할 수 없어요. 실패 원인을 해결하고 그 범위를 다시 통과해야 해요. 커밋 때문에 내용이 바뀌지 않았다면 커밋 전 성공한 영수증도 clean HEAD가 된 뒤 재사용할 수 있어요.

`--area`는 변경 영역에 맞는 기존 `verify:*` npm script를 선택해요. 기본값은 `verify:browser-smoke`예요. 공통 UI, 공통 실행·저장 경계처럼 여러 기능에 걸친 변경이나 안정화 릴리스에는 두 명령 모두 `--full`을 붙여 전체 `verify:redesign`까지 실행해요. 작은 수정의 배포마다 `--full`을 요구하지 않아요. 선택 기준은 [코드 품질 검사](QUALITY.md)와 [검사 운영 정리](TESTING-AUDIT.md)에 있어요.

배포 도구 자체를 바꾸면 `quality:full`, `verify:smoke`, 관련 `verify:selfhost`를 검사해요. 상위 브라우저 연결 계약도 바뀌었다면 `verify:browser-smoke`를 관련 영역으로 사용해요. 실제로 실행하지 않은 검사는 PASS로 기록하지 않아요.

## 실행 모드

| 명령 | 동작 |
| --- | --- |
| `npm run release:oracle -- --config .local/oracle-release.json --plan` | 설정과 로컬 검증 상태만 확인해요. SSH 연결이나 서버 변경은 없어요. |
| `npm run release:oracle -- --config .local/oracle-release.json --check-only` | 원격 전제와 이미지를 검증하고 기본 경로에서는 서버 이미지를 빌드해요. 실행 중인 앱을 중지하거나 DB를 초기화하거나 활성 앱을 바꾸지 않아요. |
| `npm run release:oracle -- --config .local/oracle-release.json` | 현재 DB를 백업한 뒤 같은 운영 볼륨으로 업데이트하고, health와 HTTPS/API smoke까지 확인해요. |
| `npm run release:oracle -- --config .local/oracle-release.json --fresh` | 새 운영 볼륨으로 시작해요. 이전 볼륨은 rollback용으로 남겨요. |
| `npm run release:oracle -- --config .local/oracle-release.json --image <전체-reference>` | 서버 build 대신 지정한 immutable image를 검사하고 사용해요. tag만으로 움직이는 reference보다 digest를 권장해요. |

`--area`, `--full`, `--fresh`, `--image`, `--check-only`는 필요에 따라 함께 사용할 수 있어요. `--plan`은 서버 작업 없이 실행 계획을 확인하는 모드예요.

일반 업데이트는 앱 전환 전에 SQLite 복구본을 만들고 기존 DB를 그대로 사용해요. 기본 경로는 모든 표의 모든 행을 hash하지 않으며, backup 성공, schema/앱 호환성, 활성 작업 부재, health와 smoke를 검사해요. 선택적 행 삭제나 DB reset은 업데이트 계약에 포함하지 않아요.

`--fresh`는 새 볼륨과 새 DB를 만들고 기존 볼륨을 보존해요. 기존 `<database>.vertex-credentials` 디렉터리와 `<database>.codex/auth.json`만 새 볼륨에 복사해요. Codex 세션·설정과 DB의 모델·연결 reference는 초기화되므로 새 DB에서 다시 설정해야 해요. 환경의 origin, access token과 공개 라우팅은 유지해요.

## 서버 안전장치와 결과 해석

원격 실행기는 동시에 한 릴리스만 허용하는 lock, 배포 SHA pin, 서버 checkout/source 일치, 활성 작업 부재, Compose 설정, loopback 바인딩을 전환 전에 확인해요. 원격 `origin/main`이 진행되거나 전제가 바뀌면 중단하고 새 SHA를 다시 검증해요. 동작 중인 작업은 후보 검사 전후와 전환 경계에서 확인하지만 검사 사이에 이미 끝난 편집까지 감지하지는 못해요. 개인 운영자는 앱을 멈추고 교체하는 짧은 전환 구간에 저장·생성 요청을 하지 않아야 해요.

이미지는 실행 중인 앱을 유지한 채 한 번 준비하고, 전환 구간에만 앱을 교체해요. 새 앱의 health나 loopback 검사가 실패하면 직전 image와 해당 모드의 이전 볼륨으로 rollback을 시도하고 결과를 별도로 기록해요. rollback은 전환 중 사용자 작업 손실을 완전히 차단한다는 보장이 아니므로 위의 무쓰기 조건을 지켜요. SSH가 끊기거나 rollback이 실패했다면 성공을 추정하지 말고 lock 상태, 실행 image ID, checkout SHA, volume과 health를 먼저 조회해요.

성공한 서버 전환 뒤 작은 HTTPS/API smoke가 공개 origin, 인증, build identity와 기본 읽기 경로를 확인해요. 이 smoke는 실제 공급자 호출, 과금, 창작 의미 품질, 실제 휴대폰 동작을 증명하지 않아요. 배포와 smoke의 성공·실패를 각각 기록해요.

`output/release/oracle/<run>/summary.json`에는 로컬 검증 재사용, 파일 전송, 서버 작업, 공개 HTTPS smoke의 시간이 구분돼요. 서버 receipt의 `stages`에는 이미지 준비, 격리 검사, 백업, 전환과 health 시간이 있어요. 최초 의존성 다운로드나 캐시 유무에 따라 준비 시간이 달라지므로 고정 시간을 보장하지 않아요. 로컬 image build와 registry 업로드는 선택지이며 현재 기본 절차에는 없어요.

## 현재 증거의 한계

이 문서와 실행기 도입 자체는 운영 재배포 성공 증거가 아니에요. 현재 `6a2cc79` 운영 기준에 새 production HTTPS/API smoke를 읽기 위주로 실행한 결과는 `output/release/smoke-baseline.json`의 **6 PASS, 5.52초**예요. 이전 브라우저 기반 전체 운영 검사의 약 65초와 범위가 다르므로 직접적인 속도 비교나 브라우저 UI 증거로 해석하지 않아요. 새 smoke는 인증, build, 읽기 API와 정적 asset 전달을 확인했고 DB 무결성, 컨테이너 identity, 실제 공급자, GUI·실기기 품질은 확인하지 않았어요. 이후 배포 상태와 결과는 각 실행의 receipt와 HTTPS smoke를 따로 확인해야 해요.
