# 개인 서버에서 사용하기

[시작하기](../README.md) · [프로바이더](PROVIDERS.md)

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

마지막 명령의 결과를 `.env.self-host`의 `NR_ACCESS_TOKEN`에 넣고 아래 값을 실제 서버에 맞춰 편집해요. 빈 토큰으로는 시작하지 않아요. 이 파일은 Git과 Docker 빌드 문맥에서 제외돼요.

| 변수 | 값과 의미 |
| --- | --- |
| `NR_PUBLIC_ORIGIN` | `https://story.example.com`처럼 브라우저가 사용할 HTTPS origin 하나. 경로·후행 `/`·query·fragment는 넣지 않아요. |
| `NR_ACCESS_TOKEN` | 공백 없는 무작위 접속 토큰 32–1000자. 위 명령은 64자리 hex를 생성해요. |
| `UIMORI_TLS_DIR` | 두 TLS 파일이 있는 서버의 절대 디렉터리. |
| `UIMORI_HTTPS_PORT` | 기본 `443`. `8443`이면 public origin에도 `:8443`을 넣어요. |
| `NR_PROVIDER_ORIGINS` | 공식 공급자 주소는 기본 허용해요. 사용자 지정 API의 추가 허용 origin을 쉼표로 나열해요. public origin과 별도이며 공식 프로바이더만 쓰면 비워둬요. |

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

`.env.self-host`는 앱 컨테이너의 서버 환경변수로도 전달돼요. 사용할 공급자의 키를 추가한 뒤 컨테이너를 갱신하세요. 키에 `$`나 `#`가 있으면 값을 작은따옴표로 감싸서 Compose 보간·주석 처리를 피하세요.

```dotenv
NR_PROVIDER_ORIGINS=https://api.openai.com
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

DB는 Compose의 `data` named volume 안의 `/data/narrative.sqlite`에 저장돼요. 실제 볼륨 이름은 `.env.self-host`의 `UIMORI_DATA_VOLUME`이며 기본값은 기존 `uimori_data`예요. 초기 volume은 이미지에서 준비한 UID 1000 소유 디렉터리를 사용해요. 프로그램 이미지를 다시 빌드하거나 컨테이너를 교체해도 volume은 유지돼요. 같은 DB를 여러 앱 프로세스에 연결하거나 `app`을 복제하지 마세요. [Docker volume의 수명과 초기 복사](https://docs.docker.com/engine/storage/volumes/)

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

데이터를 유지하려면 `down`에 `-v`를 붙이지 마세요. Compose 프로젝트 이름은 기본 `uimori`로 고정돼요. 데이터 전환과 복구에서는 이미지 태그와 호환되는 `UIMORI_DATA_VOLUME`을 함께 지정해요. 구버전 데이터를 사용하지 않기로 결정했다면 새 볼륨에서 현재 schema의 빈 DB를 초기화해요. 자동 이관은 제공하지 않아요.

프로그램과 Docker 서비스가 정상적으로 재시작되면 `restart: unless-stopped`가 앱·프록시를 다시 시작해요. 서버 중지로 끊긴 모델 작업은 자동 재호출하지 않아요. 브라우저만 닫았다면 서버의 생성 작업은 계속 진행되고, 다시 로그인해 저장된 진행 상태와 결과를 볼 수 있어요.

필요할 때 앱의 **내보내기와 복원 → SQLite 백업 다운로드**로 일관된 백업을 직접 받아 별도로 보관할 수 있어요. 구형 DB 자동 이관·자동 백업은 제공하지 않아요. 정식 배포 전 schema 변경은 새 DB를 요구할 수 있으니 업데이트 내용을 확인하세요. 실행 중 DB 파일 하나만 복사하면 WAL의 변경분을 놓칠 수 있어요.

## 프록시와 접속 조건

기본 [Compose](../compose.yaml)는 프록시의 HTTPS 포트만 호스트에 공개해요. 앱의 `4310`은 Docker 네트워크 안에 두고, `NR_HOST=0.0.0.0`은 컨테이너 내부 수신에만 사용해요. 앱 포트를 호스트에 추가 공개하지 마세요. 원격 모드의 HTTPS는 이 TLS 종료·네트워크 구성으로 보장하며 앱은 전달된 `X-Forwarded-*`를 HTTPS나 인증의 증거로 신뢰하지 않아요.

개인 서버 모드는 `NR_TEST_MODE`와 함께 시작할 수 없어요. 저장·로그인·로그아웃 같은 변경 요청은 정확한 `Origin` 헤더가 필요하며 브라우저는 이를 자동으로 보내요. 별도 HTTP 클라이언트를 사용할 때에도 `Origin: https://설정한-주소`를 전달해야 해요. `NR_PROVIDER_ORIGINS`는 모델 호출 허용 목록이라 브라우저 주소 허용 설정으로 사용하지 않아요.

