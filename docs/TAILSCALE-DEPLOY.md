# Tailscale로 개인 서버 접속하기

이미 구성된 Oracle 인스턴스의 주소는 [https://uimori.taila7874d.ts.net/](https://uimori.taila7874d.ts.net/)예요. 기본 HTTPS 포트 443을 사용하므로 주소에 포트 번호를 붙이지 않아요. 앱 업데이트는 [커밋·푸시·Oracle 업데이트](ORACLE-RELEASE.md)를 봐요. 아래는 최초 구성과 일반 운영 안내예요.

[개인 서버 안내](SELF-HOST.md)의 인증·공급자·저장 조건을 유지하고, 호스트의 Tailscale이 HTTPS를 처리하는 배포 방법이에요. Docker와 Tailscale이 설치되고 같은 tailnet에 연결된 Linux 서버를 전제로 해요.

`compose.tailscale.yaml`은 기본 `compose.yaml`과 합치지 않고 단독으로 사용해요. 앱은 호스트의 `127.0.0.1:4310`에서만 접근할 수 있고 DB는 고정 프로젝트 `uimori`의 `data` named volume에 보관해요. Nginx나 별도 TLS 파일은 필요하지 않아요. 기존 서비스가 443을 사용하면 다른 허용 포트인 8443으로 구분할 수 있어요.

## 앱 시작

저장소 루트의 `.env.self-host`를 권한 600으로 만들고 아래 값을 설정해요. 이 파일은 Git과 Docker 빌드 문맥에서 제외돼요.

```dotenv
NR_PUBLIC_ORIGIN=https://machine.tail-example.ts.net
NR_ACCESS_TOKEN=replace-with-output-from-openssl-rand-hex-32
NR_PROVIDER_ORIGINS=
# Optional: use the deployed Git commit as the image tag.
UIMORI_IMAGE_TAG=local
```

`NR_PUBLIC_ORIGIN`에는 실제 Tailscale 호스트 이름을 넣어요. 기본 HTTPS 포트 443은 생략하고, 8443을 선택했다면 주소에도 `:8443`을 붙여요. `NR_ACCESS_TOKEN`에는 `openssl rand -hex 32`로 생성한 값을 넣어요. 예시 토큰을 그대로 사용하지 마세요. 모델 API 키와 선택적 Codex 설정은 [개인 서버 안내](SELF-HOST.md)를 따라요.

```sh
chmod 600 .env.self-host
docker compose --env-file .env.self-host -f compose.tailscale.yaml config --quiet
docker compose --env-file .env.self-host -f compose.tailscale.yaml up --build -d
docker compose --env-file .env.self-host -f compose.tailscale.yaml ps
```

## 접속 공개 범위 선택

먼저 `tailscale serve status --json`으로 기존 설정을 확인하고, 사용하지 않는 포트를 선택해요. 아래 명령은 443 설정을 변경하므로 같은 포트에 다른 서비스가 있으면 실행하지 마세요. 8443을 선택하면 명령의 포트와 `NR_PUBLIC_ORIGIN`을 함께 바꿔요. 전체 설정을 지우는 `reset`은 사용하지 않아요.

같은 tailnet의 기기에서만 접속하려면:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4310
```

휴대폰에서 Tailscale 연결 없이 접속하려면:

```sh
sudo tailscale funnel --bg --https=443 http://127.0.0.1:4310
```

Funnel은 인터넷에 로그인 화면을 공개해요. Tailscale 기기 인증으로 방문자를 제한하는 방식이 아니므로 Uimori 접속 토큰을 반드시 유지해요. 최초 실행 때 계정에서 Funnel 사용 승인이 필요할 수 있어요. 같은 포트에서 Serve와 Funnel을 동시에 사용할 수 없으며 마지막으로 적용한 모드가 그 포트의 공개 범위를 결정해요. Funnel은 현재 베타이며 대역폭 제한이 있어요. [공식 Serve 안내](https://tailscale.com/docs/features/tailscale-serve), [공식 Funnel 안내](https://tailscale.com/docs/features/tailscale-funnel)

서버 서비스와 백그라운드 설정이 유지되면 PC를 꺼도 HTTPS 주소로 접속할 수 있어요. 브라우저에서 Uimori 접속 토큰을 입력해 로그인해요. AdGuard 등 휴대폰의 다른 VPN 앱을 사용할 때도 Funnel 접속 자체에는 Tailscale 앱 연결이 필요하지 않아요.

## 접속 이름이나 포트 변경

Tailscale 기기 이름은 `sudo tailscale set --hostname=<새이름>`으로 바꿀 수 있어요. MagicDNS가 켜져 있으면 접속 도메인도 바뀌어요. [공식 이름 변경 안내](https://tailscale.com/docs/concepts/machine-names)

이미 운영 중인 앱에서는 이름만 바꾸면 기존 `NR_PUBLIC_ORIGIN`과 새 Host가 달라져 접속이 거절돼요. 현재 라우팅·환경 설정과 복구 방법을 보관하고, 활성 작업이 없는지 확인한 뒤 짧은 전환 구간에 다음 내용을 함께 적용해요.

1. 앱을 정지하고 현재 데이터와 환경 설정을 백업해요. 같은 앱 이미지와 데이터 volume을 유지해요.
2. 기존 포트의 설정을 해당 `serve` 또는 `funnel` 명령에 원래 flags와 `off`를 붙여 제거하고, 기기 이름을 변경해 새 DNS 이름을 확인해요. 예를 들어 기존 백그라운드 Funnel 8443은 `sudo tailscale funnel --bg --https=8443 off`로 해제해요. 다른 서비스의 설정은 유지해요.
3. 서버 `.env.self-host`의 `NR_PUBLIC_ORIGIN`을 새 주소로 바꾸고, 같은 Compose 파일로 `up -d --no-build app`을 실행해요. 새 이름·포트로 기존 공개 범위에 맞는 Serve 또는 Funnel을 설정해요.
4. Oracle 배포 도구의 로컬 `accessEnvFile`도 같은 origin으로 맞춰요. 접근 토큰과 다른 설정은 유지해요.
5. 인증서, 로그인, 기본 API, 앱 health와 데이터 보존을 확인해요. DNS·인증서 준비 중 발생한 실패와 이후 성공은 구분해서 기록해요. 실패하면 저장해 둔 이전 이름·라우팅·환경 설정으로 복구해요.

도메인을 바꾸면 브라우저 origin도 달라져요. 새 주소에서 기존 접속 토큰으로 다시 로그인하고 즐겨찾기를 갱신해요. 예전 origin의 브라우저 초안·저장 정보는 자동으로 새 주소에 옮겨지지 않으므로 전환 전에 필요한 입력을 저장해요. [Funnel 해제·백그라운드 실행 안내](https://tailscale.com/docs/reference/tailscale-cli/funnel)

## 배포 확인과 운영

- 인증서 경고 없이 HTTPS로 열리고, 로그인 전 `/api/library`와 `/api/export`가 401인지 확인해요.
- 허용하지 않은 Host·Origin이 거절되고, 로그인·저장·실시간 갱신이 작동하는지 확인해요. 앱은 원래 공개 Host·Origin을 검사하므로 프록시에서 이 값을 임의로 바꾸지 않아요.
- `4310`이 loopback에서만 수신하는지, 기존 다른 서비스의 접속 설정이 유지되는지 확인해요.
- 재시작 후 다시 로그인해 저장 내용이 유지되는지 확인하고 SQLite 백업은 별도로 보관해요.
- 업데이트는 같은 Compose 파일과 프로젝트 이름을 사용하고, 데이터를 유지하려면 `down -v`를 실행하지 않아요. 구형 DB 자동 이관은 제공하지 않아요.

기본 `compose.yaml`과 이 파일을 같은 프로젝트에서 동시에 실행하지 마세요. 기존 Nginx 구성에서 전환하는 경우에는 해당 프로젝트의 서비스와 데이터 volume을 먼저 확인해요.
