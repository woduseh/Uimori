# 커밋·푸시·Oracle 업데이트

> 현재 운영 계약은 **schema v15**, `/opt/uimori/app`, `compose.tailscale.yaml`, 기존 볼륨 `uimori_data_v15_clean_20260909`, loopback `127.0.0.1:4310`이에요. 공개 주소는 `https://pocketrisu.taila7874d.ts.net:8443/`이고 PocketRisu는 별도 컨테이너예요. 아래 v14 절차의 볼륨·스키마·초기화 명령을 현재 서버에 적용하지 않아요.

## 2026-09-11 UI 개편 배포 절차

이번 배포의 실행 파일과 검증 기록은 `output/oracle-release-20260911-eb133d4/`에 있어요. 폴더명은 최초 UI 커밋이며, 실제 배포 대상은 `expected-identity.json`의 최종 커밋·build ID로 확인해요. 배포 결과는 같은 폴더의 `RESULTS.md`와 실행 로그, 별도 HTTPS smoke의 `summary.json`으로 구분해요.

여러 도우미 세션을 지원하는 새 스키마는 기존 v15 도우미 테이블과 호환되지 않아요. 사용자가 기존 도우미 세션 이력 삭제를 명시적으로 허용한 이번 배포에 한해, 별도 실행 파일로 도우미 소유 행을 정리하고 현재 테이블을 만들어요. 제품에 구형 데이터 이관이나 자동 초기화를 추가하지 않아요. 채팅·봇·페르소나·프롬프트를 포함한 나머지 자료·원문·분기·상태·추첨·설정은 전체 표의 행 식별자·내용·스키마 해시로 보존을 검사해요. 도우미와 소유가 확인된 요청 시도·응답 스트림·요약만 삭제 대상에 포함하고, 공용 모델 입력·도구 이력·옵션 영수증은 유지해요.

기존 DDL·데이터 계획의 일치, 활성 작업 부재, 비어 있는 기존 위임·미반영 옵션을 먼저 확인해요. 앱을 중지한 뒤 SQLite 전체 복구본을 별도 비공개 디렉터리에 만들고 검증해요. 정리와 새 세션 동작 검사는 하나의 트랜잭션에서 실행하며, 실제 새 코드의 생성·수정·삭제 probe는 롤백해 운영 세션을 남기지 않아요. 정리 이후 배포 검사가 실패하면 이전 DB 전체와 이전 이미지로 함께 복귀해요. 환경·자격 파일·볼륨·포트·Tailscale·PocketRisu 보존 및 원격 main SHA 재확인도 유지해요.

릴리스 전체 회귀에서 발견한 패키지 상태 충돌 응답은 `BehaviorError`의 고정된 코드만 HTTP 응답에 전달하도록 수정했어요. 일반 오류나 추가 내부 정보는 노출하지 않으며, 개편된 메뉴·편집 섹션·작업공간 이동에 맞춰 관련 브라우저 검사를 갱신했어요. 최초 실패와 집중 재검사, 최종 전체 회귀는 각각의 증거로 기록해요.

## 2026-09-10 v15 릴리즈

사용자가 main 병합·커밋·푸시·Oracle 릴리즈를 승인한 후, 기존 v15 스크립트를 검토한 실행 파일을 `output/oracle-release-20260910-7be0488/`에 준비했어요. 이 폴더명은 최초 구현 커밋이고, 실제 배포 대상은 `expected-identity.json`의 **최종 커밋과 소스 build ID**예요. 실행 결과는 같은 폴더의 `RESULTS.md`와 배포 로그, `output/playwright/oracle-deploy-v15-*/summary.json`에 보존해요. `output/`은 이 작업트리의 로컬 증거라 새 clone에는 없어요.

현재 절차는 clean checkout·원격 main SHA·실행 이미지·운영 볼륨·포트를 확인하고, 격리된 임시 DB에서 새 이미지를 검사해요. 전체 v15 표와 자격 파일 해시, 환경 설정, Tailscale 라우팅, PocketRisu를 전후 비교해요. 활성 작업이나 데이터 변경이 있으면 중단하고, 컨테이너 교체 직전과 완료 전에도 원격 SHA를 재확인해요. 운영 DB를 초기화하거나 모델을 호출하지 않으며, HTTPS smoke는 로그인 외 쓰기를 차단해요. nullable `helper_tasks.started_at`의 누락과 null만 정규화하고 다른 값은 보존 검사에서 제외하지 않아요.