[Nginx 설정](../deploy/nginx.conf)은 요청의 원래 `Host`와 `Origin`을 그대로 전달해 앱이 `NR_PUBLIC_ORIGIN`과 비교하게 해요. 임의 Host를 허용된 Host로 덮어쓰면 이 검사가 약해져요. SSE용 응답 버퍼링·캐시는 끄고 응답 읽기 간격 제한을 3600초로 설정했어요. Docker DNS를 다시 조회하므로 앱 컨테이너 교체 후 새 주소를 사용해요. [Nginx Host 전달·버퍼링·timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [DNS resolver](https://nginx.org/en/docs/http/ngx_http_core_module.html#resolver)

프록시 요청 본문 한도는 archive import의 최대 64 MiB에 맞췄어요. 서버는 RISU 검사 24 MiB, 원문·번역 직접 저장 8 MiB 등 더 작은 route별 한도를 계속 적용해요. [Nginx 본문 크기 제한](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)

다른 리버스 프록시를 사용한다면 동일한 조건을 유지해요. 호스트에서 앱을 직접 실행할 때는 Node `>=24.14.0 <25`, 빌드 산출물, 영구 `NR_DB` 경로를 준비하고 `NR_HOST=127.0.0.1`로 프록시만 접근하게 할 수 있어요. `/uimori` 같은 하위 경로 배포는 지원하지 않아요.

## 검증 범위와 첫 접속 확인

self-host 구현 당시 로컬 검증에서는 전체 단위·통합 964개, 기존 브라우저 55개, 전용 HTTPS 브라우저 2개가 통과했어요. Windows의 실제 HTTPS 프록시와 독립적인 데스크톱/390px Chromium 세션으로 인증·실시간 원문 공유·재로그인을 확인했어요. 이 수치는 해당 실행 시점의 결과이며 이후 변경 전체의 재검증을 뜻하지 않아요. 실행 시점·소스 범위·화면은 [검증 결과](../project-plan/SELF-HOST-RESULTS.md), 후속 변경은 [현재 상태](../project-plan/CURRENT.md)에 있어요.

이 번들의 Linux Docker 이미지 빌드·기동과 실제 인증서·도메인·휴대폰 접속은 아직 검증하지 않았어요. 로컬 앱의 합성 검증과 실제 배포 결과를 구분해요. 배포 서버에서 다음을 확인하세요.

- `app`이 healthy이고 `proxy`가 실행 중인지 확인해요. 앱의 내부 healthcheck는 public Host 검사와 로그인 필요 상태를 확인하며 TLS 검사는 아니에요.
- PC·휴대폰 모두 인증서 경고 없이 HTTPS로 접속되고, 로그인 전 채팅 데이터를 가져오지 못하는지 확인해요.
- 로그인 후 합성 자료로 저장·새로고침·다른 기기 조회와 생성 스트리밍을 확인해요. 실제 모델 실행은 사용자가 설정한 공급자·비용 범위에 해당해요.
- 생성 중 브라우저를 닫았다가 열어 상태를 확인하고, 서버 재시작 후 재로그인해 저장된 자료가 유지되는지 확인해요. 모바일 화면·키보드와 백그라운드 복귀도 실제 기기에서 확인해요.

## Codex 구독 연결

공식 Codex App Server를 선택적으로 설치해 본문·보조·모델 등록 에이전트에 사용할 수 있어요. Docker 빌드 변수, 전용 로그인 보관과 검증 범위는 [Codex 연결 안내](CODEX.md)를 따라요. 기본값은 비활성이며 API 키 방식으로 자동 전환하지 않아요.
