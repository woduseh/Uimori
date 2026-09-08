# 검사 운영 정리와 전수 점검

2026-09-08~09, `codex/simplify-runtime`. 런타임 간소화에 맞춰 전체 검사 본문을 점검하고 중복을 통합했어요. 이 문서의 개수는 전체 제품 보증이나 실제 창작 품질을 뜻하지 않아요.

## 범위와 판단 기준

현재 단위·통합 132파일, 브라우저 45파일, Node 도구 5파일의 모든 case 본문과 assertion을 점검했어요. 단위 132파일은 a–m 48개 + n–z 82개 + 하네스/아키텍처 2개예요. 매개변수/loop의 정적 선언 수와 실제 실행 수는 구분해요.

- [단위·통합 a–m 전수표](testing-audit-unit-a-m.md): 48파일, 모든 case 제목과 계약군 판단.
- [단위·통합 n–z 전수표](testing-audit-unit-n-z.md): 82파일, 모든 case 제목과 흡수 위치.
- [브라우저 전수표](testing-audit-browser.md): 45파일, 기능·추가 폭·시각 검토 구분과 삭제된 case의 흡수 위치.
- [검증 도구 전수표](testing-audit-tooling.md): Node 5파일 + Vitest 2파일 및 실행기·설정·별도 CLI fault 검사.

같은 단어를 쓰더라도 parser, native wire, DB, HTTP, 브라우저가 서로 다른 실패를 검증하면 유지했어요. 원문/hash 귀속·CAS·이력·권한·취소·불확실 실행·실제 자식 환경·보관 위조·정리 소유권 검사는 검사 수 감소를 위해 제거하지 않았어요.

## 적용한 변경

- 단독 오류 클래스 생성, 이미 검사한 DB 재개방, 얕은 encoder body 존재 검사, 중복 구형 archive 버전 거절을 실제 validator·현재 동작·보관 회귀에 흡수했어요. 번역 구간·앵커 등 폐기된 계약의 assertion은 새 전체 번역 계약으로 바꿨어요.
- 공급자 정의의 고정 개수·revision·날짜를 유일성·등록 프로토콜 전체 대응·유효 버전/날짜 검사로 바꿨어요. 외부 도구 포팅의 정확한 ID·문구 계약은 유지했어요.
- 서재 요약 응답 계약을 검사하기 위해 매번 만들던 자료 110개/자산 1,000개를 자료 4개/자산 3개로 줄였어요. 본문·BLOB 생략, revision/CAS, 응답 크기 비율은 계속 검사해요.
- 브라우저의 페르소나 선택 제한 `PLR01`은 `LIMG02`, 옵션 기본 표시 `PLR04`는 `PLR03`, 패키지 역할·서재 분리 `PKUI02`는 `PKUI01`에 흡수했어요. 추가 폭의 중복 전체 흐름·정밀 정렬·성공 화면 캡처는 시각 검토로 옮겼어요.
- 큰 본문·이력/자산 격리 기능 검사는 기본 유지하고, 성능 warmup·5회 반복·측정 파일은 선택 실행으로 분리했어요. 기존에는 속도 합격 기준 없이 매번 수치만 기록하던 검사였어요.
- 앱 빌드 입력과 전체 검증 입력 지문을 분리했어요. 테스트만 수정하면 재빌드하지 않아도 되고, 실행 중 앱/테스트 변경은 계속 실패로 판정해요. reporter·필수 case·취소·fixture 오류·DB 보존·cleanup 검사는 유지했어요.
- 과거 실패 구간용 live 재시도 실행기의 이미 도달할 수 없던 구현을 종료 응답만 남기고 제거했어요. 일반 live 실행기의 과거 채팅 프롬프트/구간/앵커 시나리오도 종료하고 메타데이터 사전 검사만 유지해요. 새 모델 평가를 수행한 것처럼 표시하지 않으며 과거 결과 파일은 보존해요.

## 실행 선택

| 용도 | 명령 |
| --- | --- |
| 수정 중 정적 검사 | `npm run quality` |
| 수정한 계약 확인 | `npm test -- tests/관련.test.ts` |
| 기본 UI 연결 | 빌드 후 `npm run verify:browser-smoke` |
| 해당 UI 영역 | 빌드 후 기존 `npm run verify:library`, `verify:packages`, `verify:providers` 등 |
| 완료·통합 | `npm run quality:full` |
| 여러 UI 영역 통합 | `npm run verify:redesign` |
| 추가 폭·정밀 배치·성공 화면 | `npm run verify:visual` 또는 `NR_VISUAL_REVIEW=1` + 도메인 실행기 |
| 반복 성능 측정 | `npm run benchmark:story` |

`verify:smoke`는 기존 M0 F02/F03/F06 명령 그대로이고 새 `verify:browser-smoke`와 달라요. 전체 단위·통합 검사는 완료/통합과 CI에서 유지해요. 매 수정마다 전체 브라우저나 benchmark를 요구하지 않아요. 검사 수 목표, 전역 timeout 확장, 무조건 skip, 느슨한 assertion으로 통과시키는 변경은 하지 않았어요.

## 최종 검증

최종 결과는 `quality:full` **PASS**(도구 31개, 단위·통합 1,353 PASS / 기존 선택 검사 1개 미실행), 전체 기능 브라우저 **161 PASS / 0 FAIL / 0 SKIP**예요. 별도 smoke 3개, 선택 시각 경로 3개, benchmark 1개도 통과했어요. 검사 파일 목록과 전수표의 누락 0개는 `output/testing-audit/inventory.json`으로 대조했어요. 명령·결과 위치·지문과 이전 실패는 [구현 결과](../project-plan/RUNTIME-SIMPLIFICATION-RESULTS.md)에 있어요.

최종 전체 브라우저는 293.132초(약 4분 53초)예요. 비교 전 전체 브라우저는 165개 중 8개 실패로 약 9.4분이었고 실패 대기만 약 3.6분이었으므로, 차이를 전부 통폐합 성능 향상으로 주장하지 않아요. 전체 추가 폭 시각 suite, 실제 Codex 설치 확인, 실제 모델·과금·휴대폰 검증은 수행하지 않았어요.
