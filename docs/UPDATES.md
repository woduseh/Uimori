# Linux/Docker 업데이트 · 구현 제안

상태: 2026-09-12 설계 검토를 바탕으로 한 구현 제안이며, 1단계(admission/drain·유지보수 부팅)는 2026-09-14에 구현했어요. 사용자가 선택한 일반 설치 방향은 Linux/Docker이며, 일반 설치자의 Update 버튼·controller·maintenance 모드는 아직 미구현이에요. 이 문서의 설계 검토에서는 제품 코드와 운영 서버를 변경하지 않았어요. 베타 방향은 [결정](DECISIONS-2026-09-12-BETA.md), 진행은 [베타 계획](../project-plan/BETA-PLAN.md), 현재 수동 실행은 [SELF-HOST](SELF-HOST.md)가 소유해요.

## 현재 있는 기반과 없는 경계

| 현재 기반 | 재사용할 점 | 일반 Update에 남은 일 |
| --- | --- | --- |
| `compose.yaml` | 단일 app, 영구 data volume, 비루트 app·읽기 전용 root, app과 HTTPS proxy 분리 | 기본 image는 `uimori:local`이에요. 일반 설치용 배포 image 선택·신뢰 가능한 릴리스 목록·controller는 없어요. |
| `ProductStore.backup` | SQLite `VACUUM INTO`로 일관된 DB 파일 생성 | 다운로드용 DB 백업이며 data 디렉터리의 credential/Codex 부속 파일·설치 설정 전체 백업과 복구 controller는 아니에요. |
| `initializeDatabaseSchema` | 저장소 소유권을 얻은 뒤 worker보다 먼저 지원 migration, 이력·DDL·검증을 transaction으로 처리 | 백업·이미지/volume 전환과 실패 후 제품 복구까지 수행하지 않아요. |
| `Store.recover`, 작업별 recover | 중단된 실행의 기록과 불확실 외부 호출을 보존 | 업데이트 대기·쓰기 차단과 같은 동작은 아니에요. 큐를 재개하는 범위도 업데이트를 이유로 넓히지 않아요. |
| `app`의 `preClose` | 중단 신호 전달, 작업 settle 후 DB 닫기 | 현재는 `stopping.abort()`부터 수행해요. 정상 작업의 완료를 기다리는 admission/drain 단계가 없어요. |
| Oracle release 도구 | lock, 정확한 commit/image, 복사본 probe, 정지 후 백업, 단계별 영수증·rollback | SSH·전용 경로·특정 Compose와 container·Tailscale을 전제한 운영자 절차예요. 일반 Update API가 아니에요. |

