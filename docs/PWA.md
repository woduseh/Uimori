# 앱 설치

**설정 → 일반 → 앱 설치**에서 설치하거나 브라우저 메뉴의 `앱 설치`/`홈 화면에 추가`를 사용해요. Chromium이 설치 이벤트를 제공한 경우에만 앱 안에 실제 설치 버튼을 표시해요. 설치를 취소해도 다시 권한을 강요하지 않아요. iPhone·iPad는 공유 메뉴에서 홈 화면에 추가한 뒤 그 아이콘으로 열어요.

manifest의 앱 ID·시작 주소·scope는 `/`로 고정하고 개인 채팅·접속 토큰을 넣지 않아요. 192/512px 아이콘과 별도 maskable/touch 아이콘은 기존 Uimori favicon에서 파생했어요. `standalone` 창에서도 기존 로그인·서버 자료·읽기 위치를 사용해요.

**설치와 오프라인 편집은 별개예요.** service worker는 원고/API 응답을 캐시에 복제하지 않고 fetch·background sync를 등록하지 않아요. 연결이 끊긴 작성 요청을 보관하거나 재연결 시 자동 전송하지 않아요. 기존 브라우저의 편집 초안 보호와 서버 실행 상태 복구는 그대로 유지해요.

`sw.js`와 manifest는 업데이트 시 재검증하며 서비스 워커 등록도 HTTP 캐시를 우회해요. 새 버전이 나왔다고 열린 창과 작성 중 초안을 강제 새로고침하지 않아요. 서비스 워커 새 버전은 일반 브라우저 수명 주기에 따라 활성화돼요. PWA 등록 자체는 알림 권한을 요청하지 않아요.

설치에는 HTTPS 또는 localhost 같은 안전한 컨텍스트가 필요해요. 설치 메뉴와 조건은 브라우저/OS에 따라 달라지므로 메뉴가 없는 환경에서 설치 성공을 흉내 내지 않아요.

검증: `tests/pwa.test.ts`(manifest·PNG·서비스워커 캐시/요청 비개입·정적 자원/인증), `npm run verify:personal-features`(실제 서비스워커 등록, 설치 버튼의 명시적 조작, 알림 권한 자동 요청 없음, 단절/재연결과 CacheStorage 비사용). 설치 대화상자의 사용자 수락을 모사한 검증은 실제 휴대폰 설치 검증을 대신하지 않아요.

참고: [MDN 설치 조건](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [명시적 설치 UI](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt), [WebKit 홈 화면 앱](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
