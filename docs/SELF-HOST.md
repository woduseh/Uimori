# 개인 서버에서 사용하기

[시작하기](../README.md) · [프로바이더](PROVIDERS.md)

> 현재 개발 버전의 Linux/Docker 실행 안내예요. CLI 업데이트의 지원 범위와 앱 내 Update UI의 현재 제한은 [업데이트 안내](UPDATES.md)를 확인해요.

한 사람이 PC와 휴대폰에서 같은 작업실을 사용하는 구성이에요. Linux 서버의 Docker Compose가 **Nginx HTTPS → Uimori 한 프로세스 → 영구 SQLite**를 실행해요. 접속 토큰을 아는 기기는 같은 자료·채팅에 접근해요. 사용자별 계정·권한 분리는 없어요.

호스트에 Tailscale이 있다면 [Tailscale 배포 안내](TAILSCALE-DEPLOY.md)의 별도 Compose로 Serve 또는 Funnel을 사용할 수도 있어요. Funnel은 휴대폰의 Tailscale 연결 없이 접속할 수 있는 공개 HTTPS 경로예요.

## 준비와 실행

서버에 Docker Engine과 Compose 플러그인, 이 저장소의 코드가 필요해요. 설치는 사용 중인 배포판의 [Docker 공식 안내](https://docs.docker.com/engine/install/)를 따르세요. 호스트에 Node.js를 따로 설치할 필요는 없어요. 이미지는 Debian 기반 `node:24-bookworm-slim`을 사용하고 Node `>=24.14.0 <25`를 검사해요. 빌드 단계에서 `npm ci`와 빌드를 수행하고 실행 이미지에는 production 의존성과 `dist`를 복사해요. [Node 공식 이미지](https://github.com/nodejs/docker-node/blob/main/README.md), [Docker 다단계 빌드](https://docs.docker.com/build/building/multi-stage/)

1. 사용할 호스트 이름이 서버를 가리키도록 DNS를 설정하고, 그 이름에 유효하며 PC·휴대폰이 신뢰하는 TLS 인증서를 준비해요. 예시는 `story.example.com`이에요. 서버 방화벽·공유기에서는 HTTPS 포트만 열어요. 기본 번들은 HTTP 80 포트를 열거나 인증서를 발급하지 않아요.
2. 서버의 전용 디렉터리에 `fullchain.pem`, `privkey.pem`을 둬요. 예시는 `/srv/uimori/tls`예요. Nginx가 이 디렉터리를 읽기 전용으로 마운트해요. 파일이 바깥 경로를 가리키는 심볼릭 링크이면 컨테이너에서 읽지 못하므로 두 파일과 링크 대상이 마운트 안에 있어야 해요. 인증서는 접속할 도메인과 일치해야 해요. [Nginx TLS 설정](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_certificate)
3. 저장소 루트에서 환경 파일을 준비해요.

```sh
cp deploy/self-host.env.example .env.self-host
chmod 600 .env.self-host
openssl rand -hex 32
```

마지막 명령의 결과를 `.env.self-host`의 `UIMORI_ACCESS_TOKEN`에 넣고 아래 값을 실제 서버에 맞춰 편집해요. 빈 토큰으로는 시작하지 않아요. 이 파일은 Git과 Docker 빌드 문맥에서 제외돼요.

| 변수 | 값과 의미 |
| --- | --- |
| `UIMORI_PUBLIC_ORIGIN` | `https://story.example.com`처럼 브라우저가 사용할 HTTPS origin 하나. 경로·후행 `/`·query·fragment는 넣지 않아요. |
| `UIMORI_ACCESS_TOKEN` | 공백 없는 무작위 접속 토큰 32–1000자. 위 명령은 64자리 hex를 생성해요. |
| `UIMORI_TLS_DIR` | 두 TLS 파일이 있는 서버의 절대 디렉터리. |
| `UIMORI_HTTPS_PORT` | 기본 `443`. `8443`이면 public origin에도 `:8443`을 넣어요. |
| `UIMORI_PROVIDER_ORIGINS` | 공식 공급자 주소는 기본 허용해요. 사용자 지정 API의 추가 허용 origin을 쉼표로 나열해요. public origin과 별도이며 공식 프로바이더만 쓰면 비워둬요. |

4. 설정을 확인하고 시작해요. 아래 명령은 저장소 루트에서 실행해요. `config --quiet`는 비밀 값을 출력하지 않고 Compose 설정을 검사해요. 보간에 필요한 값이 없으면 시작 전에 오류를 반환해요. [Compose 환경 파일](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/), [필수 값 보간](https://docs.docker.com/reference/compose-file/interpolation/)

```sh
docker compose --env-file .env.self-host config --quiet
docker compose --env-file .env.self-host up --build -d
docker compose --env-file .env.self-host ps
docker compose --env-file .env.self-host logs --tail=100 app proxy
```

PC·휴대폰에서 설정한 HTTPS 주소로 접속하고 토큰을 입력해요. 각 브라우저는 별도 로그인 세션을 가져요. 세션은 최대 12시간이며 서버를 재시작하면 다시 로그인해야 해요. 저장한 자료·채팅은 공유하지만 미전송 초안 같은 브라우저 저장 정보는 기기별이에요.

세션은 최대 32개이며 초과하면 가장 오래 발급된 세션부터 해제해요. 잘못된 토큰으로 10번 접속하면 첫 실패부터 15분이 지날 때까지 새 로그인을 제한해요. 개인 작업실 전체에 적용하고 이미 로그인한 기기의 사용은 유지해요. 서버는 토큰을 생성·보관해주지 않으므로 설정한 값을 따로 관리하세요.

## 모델 API 키

JEV는 앱의 **프로바이더·모델 → 프로바이더 추가 → TypeSafe AI** 화면에서 키를 저장하고 바로 테스트할 수 있어요. 저장 키는 DB 옆의 `.jev-credentials` 디렉터리에 보관하며 JSON/SQLite 내보내기에 포함되지 않아요. 기존 `TYPESAFE_API_KEY` 환경변수도 저장 키가 없을 때 계속 사용할 수 있어요. 자세한 연결·보관 방식은 [JEV 안내](PROVIDERS.md#typesafe--jev-연결과-테스트)를 확인하세요.

`.env.self-host`는 앱 컨테이너의 서버 환경변수로도 전달돼요. 사용할 공급자의 키를 추가한 뒤 컨테이너를 갱신하세요. 키에 `$`나 `#`가 있으면 값을 작은따옴표로 감싸서 Compose 보간·주석 처리를 피하세요.

```dotenv
UIMORI_PROVIDER_ORIGINS=https://api.openai.com
OPENAI_API_KEY='실제-서버-키'
```

```sh
docker compose --env-file .env.self-host up -d
```

앱의 프로바이더 설정에는 키 값 대신 `OPENAI_API_KEY`라는 참조 이름을 넣어요. 접속 토큰은 작업실 로그인용이고 `OPENAI_API_KEY` 같은 인증 환경변수는 외부 모델 호출용이에요. 이름은 영문 대소문자 또는 밑줄로 시작하고 이후 숫자를 포함할 수 있으며 최대 200자예요. 특정 접두사는 요구하지 않아요. 모델별 설정과 현재 검증 범위는 [공급자 안내](PROVIDERS.md)를 확인하세요.

Google Agent Platform의 서비스 계정 파일을 쓰는 경우 `deploy/compose.vertex.example.yaml`을 함께 사용해요. `.env.self-host`에 `UIMORI_SECRETS_DIR=/srv/uimori/secrets`를 설정하고 그 디렉터리에 `service-account.json`을 둬요. 파일은 앱의 UID 1000 사용자가 읽을 수 있어야 해요. 이 overlay는 서버 안의 `/run/uimori-secrets/service-account.json`을 읽기 전용으로 연결하고 Gemini 요청을 Flex로 고정해요. [Compose 읽기 전용 bind mount](https://docs.docker.com/reference/compose-file/services/#volumes)

```sh
docker compose --env-file .env.self-host -f compose.yaml -f deploy/compose.vertex.example.yaml up --build -d
```

이 구성을 선택했으면 이후 `up`, `down`, `logs`에도 같은 두 `-f` 옵션을 사용해요. 서버의 누적 호출 수·금액 제한은 없으며 작업별 호출·시간·출력 한도는 유지해요. 실제 청구 금액은 추정하지 않아요.

컨테이너 안의 `127.0.0.1`은 그 컨테이너 자신이에요. PC나 Docker 호스트에 있는 호환 API를 이 주소로 설정하면 연결되지 않아요. 현재 공급자 정책은 비-loopback HTTP를 허용하지 않으므로, 별도 서버는 접근 가능한 HTTPS 주소와 outbound origin 허용 설정을 사용하세요.

## 저장과 운영

DB는 Compose의 `data` named volume 안의 `/data/uimori.sqlite`에 저장돼요. 큰 자료를 가져오는 동안에는 같은 볼륨의 `/data/uploads`에 임시 파일을 두고 등록이 끝나면 지워요. 실제 볼륨 이름은 `.env.self-host`의 `UIMORI_DATA_VOLUME`이며 기본값은 기존 `uimori_data`예요. 초기 volume은 이미지에서 준비한 UID 1000 소유 디렉터리를 사용해요. 프로그램 이미지를 다시 빌드하거나 컨테이너를 교체해도 volume은 유지돼요. 같은 DB를 여러 앱 프로세스에 연결하거나 `app`을 복제하지 마세요. [Docker volume의 수명과 초기 복사](https://docs.docker.com/engine/storage/volumes/)

```sh
# 중지: DB volume 유지
docker compose --env-file .env.self-host down

# 코드 업데이트를 반영한 뒤 이미지 재빌드·시작
docker compose --env-file .env.self-host build --pull
docker compose --env-file .env.self-host pull proxy
docker compose --env-file .env.self-host up -d

# 인증서 파일 갱신 후 문법/파일 접근 확인·재시작
docker compose --env-file .env.self-host exec proxy nginx -t
docker compose --env-file .env.self-host restart proxy
```

데이터를 유지하려면 `down`에 `-v`를 붙이지 마세요. Compose 프로젝트 이름은 기본 `uimori`로 고정돼요. 데이터 전환과 복구에서는 이미지 태그와 호환되는 `UIMORI_DATA_VOLUME`을 함께 지정해요. 현재 앱은 빈 DB와 현재 schema 21 DB만 열어요. 구형 DB를 올리는 migration이나 구형 archive 복원은 제공하지 않아요. 기존 volume은 보관하고, 이 구조로 새로 시작할 때는 별도의 빈 volume을 지정해요. 현재 버전은 [DB·archive·백업 버전](DATA-MIGRATIONS.md#현재-버전)을 봐요. 업데이트 전 백업과 실행 이미지 정보를 함께 보관해요. 운영자용 update controller는 아래 [한 번의 업데이트](#한-번의-업데이트)에 있어요. 앱 안의 Update 버튼과 일반 사용자를 위한 자동 복구 흐름은 아직 베타 준비 중이에요.

프로그램과 Docker 서비스가 정상적으로 재시작되면 `restart: unless-stopped`가 앱·프록시를 다시 시작해요. 서버 중지로 끊긴 모델 작업은 자동 재호출하지 않아요. 브라우저만 닫았다면 서버의 생성 작업은 계속 진행되고, 다시 로그인해 저장된 진행 상태와 결과를 볼 수 있어요.

### 한 번의 업데이트

새 이미지로 옮길 때는 `npm run update -- start --config <설정> --image <참조> --key <요청 키>`를 사용해요. 유지보수 게이트를 닫고, 진행 중인 작업이 끝나기를 기다리고, 앱을 정지해 data volume을 백업한 뒤, 그 백업으로 만든 **새 volume**에서 후보 이미지의 현재 DB 기준선·읽기만 확인하고, 확인이 끝나야 이미지와 volume을 함께 바꾸고 쓰기를 다시 열어요. 이미지·volume 전환 단계가 끝나기 전의 실패·취소는 이전 구성을 복구하려고 시도해요. 전환이 끝난 뒤에는 쓰기 재개가 실패해도 자동으로 되돌리지 않아요. 절차와 설정 예시는 [업데이트](UPDATES.md#operator-cli)를 봐요. 기존 DB가 구형이면 후보 검증에서 거절되며 이 CLI가 데이터를 변환하지 않아요. 실제 Docker 호스트에서의 검증은 아직 남아 있어요.

### 유지보수 모드

업데이트 전후로 **새 저장·생성·가져오기만 잠시 멈추는** 유지보수 모드를 앱이 직접 제공해요. 설정의 **내보내기와 복원 → 유지보수 모드**에서 현재 상태를 보고 시작·재개할 수 있어요. 상태 조회는 `GET /api/maintenance`, 전환은 `POST /api/maintenance`의 `{"status":"closed","reason":"update"}`·`{"status":"open"}`이에요. 접속 토큰이 필요한 다른 API와 같은 인증을 사용해요.

```sh
curl -sS -X POST https://story.example.com/api/maintenance \
  -H 'Content-Type: application/json' -H 'Origin: https://story.example.com' \
  -b "$COOKIE" -d '{"status":"closed","reason":"update"}'
```

닫힌 상태에서는 읽기와 진행 중인 작업의 **취소·건너뛰기**만 받고, 새 요청은 `503 MAINTENANCE_CLOSED`로 거절해 브라우저 화면에 유지보수 안내를 표시해요. 이미 승인된 실행은 계속 끝나고 결과를 저장하며, 그 결과가 만든 후속 작업은 큐에 남고 새 외부 호출로 시작하지 않아요. 닫힌 상태는 DB에 남으므로 재시작해도 유지돼요. `activeWork`로 아직 정리 중인 작업 수를 확인한 뒤 앱을 정지해요.

`UIMORI_MAINTENANCE=1`로 시작하면 **후보 검증 부팅**이에요. 현재 DB 기준선 검사와 읽기만 수행하고 작업 복구·worker를 시작하지 않으며, 이 모드는 API로 열 수 없어요(`409 MAINTENANCE_BOOT`). 복사한 data로 새 이미지의 현재 DB 읽기 경로를 확인할 때 사용해요.

앱의 **내보내기와 복원 → SQLite 백업 다운로드**로 일관된 백업을 받아 별도로 보관할 수 있어요. 현재 형식만 복원할 수 있어요. 구형 데이터를 자동 변환하거나 삭제하지 않아요. 백업·컨테이너 전환은 [업데이트 CLI](UPDATES.md)를 봐요. 실행 중 DB 파일 하나만 복사하면 WAL의 변경분을 놓칠 수 있어요.

## 프록시와 접속 조건

기본 [Compose](../compose.yaml)는 프록시의 HTTPS 포트만 호스트에 공개해요. 앱의 `4310`은 Docker 네트워크 안에 두고, `UIMORI_HOST=0.0.0.0`은 컨테이너 내부 수신에만 사용해요. 앱 포트를 호스트에 추가 공개하지 마세요. 원격 모드의 HTTPS는 이 TLS 종료·네트워크 구성으로 보장하며 앱은 전달된 `X-Forwarded-*`를 HTTPS나 인증의 증거로 신뢰하지 않아요.

개인 서버 모드는 `UIMORI_TEST_MODE`와 함께 시작할 수 없어요. 저장·로그인·로그아웃 같은 변경 요청은 정확한 `Origin` 헤더가 필요하며 브라우저는 이를 자동으로 보내요. 별도 HTTP 클라이언트를 사용할 때에도 `Origin: https://설정한-주소`를 전달해야 해요. `UIMORI_PROVIDER_ORIGINS`는 모델 호출 허용 목록이라 브라우저 주소 허용 설정으로 사용하지 않아요.

[Nginx 설정](../deploy/nginx.conf)은 요청의 원래 `Host`와 `Origin`을 그대로 전달해 앱이 `UIMORI_PUBLIC_ORIGIN`과 비교하게 해요. 임의 Host를 허용된 Host로 덮어쓰면 이 검사가 약해져요. SSE용 응답 버퍼링·캐시는 끄고 응답 읽기 간격 제한을 3600초로 설정했어요. Docker DNS를 다시 조회하므로 앱 컨테이너 교체 후 새 주소를 사용해요. [Nginx Host 전달·버퍼링·timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [DNS resolver](https://nginx.org/en/docs/http/ngx_http_core_module.html#resolver)

프록시 요청 본문 한도는 native transfer·archive import의 256 MiB 파일에 요청 wrapper 여유를 더한 257 MiB예요. 서버는 RISU 본문 검사 24 MiB, 원문·번역 직접 저장 8 MiB 등 더 작은 route별 한도를 계속 적용해요. 원본 CHARX staged 업로드와 채팅 백업도 각각 256 MiB까지 받아요. [Nginx 본문 크기 제한](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)

다른 리버스 프록시를 사용한다면 동일한 조건을 유지해요. 호스트에서 앱을 직접 실행할 때는 Node `>=24.14.0 <25`, 빌드 산출물, 영구 `UIMORI_DB` 경로를 준비하고 `UIMORI_HOST=127.0.0.1`로 프록시만 접근하게 할 수 있어요. `/uimori` 같은 하위 경로 배포는 지원하지 않아요.

## 첫 접속 확인

`app`의 healthy 상태와 `proxy` 실행을 확인한 뒤 사용할 기기에서 HTTPS 접속·로그인·저장을 확인해요. 내부 healthcheck는 TLS를 검사하지 않으므로 인증서와 공개 주소는 브라우저에서 확인해요. 추가 검사는 설치 환경과 문제가 있는 동작에 맞춰 선택해요.

## Codex 구독 연결

공식 Codex App Server를 선택적으로 설치해 본문·보조 실행에 사용할 수 있어요. Docker 빌드 변수, 전용 로그인 보관과 검증 범위는 [Codex 연결 안내](CODEX.md)를 따라요. 기본값은 비활성이며 API 키 방식으로 자동 전환하지 않아요.

## 라이선스와 대응 소스

Uimori 소스에는 [AGPL-3.0-only](../LICENSE)를 적용하고 [제3자 고지](../THIRD_PARTY_NOTICES.md)를 함께 제공해요. 배포자는 이용자가 앱에서 쉽게 찾을 수 있는 소스 안내를 유지하고, 배포 빌드와 정확히 일치하는 대응 소스를 무료로 받을 수 있는 위치를 연결해요. 수정한 소스와 빌드·설치에 필요한 파일도 포함하고 비밀 키·사용자 DB·개인 자료는 포함하지 않아요.

공개 저장소는 [woduseh/Uimori](https://github.com/woduseh/Uimori)예요. 배포 revision이 그 저장소에 실제 공개되어 있고 다운로드할 수 있는지 확인한 뒤 해당 revision의 소스 링크를 안내해요. 로컬 수정이나 미공개 커밋으로 빌드했다면 그 수정까지 포함하는 대응 소스를 먼저 제공해야 해요.