코드 근거는 [compose](../compose.yaml), [DB 백업](../server/product-store.ts)의 `backup`, [migration](../server/schema-migrations.ts)의 `initializeDatabaseSchema`, [앱 종료](../server/app.ts)의 `preClose`, [복구](../server/store.ts)의 `recover`예요. SQLite는 `VACUUM INTO`의 일관된 snapshot을 보장하지만 생성 중 비정상 종료로 출력 파일이 불완전할 수 있으므로, 성공 반환과 별도 무결성 검사를 확인한 백업만 복구 대상으로 삼아요. [SQLite 공식 문서](https://www.sqlite.org/lang_vacuum.html#vacuuminto)

## Oracle 절차와 새 환경의 차이

[release-oracle.mjs](../scripts/release-oracle.mjs)의 `validateConfig`는 전용 releaseRoot를 고정하고, `releaseOracle`은 clean HEAD와 `origin/main`의 일치를 요구해요. [Runner.compose/inspect/routing](../deploy/oracle-update.py)는 `compose.tailscale.yaml`, `uimori-app-1`, Tailscale과 sudo Docker를 사용해요. 일반 사용자의 기본 Nginx Compose에 이 스크립트를 그대로 연결하지 않아요.

`Runner.execute`는 실행 중 후보를 준비하고 복사본을 검사한 뒤 앱을 정지하고 data 디렉터리 전체를 백업해요. `Runner.rollback`은 후보 volume의 활성 작업을 확인하고 중지한 후 백업으로 기존 volume을 복원할 수 있어요. 그러나 [inspectData](../scripts/oracle-data.mjs)는 `queued/running/waiting_for_state` 행을 검사하며 이미 끝난 새 편집·채팅이 생겼는지는 판정하지 않아요.

기존 [Oracle 문서](ORACLE-RELEASE.md)의 「서버 안전장치와 결과 해석」에는 운영자가 짧은 전환 중 저장·생성하지 않는 전제가 명시돼 있어요. 그 전제 안에서 작성한 도구를 잘못된 일반 updater라고 판정하는 것은 아니에요. 여러 기기가 로그인한 일반 앱의 Update 버튼에서는 이 전제가 자동 성립하지 않으므로 앱이 실제로 쓰기를 차단하고 controller가 전환 경계를 소유해야 해요.

## 비교안

| 안 | 장점 | 비용·한계 |
| --- | --- | --- |
| **추천: 별도 controller container + 앱 admission/drain + 새 data volume 검증/전환** | Compose 설치 경험을 유지하고 app이 내려가도 업데이트 작업·복구·상태 조회가 살아 있어요. 이전 image/volume을 직접 보존해 되돌리기 쉬워요. | controller는 Docker 관리 권한을 가진 신뢰 구성요소예요. 별도 데이터 복사 공간, controller용 통신·영수증·설치 절차가 필요해요. |
| host의 작은 systemd controller | Docker socket을 앱과 다른 container에 마운트하지 않고 같은 제한 API·전환 흐름을 구현할 수 있어요. | host 설치 권한과 서비스 관리, 배포판별 설치/업데이트 검증이 더 필요해요. Docker를 제어하는 서비스의 권한 자체가 없어지는 것은 아니에요. |
| 같은 controller 로직을 운영자가 CLI로 실행 | 초기 제품 검증과 controller 장애 시 복구 진입점으로 단순해요. 별도 외부 상태 API 없이 먼저 검증할 수 있어요. | 이것만으로 앱 안의 Update 버튼 요구가 완료되지는 않아요. 현재 Oracle 절차를 그대로 일반 CLI로 이름만 바꾸는 것도 아니에요. |

일반 릴리스는 앱과 그 버전에 결합된 확장 실행 이미지 등을 하나의 검증된 배포 묶음으로 다뤄요. proxy/TLS/접속 origin·토큰을 불필요하게 바꾸거나 controller 자체 갱신을 암묵적으로 섞지 않아요. controller protocol 변경이 필요한 릴리스는 기존 controller가 수행할 수 있는 지원 경로를 검증해야 하며, 수동 작업을 상시 요구하는 것으로 Update 한 번의 목표를 축소하지 않아요. Compose는 필요한 service만 재생성할 수 있으므로 전체 stack의 불필요한 중지를 피할 수 있어요. [Docker 공식 배포 문서](https://docs.docker.com/compose/how-tos/production/#deploying-changes)

## controller의 권한 경계

- Docker 관리 권한은 controller만 가져요. app·확장 broker·JS/Lua worker에는 Docker socket, host shell, 설치 설정 쓰기 권한을 넘기지 않아요. Docker daemon 관리 인증정보는 host 전체 제어로 이어질 수 있으므로 이 controller를 일반 부가 기능으로 취급하지 않아요. [Docker daemon 접근 보호](https://docs.docker.com/engine/security/protect-access/)
- controller는 관리 대상 stack·app service·data volume·설치 generation을 자체 설정에서 알아요. 브라우저나 app이 임의 Docker 명령, Compose 파일, host 경로, image URL을 넘기는 범용 proxy를 만들지 않아요.
- app은 명시적인 사용자 업데이트 요청을 좁은 API로 전달하고, controller는 신뢰하는 릴리스 목록의 고정 digest·플랫폼·지원 DB 범위·controller protocol을 검증해요. 앱이 보낸 태그나 검사 결과만 신뢰하지 않아요. 실제 registry/릴리스 게시 파이프라인은 별도 구현이에요.
- 확장 API와 모델 도구에는 update/restore 권한이 없어요. 일반 HTTP broker도 controller의 내부 주소나 관리 통로를 접근 대상으로 허용하지 않아요.
- 업데이트 journal·lock·backup manifest는 교체되는 app image와 active DB 밖에 둬요. 동일 idempotency key는 같은 작업을 반환하고, 두 기기의 경합과 controller 재시작은 이 journal을 기준으로 이어 가요. 중단된 Docker 명령은 실제 image/volume/container 상태를 읽고 판단하며 무조건 다시 실행하지 않아요.
- 앱 중지 중에도 제한된 상태 조회·유지보수 안내가 가능해야 해요. 내부 API를 그대로 공개하지 않고 상태 조회용 통로와 인증을 따로 좁혀요. 현재 로그인 세션은 앱 재시작 시 해제되므로 초안 보존·재접속·재로그인도 제품 흐름에 포함해요.

## 제안 전환 절차

1. **준비:** 관리 대상의 현재 image digest·volume·설치 generation을 고정하고 공간·권한·지원 경로를 확인해요. 새 image 다운로드/준비는 기존 앱을 이용할 수 있을 때 먼저 끝내요. 이 단계 실패는 기존 앱을 바꾸지 않아요.
2. **admission 닫기:** 지속되는 maintenance epoch를 만들고 새 사용자 쓰기·생성·import/restore와 새 외부 작업의 시작을 막아요. 정상 GET뿐 아니라 실제 쓰기와 job/host-effect 진입점을 점검해야 해요. 반영하지 않은 요청은 성공처럼 표시하지 않고 입력 초안을 남겨요.
3. **drain:** 이미 승인된 실행의 완료·결과 저장·필요한 같은 실행의 continuation은 허용해요. 그 완료가 만든 후속 큐는 보존하되 새 외부 작업으로 시작하지 않아요. 기본은 정상 완료를 기다리고 Update 취소가 가능해요. 진행 작업을 중단할 필요가 생기면 사용자의 명시적 중단 동작을 사용하고 불확실 시도·부분 결과·미완료 상태를 보존해요. SIGTERM을 정상 drain의 대체물로 쓰지 않아요.
4. **정지·최종 복구본:** active worker·attempt가 정리된 상태를 확인하고 이전 app을 정지해요. 마지막 저장까지 포함한 DB와 data 부속 파일을 별도 위치에 보존하고 무결성·완료 여부·원래 image/volume·설치 설정을 영수증에 기록해요. 실행 중 SQLite 파일 하나만 복사하지 않아요. 초기 probe snapshot을 최종 백업이라고 재사용하지 않아요.
5. **후보 검증:** 보존한 data에서 새 volume을 만들고 같은 후보 image로 migration·무결성·기본 읽기 경로를 확인해요. 후보에는 유지보수 모드를 시작부터 적용해 worker·확장·모델·HTTP·이미지 작업을 실행하지 않아요. 두 app이 같은 SQLite volume을 동시에 열게 하지 않아요.
6. **전환·검사:** 새 image와 새 volume을 함께 선택하고 maintenance를 유지한 채 실제 실행 identity·DB·기본 API를 확인해요. 이때까지 사용자 쓰기가 없으므로 실패하면 이전 image와 이전 volume으로 자동 복귀할 수 있어요. 환경·TLS·공개 라우팅·비밀을 임의로 교체하지 않아요.
7. **쓰기 재개:** 성공 기록과 active 설치 generation을 확정한 후 admission을 열어요. 기존 작업 재개 규칙은 유지하고 불확실 외부 호출을 재전송하지 않아요. 이전 복구본은 이 시점에 자동 삭제하지 않아요.

**자동 복귀는 쓰기 재개 전까지만 허용하는 것을 권해요.** 새 앱에서 쓰기를 재개한 뒤 문제가 생기면 현재 volume과 이후 작업을 보존하고 필요하면 다시 maintenance로 전환해요. 오래된 백업을 current volume에 덮거나 구버전 image로 호환되지 않는 DB를 열지 않아요. 이때는 현재 자료를 보존한 복사본에서 전진 수정 또는 명시적인 복구를 진행해요. 사용자가 이후 작업을 버리는 복구를 선택해야 한다면 손실될 범위를 먼저 보여 줘야 해요.

## 다음 구현의 최소 두 단계

### 1. admission/drain과 유지보수 부팅 — 2026-09-14 구현

`server/maintenance.ts`가 `maintenance` 표에 status·epoch·reason을 보관하고 `GET/POST /api/maintenance`로 상태를 조회·전환해요. 닫힌 상태는 재시작에도 유지되며 epoch는 유지보수 구간마다 하나씩 늘어요. 인증 hook 다음의 공통 `onRequest` 경계가 POST·PUT·PATCH·DELETE를 `503 MAINTENANCE_CLOSED`로 거절하고, 제어·로그인·진단·진행 중 작업의 취소/건너뛰기 경로만 허용 목록으로 남겨요. 브라우저는 유지보수 안내를 표시하고 작성 중인 입력을 지우지 않아요.

worker 쪽은 같은 `admissionOpen`을 사용해 job·삽화·story 큐와 확장 operation의 **새 claim**을 멈추고, 이미 승인된 실행의 완료·결과 저장·상태 대기 재개는 계속해요. 완료가 만든 후속 제목 생성도 닫힌 동안 시작하지 않아요. `NR_MAINTENANCE=1` 부팅은 migration·읽기만 수행하고 복구·worker를 건너뛰며 API로 열 수 없어요. 검사는 `tests/maintenance.test.ts`예요.

남은 부분은 아래 2단계의 controller와 image/volume 전환, 그리고 앱 안의 Update 버튼이에요. 아래 설명은 그 다음 구현의 기준으로 유지해요.

새 업데이트 UI나 Docker 제어보다 먼저 앱의 admission 상태·epoch·허용 작업 종류와 작업 집계를 구현해요. 새 요청/설정/자료/원문 저장·백업 import를 차단하고 이미 진행 중인 작업의 결과 저장과 취소는 구분해요. worker claim, 외부 attempt 시작, helper·삽화·확장 효과에도 같은 경계를 연결해요. 후보 부팅은 migration·읽기 health만 수행하고 정상 worker 시작을 건너뛰어요.

합성 검증은 새 요청과 drain 경합, 두 기기의 저장·import, 진행 중 모델 continuation, 완료 직후 후속 job, 취소/중단 후 늦은 결과, 재시작 후 닫힌 gate 유지, 브라우저 초안 보존을 다뤄요. 이 단계는 Docker 없이 로컬 fixture로 검증할 수 있어요. 기존 원문·state·난수·idempotency와 불확실 재전송 금지 회귀를 유지해요.

### 2. 제한 controller와 두 image/volume fixture

고정된 합성 v1/v2 image와 독립 data volume으로 `prepare → drain → stop/backup → migrate/probe → switch → reopen`을 검증해요. 기본 API는 `start/status/cancel-before-cutover` 정도로 좁히고 작업이 완료된 뒤 같은 요청 키를 보내도 다시 업데이트하지 않게 해요.

각 전환 직전/직후 controller 종료, 디스크 부족, 불완전 백업, migration 실패, 잘못된 image/volume, health 실패, 이중 클릭, 데이터 복사 도중 중단, 쓰기 재개 후 실패를 주입해요. 마지막 사례에서는 새 채팅·설정·import 내용이 자동 rollback으로 사라지지 않아야 해요. 실제 공급자·운영 DB·외부 배포 없이 이 fixture를 통과한 뒤 앱 버튼·상태 화면과 릴리스 배포 파이프라인을 연결해요.

## 구현자 판단과 사용자 선택

controller API·배치 형태, 상태 이름, generation/lock 형식, 두 volume 교체 방식, 구체 검사·예산·timeout, 기본 백업 보존은 기존 원칙 안에서 구현자가 비교·검증할 수 있어요. 이 문서만으로 사용자의 승인된 배포 범위나 외부 권한이 늘어나지는 않아요.

실제 사용자 선택이 필요한 상황은 구체적이에요. 진행 중인 외부 작업을 끝내지 않고 중단할 때, 쓰기 재개 후 데이터를 버리는 복구가 필요할 때, 새 registry/서버 권한·외부 백업 전송·유료 저장소가 필요할 때 해당 영향과 대안을 보여 줘요. 현재의 설계·합성 fixture 착수를 막는 추가 사용자 결정은 없어요. 주기 자동 업데이트나 원격 중앙 관리는 Update 버튼 요청에 포함하지 않아요.
