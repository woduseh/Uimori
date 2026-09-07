# 개인용 self-host 구현과 검증

기준일: 2026-09-07. 기존 봇 작업실·패키지 행동 작업은 `e707c28`에 커밋했어요. 그 뒤 한 사람이 PC와 휴대폰에서 같은 작업실을 쓰는 개인 서버 모드를 추가했어요. 사용 안내는 [SELF-HOST](../docs/SELF-HOST.md)예요.

## 구현

- `server/network-policy.ts`, `server/index.ts`, `server/app.ts`: `NR_PUBLIC_ORIGIN`에 명시한 HTTPS origin 하나를 허용해요. 원격 모드는 공백 없는 32–1000자 접속 토큰이 필요하고 test mode와 함께 시작할 수 없어요. `NR_HOST`의 비-loopback 수신은 원격 모드에서만 허용해요. 잘못된 배포 설정은 DB 생성 전에 거부해요.
- 원래 `Host`와 브라우저 `Origin`을 검사하고 변경 요청은 정확한 Origin을 요구해요. `X-Forwarded-*`를 권한 근거로 사용하지 않아요. TLS 종료는 프록시가 맡으며 앱 HTTP 포트는 외부에 공개하지 않아요.
- `server/access-session.ts`, `server/product-routes.ts`: HttpOnly·Secure·SameSite=Strict 세션, 절대 만료 12시간, 최대 32개 세션, 실패 10회부터 고정 15분 창의 새 로그인 제한이에요. 재시작·로그아웃·만료·용량 폐기는 세션을 무효화해요. 인증 실패·응답·로그에 접속 토큰을 포함하지 않아요.
- 기존 인증 검사가 인코딩된 URL 원문만 보던 결함을 수정했어요. 신선한 격리 DB에서 무인증 `/%61pi/library`와 `/%61pi/export`가 200을 반환하는 것을 재현했어요. 수정 후 실제 매칭된 API 경로를 기준으로 검사하며 인코딩된 library·export·backup·assets·reader와 세션 예외를 검증해요.
- `web/api.ts`, `web/SessionGate.tsx`: API 401과 브라우저 복귀 시 현재 세션을 다시 확인하고 필요하면 로그인 화면으로 돌아가요. 이전 응답이 새 로그인 상태를 덮지 않도록 요청 revision을 검사해요. 미전송 초안과 토큰을 서버에 자동 재전송하지 않아요.
- `Dockerfile`, `compose.yaml`, `deploy/`: Debian Node 24, 앱 한 프로세스·non-root·읽기 전용 rootfs, SQLite named volume, HTTPS만 공개하는 Nginx, SSE 버퍼링 해제·64 MiB 요청 상한·컨테이너 교체 후 DNS 재조회·자동 재시작 구성이에요. 실제 환경변수·인증서·키는 빌드 문맥에 포함하지 않아요.
- `scripts/verify-self-host.mjs`: 공개 합성 인증서의 실제 로컬 HTTPS 프록시와 별도 데스크톱/390px Chromium 세션을 사용하는 검증 명령을 추가했어요. 표준 loopback 브라우저 회귀의 skip 수에 영향을 주지 않아요.

## 검증

타입 검사와 빌드를 통과했고, 전체 단위·통합 **964/964**, 기존 브라우저 **55/55**, 전용 HTTPS 브라우저 **2/2**가 통과했어요. 실패·skip은 없으며 두 브라우저 실행의 소스 일치·cleanup도 PASS예요.

| 근거 | 결과 |
| --- | --- |
| `npm run check`, `npm run build` | PASS. Vite의 530.07KB 청크 크기 경고는 남아 있어요. |
| [전체 단위·통합](../output/self-host/unit-tests.json) | 964 PASS / 0 FAIL / 0 skip |
| [기존 브라우저](../output/playwright/redesign-2026-09-07T10-07-31-903Z-d3161335/summary.json) | 55 PASS / 0 FAIL / 0 skip, cleanup PASS |
| [전용 HTTPS 브라우저](../output/playwright/self-host-2026-09-07T10-10-08-300Z-5302cfc8/summary.json) | 2 PASS / 0 FAIL / 0 skip, cleanup PASS |
| HTTPS 프록시 관찰 | 요청 131회, SSE 연결 8개·15,515 bytes, upstream 오류 0 |
| `git diff --check` | PASS |

