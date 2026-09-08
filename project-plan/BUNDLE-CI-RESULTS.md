# 화면 지연 로딩·CI 수정 결과

2026-09-08 작업이에요. 앞선 [코드·문서·하네스 정리](MAINTENANCE-RESULTS.md) 이후 500kB 빌드 경고와 [GitHub Actions 실패](https://github.com/woduseh/Uimori/actions/runs/34172491787/job/101895356981)를 조사했어요.

## 변경

- 서재, 프롬프트, 새 채팅, 채팅 설정, 앱 설정·작업 현황·보관된 전개는 기존 화면 단위로 지연 로딩해요. `main.tsx`의 정적 import를 `deferredPanel`로 바꾸고 실제 화면 내용이나 Dialog의 mount·key·visited 조건은 유지했어요. `refValue`를 가벼운 모듈로 옮겨 정적 재유입을 끊었고, 사용처가 없어진 `ProviderSettings` 재수출 파일을 제거했어요.
- 패널별 로딩 안내와 오류 경계를 두어 파일 다운로드 실패가 앱 전체를 내리지 않아요. 자동 새로고침으로 작성 중인 내용을 잃지 않으며, 실패한 화면에서 연결 확인과 내용 보관 후 새로고침을 안내해요. 다른 화면에서도 사용하는 폼·연결 알림 CSS는 공용 스타일로, 공급자 전용 규칙은 공급자 스타일로 옮겼어요.
- `quality:full`의 순서를 **quality → build → test**로 바꿨어요. 기존 CI는 build 이전에 테스트를 실행해 `dist/server/index.js`를 사용하는 실제 재시작 테스트가 실패했어요. 정상 빌드는 기존 dist를 지운 뒤 서버·웹·build identity를 새로 만들어요. CI workflow는 같은 npm 명령을 사용하므로 별도 실행 순서가 필요하지 않아요.
- 100-source reader 테스트의 반복 admission/프롬프트 컴파일을 합성 데이터 준비에서 제외했어요. typed RunSnapshot에 전체 ancestry를 저장하고 실제 source 완료·hash·branch·보조예약 API를 사용해요. 원문 100개·20페이지·마지막 snapshot의 99개 history 보존을 유지하고 FK 및 history id/text/hash 일치를 확인해요. 다른 작은 테스트의 실제 admission 경로와 15초 timeout은 유지했어요.

[React lazy 공식 계약](https://react.dev/reference/react/lazy)에 따라 컴포넌트 정의는 모듈 최상위에 고정하며 Suspense와 Error Boundary를 사용해요. [Vite의 chunk 경고](https://vite.dev/config/build-options.html#build-chunksizewarninglimit)는 개별 압축 전 JS 크기를 기준으로 하므로, 단일 entry 크기와 실제 진입 화면의 초기 JS 합계를 구분해요. 경고 임계값이나 수동 vendor chunk 설정은 변경하지 않았어요.

## 검증

크기는 압축 전 JS이며 kB는 1,000 bytes 기준이에요. 변경 전에는 JS 파일 한 개가 모든 화면을 포함했어요. 변경 후 초기 합계는 실제 Chrome의 `PerformanceResourceTiming.decodedBodySize`를 화면 표시 후 합산했어요.

| 항목 | 변경 전 | 변경 후 | 차이 |
| --- | ---: | ---: | ---: |
| 가장 큰 JS chunk | 705.33kB | 375.19kB | 46.8% 감소, 500kB 경고 없음 |
| 서재 `/` 초기 JS 합계 | 705.33kB | 521.86kB | 26.0% 감소 |
| 채팅 `/?chat=…` 초기 JS 합계 | 705.33kB | 412.66kB | 41.5% 감소 |
| 모든 화면 JS 합계 | 705.33kB | 710.98kB | 분할·오류 처리 등을 포함해 0.8% 증가 |

첫 서재 진입에서는 LibraryPanel과 공통 모듈을 바로 받으며, 설정과 프롬프트 제작기는 받지 않아요. 채팅 직접 진입에서는 서재도 받지 않아요. 전체 코드량이나 처리 시간의 감소를 주장하는 수치가 아니에요. [이전 산출물](../output/bundle-ci-2026-09-08/baseline.json) · [최종 산출물](../output/bundle-ci-2026-09-08/bundle-final.json) · [서재 요청](../output/bundle-ci-2026-09-08/library-entry-scripts.json) · [채팅 요청](../output/bundle-ci-2026-09-08/chat-entry-scripts.json)

`quality:full`은 새 순서로 실행해 **1,263 PASS · 1 opt-in skip**, 실제 compiled server 재시작 검사를 포함해 통과했어요. 그 후 변경은 공용 CSS 위치와 브라우저 검증의 화면 대기·스크린샷에 한정하며, 최종 `quality`와 빌드도 통과했어요. opt-in skip은 설치된 Codex CLI 사전 검사예요. [전체 로그](../output/bundle-ci-2026-09-08/quality-full.log) · [최종 품질 검사](../output/bundle-ci-2026-09-08/quality-final.log) · [최종 빌드](../output/bundle-ci-2026-09-08/build-final.log)

reader 단일 테스트의 로컬 비교는 약 8.9초 → 0.3초였고 reader 10/10도 통과했어요. 대량 데이터 준비 경로를 바꾼 결과이며 제품 reader 속도나 GitHub runner의 실행 시간을 나타내지 않아요.

첫 전체 브라우저는 **122 PASS · 1 FAIL**이었어요. 새 LAZY01–03은 모두 통과했으나, 기존 `UI07 UI09 legacy branches` 단언이 `allTextContents()`로 로딩 중 빈 목록을 즉시 읽었어요. 기존 값 검증을 유지하며 `expect.poll`로 표시를 기다리게 수정했어요. 첫 summary·trace·화면은 그대로 보존해요. 이 테스트 대기 수정 전후 제품 dist hash가 같음을 확인했어요. [첫 실패 증거](../output/playwright/redesign-2026-09-08T00-34-18-556Z-499e2df6/summary.json)

최종 전체 브라우저는 **123/123 PASS · 실패/skip/재시도 0**이에요. LAZY01–03에서 화면별 초기 JS 요청, 설정 다운로드 지연·실패 중 초안 보존, 다른 채팅 설정 화면의 정상 진입을 확인했어요. 기존 편집 초안·설정 탭·Dialog·보관된 전개 회귀도 통과했어요. 검증 종료 source/build 일치, cleanup PASS, live PID 0과 임시 runtime 제거를 확인했어요. [최종 summary](../output/playwright/redesign-2026-09-08T00-38-30-854Z-fa26166e/summary.json) · [로딩 검사·화면·요청 증거](../output/bundle-ci-2026-09-08/browser-evidence.json)

최종 source/build는 `44fe90ef5b5c823cb4d6750a3608d23ca7ea727edd729cfadea1a6c172069bed`, dist는 `75fb8fba60bf6322ad2c3a21b00954371898241f64c1cd1a8d8e8cf5dfdb3a67`예요. GitHub의 원래 실패 로그는 [발췌](../output/bundle-ci-2026-09-08/ci-failure-extract.txt)에 보존해요. **수정 후 GitHub Actions는 아직 재실행하지 않았어요.** 로컬 Windows·Node 24.14의 합성 검증이며 실제 provider·사용자 DB·휴대폰이나 배포 검증을 포함하지 않아요.