아래 내용은 2026-09-09의 **v14 당시 절차와 후속 CLI 제안**이에요.

현재 개인 운영 환경 기준으로, **변경 선택과 커밋은 직접 하고 검증된 커밋의 배포를 스크립트로 실행**하면 돼요. AI에게 매번 서버 경로와 명령을 다시 조사시킬 필요는 없어요. 이 문서는 2026-09-09 배포에서 사용한 절차와 자동화할 다음 단계를 정리해요.

## 현재 어디까지 자동화되어 있나요?

| 단계 | 현재 방법 | 직접 판단할 부분 |
| --- | --- | --- |
| 변경 검토·커밋 | Git/IDE | 포함할 변경, 커밋 메시지 |
| 로컬 검사 | `npm run quality:full`, 관련 `verify:*` | 변경에 맞는 브라우저 검사 선택 |
| 푸시 | `git push origin main` | 충돌이나 원격 선행 변경 해결 |
| Oracle 빌드·교체 | 기존 `deploy.sh` | 같은 schema인지, 운영 작업을 쉬는 시점인지 |
| 완료 확인 | 컨테이너 health, HTTPS 접속, 기존 운영 smoke | 실제 사용 화면과 공급자 키 설정 |

마지막 배포의 재사용 가능한 파일은 아래에 있어요. **`output/`은 Git에서 제외된 이 PC의 실행 기록**이라 새 clone에는 없어요. 아래 빠른 실행은 이 파일들이 남아 있는 현재 PC에서 사용해요.

- `output/models-deploy-20260909/deploy.sh`: 서버 잠금, clean checkout, 정확한 원격 SHA, 이미지 빌드·소스 지문, v14 격리 DB, 활성 작업·데이터·인증·PocketRisu·라우팅 보존 검사와 실패 시 이전 이미지 복귀 시도.
- `output/models-deploy-20260909/production-smoke.mjs`: 390/1440px 운영 로그인·보안 세션·빌드·설정 화면·조회 전후 archive 불변 검사. 실제 모델을 호출하지 않아요.
- `output/models-deploy-20260909/RESULTS.md`: 마지막 실행의 결과와 한계.

아직 `npm run release`나 `npm run deploy:oracle`이라는 정식 명령은 없어요. 아래 명령은 기존 실행 파일을 재사용하며, 뒤의 CLI 설계는 제안이에요.

## 적용 범위와 준비

현재 서버는 `/opt/uimori/app`, Compose 파일은 `compose.tailscale.yaml`, 컨테이너는 `uimori-app-1`, 볼륨은 `uimori_data`예요. 앱은 `127.0.0.1:4310`, 공개 HTTPS는 Tailscale Funnel 8443을 사용해요. PocketRisu는 별도 컨테이너예요. 서버 checkout은 배포 SHA의 detached HEAD여도 정상이에요.

**기존 스크립트는 schema v14와 현재 서버 배치 전용**이에요. schema·볼륨·DB 경로·Compose 구성·Codex 이미지 빌드 옵션이 달라지는 릴리스에는 그대로 쓰지 않아요. 특히 현재 `docker build` 호출은 선택적 `UIMORI_CODEX_VERSION` build argument를 전달하지 않으므로 이를 사용하는 배포에는 보완이 필요해요.

평소 업데이트는 같은 볼륨을 유지해요. DB 초기화·이관은 이 절차에 포함하지 않아요. 생성·번역 중에는 배포하지 말고, 빌드부터 확인 종료까지 앱 저장 작업도 잠시 쉬어 주세요. 스크립트에 요청 유입을 막는 maintenance mode는 없어서 검사 사이에 새 요청이 들어오는 경합까지 막지는 못해요.

## 1. 검토·검증·커밋