전체 단위·기존 브라우저의 source/build는 `108b0e6774905191eb8b9241a35ed3ea311b09d6505f7efe4ee24cdb8856abbc`예요. 이후 **전용 Playwright 테스트의 `test.use` 위치만** 수정하고 타입·빌드와 해당 HTTPS 검사를 다시 실행했어요. 최종 HTTPS source/build는 `bfc4601a8657bbfc835878717b64cc3cb7bd41ca467a8f8b3096b186a8b7e93e`이며 두 빌드의 제품 dist hash는 모두 `24e4a8363fdf691ece6cfb0af798ccc5bab11c2aac3bf0ad3a36720376fbdcb3`예요. 제품 코드가 바뀌지 않아 이미 통과한 전체 검사를 반복하지 않았어요.

[1440px 화면](../output/playwright/self-host-2026-09-07T10-10-08-300Z-5302cfc8/browser/self-host-browser-personal-911fb-e-HTTPS-SSE-across-re-entry/https-desktop-shared-source.png)과 [390px 화면](../output/playwright/self-host-2026-09-07T10-10-08-300Z-5302cfc8/browser/self-host-browser-personal-911fb-e-HTTPS-SSE-across-re-entry/https-mobile-shared-source-390.png)을 직접 확인했어요. 같은 저장 원문과 상단 조작·하단 입력을 확인했고 수평 넘침은 없었어요. 기기별 세션·실제 SSE 갱신·탭 재진입·세션 폐기 후 UI 재로그인도 검사했어요.

처음 전용 실행의 [spawn EPERM에 따른 BLOCKED](../output/playwright/self-host-2026-09-07T10-07-23-235Z-6d97a5fc/summary.json)와 [Playwright 옵션 위치 오류에 따른 FAIL](../output/playwright/self-host-2026-09-07T10-07-47-562Z-2181b5ac/summary.json)도 보존했어요. 두 실행 모두 테스트 수집/실행 전이라 통과 수는 0이에요. 권한이 허용된 실행과 테스트 설정 수정 후 위 최종 PASS를 얻었어요.

검증 완료 후 같은 작업트리의 Risu 이식 가이드·전용 변환기 정리 작업에 소스 수정을 넘겼어요. 그 후속 변경의 검증은 이 기록에 포함하지 않아요. self-host 후속 변경은 작업트리에 남겨두었고 추가 커밋·push하지 않았어요.

배포 번들의 YAML 구문·healthcheck JavaScript 구문·앱 포트 비공개·한 프로세스·읽기 전용 mount·업로드 상한 정합·문서 링크는 [정적 확인 결과](../output/self-host/bundle-review.json)에 기록했어요. 이는 Docker의 `compose config`, 이미지 빌드, `nginx -t` 실행 결과가 아니에요.

## 확인하지 못한 범위

현재 호스트에 Docker·Nginx 실행 파일과 설치된 WSL 환경이 없어요. 실제 Linux 컨테이너 빌드·기동, 도메인/DNS·정식 인증서·외부 방화벽·실제 휴대폰 브라우저·키보드·백그라운드 복귀는 미검증이에요. 원격 서버에 배포하거나 외부 모델을 호출하지 않았어요.

HTTPS 브라우저 검사는 공개 합성 자체 서명 인증서를 사용하고 인증서 오류를 무시해요. TLS 요청·쿠키·Origin·스트림 동작을 검사하지만 실서비스 인증서 신뢰를 입증하지 않아요. 모의 생성은 즉시 완료되므로 장시간 실제 공급자 실행 중 모바일 연결 단절의 결과도 입증하지 않아요.

배포 전 하위 호환은 제공하지 않아요. 저장소의 개발 DB 초기화와 영구 서버 volume의 운영은 별도이며, 이번 작업에서 서버 volume을 만들거나 삭제하지 않았어요. 여러 사용자 계정·권한 격리와 DB 다중 프로세스 실행도 지원 범위가 아니에요.