Windows PowerShell에서 저장소 루트로 이동해요. 각 명령이 실패하면 다음 단계로 넘어가지 않아요. `$ErrorActionPreference`만으로 외부 프로그램의 실패를 잡을 수 없어서 exit code도 확인해요.

```powershell
Set-Location C:\Users\wodus\ai-workspace\uimori
$ErrorActionPreference = 'Stop'
git status --short --branch
git diff --stat
git diff
```

변경이 끝나면 완료 검사를 실행해요. **같은 소스에 대해 이미 통과한 검사를 커밋·푸시 때문에 다시 실행할 필요는 없어요.** 커밋 이후 코드가 달라졌다면 관련 검증이 다시 필요해요.

```powershell
npm run quality:full
if ($LASTEXITCODE -ne 0) { throw '품질·빌드·테스트 실패' }

# 공급자/모델 UI 변경일 때의 예시. 변경에 맞는 기존 verify:*를 선택해요.
npm run verify:providers
if ($LASTEXITCODE -ne 0) { throw '브라우저 검사 실패' }
```

문서만 바뀌면 제품 빌드·전체 브라우저를 반복하지 않아요. 검사 선택은 [QUALITY.md](QUALITY.md)를 따라요. 전체 검사의 실패를 고쳤다면 실제 재검사 결과와 원래 실패 기록을 구분해 남겨요.

IDE에서 이번 변경 파일을 stage하거나 `git add 파일경로...`를 사용하고, staged diff를 확인해요. 아래부터는 **stage를 마친 뒤** 실행해요.

```powershell
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'staged diff 검사 실패' }
git diff --cached --stat
git diff --cached
git commit -m 'feat: 변경 내용을 설명하는 메시지'
if ($LASTEXITCODE -ne 0) { throw '커밋 실패' }
```

다른 작업의 미커밋 변경까지 `git add .`로 한꺼번에 포함하지 않아요. 이미 커밋했다면 커밋 단계는 건너뛰어요.

## 2. 푸시하고 배포 대상을 고정

```powershell
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'main에서 실행해 주세요' }
$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw '미커밋 변경을 먼저 정리해 주세요' }
$commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw '커밋 확인 실패' }

git push origin main
if ($LASTEXITCODE -ne 0) { throw '푸시 실패: 원격 변경을 확인해 주세요' }
$remote = git ls-remote --heads origin main
if ($LASTEXITCODE -ne 0 -or ($remote -split '\s+')[0] -ne $commit) { throw '원격 SHA 불일치' }

$buildId = node --input-type=module -e "import {assertBuild} from './scripts/lib.mjs'; console.log((await assertBuild()).buildId)"
if ($LASTEXITCODE -ne 0 -or $buildId -notmatch '^[0-9a-f]{64}$') { throw '현재 소스와 빌드가 일치하지 않아요' }
```

푸시가 거절되면 강제 푸시하지 말고 원격 변경을 검토·통합해요. `assertBuild()`는 현재 소스와 빌드 파일의 일치를 확인하지만 테스트 통과 증명은 아니에요. [Git push 동작](https://git-scm.com/docs/git-push)

## 3. Oracle 배포 실행

다음 변수는 한 PowerShell 세션에서 한 번 설정하면 돼요. SSH 개인 키와 known_hosts는 기존 파일을 참조하며 Git에 넣지 않아요. PC가 바뀌면 경로를 갱신해요.

```powershell
$ssh = "$env:WINDIR/System32/OpenSSH/ssh.exe"
$sshArgs = @(
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'UserKnownHostsFile=C:/Users/wodus/Documents/Codex/2026-09-07/new-chat/outputs/pocketrisu-access/known_hosts',
  '-i', 'C:/Users/wodus/Documents/Codex/2026-09-07/new-chat/outputs/pocketrisu-access/pocketrisu-ssh.pem',
  'ubuntu@168.110.23.8'
)
$deployScript = 'output/models-deploy-20260909/deploy.sh'
if (!(Test-Path -LiteralPath $deployScript)) { throw '기존 배포 스크립트가 없어요' }
$runDir = 'output/oracle-release-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $commit.Substring(0,7)
New-Item -ItemType Directory -Path $runDir -ErrorAction Stop | Out-Null

# 환경변수 이름/누락은 컨테이너 교체 전에 검사해요. 값은 출력하지 않아요.
& $ssh @sshArgs 'cd /opt/uimori/app && sudo -n docker compose --env-file .env.self-host -f compose.tailscale.yaml config --quiet'
if ($LASTEXITCODE -ne 0) { throw '서버 Compose 설정 검사 실패' }

Get-Content -Raw -LiteralPath $deployScript |
  & $ssh @sshArgs "tr -d '\r' | sh -s -- $commit $buildId" 2>&1 |
  Tee-Object -FilePath "$runDir/deploy.log"
if ($LASTEXITCODE -ne 0) { throw "배포 실패: $runDir/deploy.log 확인" }
```

성공하면 마지막에 `DEPLOY_PASS <commit>`이 나와요. 앱 이미지 빌드는 기존 앱을 켜둔 상태에서 하고, 컨테이너 교체 구간에만 짧은 중단이 있어요. 새 이미지가 정상 동작하면 기존 DB를 그대로 열어요. [Compose up의 컨테이너 교체·볼륨 보존](https://docs.docker.com/reference/cli/docker/compose/up/)

`DEPLOY_PASS`는 서버 검사 통과이지 공개 HTTPS·실제 모델 호출 성공까지 의미하지는 않아요. 이어서 운영 접속을 확인해요.

## 4. 완료 확인

가장 간단한 방법은 [운영 앱](https://pocketrisu.taila7874d.ts.net:8443/)을 새로고침하고 로그인한 뒤 변경한 화면과 기존 자료를 확인하는 거예요. 재시작 후에는 재로그인이 필요할 수 있어요. API 키 추가는 코드 배포와 별도예요.

기존 읽기 전용 HTTPS 브라우저 검사를 자동으로 돌리려면 같은 PowerShell 세션에서 아래를 실행해요. 이 검사는 해당 PC의 Chrome과 `output/oracle-deploy/private/production.env` 접속 설정을 사용해요. 접속 설정이 바뀌었다면 비밀 값을 출력하지 않고 기존 private 파일을 갱신해야 해요.

```powershell
@{ commit=$commit; buildId=$buildId; schemaVersion=14 } |
  ConvertTo-Json | Set-Content "$runDir/expected-identity.json"
$smoke = Get-Content -Raw 'output/models-deploy-20260909/production-smoke.mjs'
$smoke = $smoke.Replace('output/models-deploy-20260909/expected-identity.json', "$runDir/expected-identity.json")
Set-Content "$runDir/production-smoke.mjs" $smoke
node "$runDir/production-smoke.mjs" 2>&1 | Tee-Object -FilePath "$runDir/https.log"
if ($LASTEXITCODE -ne 0) { throw 'HTTPS 검사 실패: 배포 실패와 구분해 원인을 확인해 주세요' }
git status --short --branch
```

이 스크립트는 마지막 운영 UI 기준의 6개 검사를 수행해요. UI 구조가 바뀌면 검사도 갱신해야 해요. 실제 공급자 호출·과금·실제 휴대폰 검사는 포함하지 않아요. HTTPS 검사 실패는 이미 완료한 배포를 자동으로 되돌리지 않아요.

## 문제가 생겼을 때

| 현상 | 대응 |
| --- | --- |
| `NR_PUBLIC_ORIGIN is missing` | 서버 `.env.self-host`의 정확한 변수 이름과 빈 값 여부 확인. 직전에는 `3NR_PUBLIC_ORIGIN` 오타였어요. `config --quiet`로 재검사해요. |
| SSH host key 오류 | 서버 교체 여부와 새 fingerprint를 신뢰할 수 있는 경로로 확인해요. host key 검사를 끄지 않아요. |
| 활성 작업·DB 내용 변경으로 중단 | 사용 중인 요청이 끝나고 저장 작업이 없는 시점에 다시 실행해요. 보존 검사를 제거하지 않아요. |
| dirty checkout·SHA 불일치 | 해당 서버/로컬 변경과 원격 main을 확인해요. 자동 reset·강제 push는 하지 않아요. |
| 빌드 실패 | 기존 앱은 유지돼요. `deploy.log`에서 최초 오류를 확인해요. |
| 새 앱 health 실패 | 스크립트가 이전 checkout·이미지 복귀를 시도해요. 복귀 성공까지 자동 보증하지 않으므로 아래 명령으로 실제 상태를 확인해요. |
| SSH 끊김 | 원격 작업이 끝났는지 먼저 조회해요. 중단·복귀 trap은 연결/프로세스 종료 방식에 따라 보장되지 않아요. |
| 모바일 화면 timeout | 서버 health와 페이지 로딩 오류를 먼저 구분해요. 이전 운영 검사에서는 원격 로딩 대기 30초로 확인했어요. |

```powershell
& $ssh @sshArgs 'sudo -n docker inspect --format "{{.Config.Image}} {{.State.Health.Status}}" uimori-app-1'
& $ssh @sshArgs 'git -C /opt/uimori/app rev-parse HEAD'
```

복귀에 실패하면 서버에서 `/opt/uimori/app`의 checkout과 `.env.self-host`의 `UIMORI_IMAGE_TAG`를 **실제로 직전에 실행하던 전체 SHA**로 맞춘 뒤 동일 Compose의 `up -d --no-build app`을 실행해요. 과거 SHA는 직전 배포 기록과 이미지 목록으로 확인하고 추정하지 않아요. 이 복귀도 같은 schema일 때만 적용해요. DB를 삭제하거나 `down -v`를 실행하는 절차가 아니에요.

환경 파일 확인에는 값을 렌더링하는 `config` 대신 `config --quiet`를 써요. [Docker 공식 설명](https://docs.docker.com/reference/cli/docker/compose/config/)

## 한 명령으로 묶는다면

다음은 **아직 구현하지 않은 정식 CLI 설계**예요. 현재 규모에는 로컬 PowerShell/Node 실행기가 적합해요. SSH 비밀을 새 CI 시스템에 등록할 필요 없이 지금 접근 수단을 재사용할 수 있어요.

1. 현재 `output/` 스크립트를 `deploy/oracle-update.sh` 같은 tracked 경로로 옮기고 서버/파일 경로를 인자로 받아요. 초기 설치·schema 변경·일상 업데이트는 별도 작업으로 유지해요.
2. `release:check`는 현재 커밋과 소스/빌드/검사 지문이 포함된 결과를 만들어요. 재사용은 내용이 일치할 때만 허용하고 `검사 건너뛰기`를 기본으로 두지 않아요.
3. 제안 명령 `release:oracle`은 clean main·검증 결과·원격 SHA 확인 → 일반 push → SSH 배포 → HTTPS smoke → 결과 파일 저장을 연결해요. 검토하지 않은 변경의 stage/commit은 자동으로 하지 않아요.
4. 서버에서 build argument와 현재 Compose 구성을 보존하고, 환경 검사와 동시 배포 잠금을 앞단에 둬요. 최종 전환에는 요청 유입 차단·작업 drain 또는 사용자와 약속한 maintenance window가 필요해요.
5. 실패 시 원인과 복귀 결과를 별도 상태로 기록해요. 현재 전체 DB hash 비교는 자료가 커지면 느려지므로 일관된 읽기 transaction·검사 범위·전환 경합을 보완해요. 단순히 검사를 생략해 속도를 내지 않아요.

그 다음 필요해지면 GitHub에서 수동 실행하는 배포로 옮길 수 있어요. 먼저 로컬 한 명령을 안정화하면 같은 실행기를 재사용할 수 있어요. 현재 문서 작성에서는 새 CLI·GitHub Actions·자동 트리거를 설치하거나 운영 배포를 다시 실행하지 않았어요.

## 문서 검증

사용한 npm script·`assertBuild` export·Compose 경로와 옵션·기존 배포 파일을 현재 저장소에서 확인했어요. PowerShell 예시는 구문 검사했고, 연결된 로컬 파일 존재 여부와 diff를 확인했어요. 새 명령 묶음의 실제 커밋·푸시·운영 재배포는 수행하지 않았어요. 마지막 운영 검증은 `output/models-deploy-20260909/RESULTS.md`의 실행 시점 결과예요.
