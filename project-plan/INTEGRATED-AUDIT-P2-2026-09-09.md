# 통합 감사 P2 후속 수정

사용자의 “P2 후속 작업도 이어서 진행해줘” 요청에 따라 `90926d6`의 깨끗한 main에서 Reader 응답 비용과 구성 집필 예약의 두 시점 문제를 수정했어요. 실제 공급자·운영 DB·배포는 사용하지 않았어요.

## Reader 조회 범위

`GET /api/chats/:id/reader`의 `runs`는 현재 5개 원문 페이지의 Run과 원문이 없는 응답(실패·취소 포함), 진행 중 Run을 반환해요. 원문 delta가 비어 있어도 현재 페이지의 Run 요약은 갱신해요. 비용 집계도 이 Run ID에 한정하며 제목 attempt 제외·미확인 비용 null 의미는 유지해요.

목차의 전체 장면 번호·100 codepoint 요청 라벨·authored 시작 라벨은 유지해요. 후보 생성 순서와 분기별 마지막 Run ID는 별도 작은 메타데이터로 제공하여 페이지 밖 후보 번호나 오래된 실패 미리보기가 바뀌지 않게 해요. 메타데이터 조회를 한 번으로 합치고, 요청 라벨의 문자 배열은 길이 판정에 충분한 앞 202 UTF-16 단위만 만들어요. 이모지 100/101 codepoint 경계도 검사해요. 전체 동결 snapshot·실행 입력은 변경하지 않아요.

전체 실행 기록 패널은 열렸을 때 `GET /api/chats/:id/reader-runs`로 전체 표시용 Run 요약을 조회해요. 조회 대기·실패·재시도와 Inspector를 유지하고, 페이지 밖 원고 읽기·새 이야기 포크도 동작해요. 수락된 요청이 현재 페이지와 최근 activity에서 모두 빠졌을 때 과거 접수 표시를 되살리지 않아요.

전체 목차·분기 메타데이터 조회는 여전히 이력 크기에 비례하고, 원문 없는 실패가 많이 쌓이면 그 응답 목록도 커져요. 전체 작업 패널을 열었을 때의 전체 요약 조회를 상수 비용이라고 주장하지 않아요. 서버 캐시나 변경 누락 위험이 있는 영속 projection은 추가하지 않았어요.

## 구성 집필 예약

구성 apply 트랜잭션 전후에 집필 대상까지의 경로와 직계 하위 항목의 최종 내용을 비교해요. 아직 Run을 예약하지 않은 연결 command가 참조하는 계획이 달라졌으면 그 command를 `cancelled`로 남겨요. 요청문을 자동으로 덮어쓰지 않으며, 사용자 지정 요청문도 보존해요. 무관한 형제 항목의 변경은 예약을 취소하지 않아요.

한 번도 실행되지 않은 취소 command로 새 Run을 만들려 하면 409로 거절해요. 새 command로 구성 연결이 바뀐 뒤에도 옛 command를 직접 실행할 수 없도록 공통 bind 경계에서도 같은 상태를 거절해요. 최신 구성을 확인하고 새 집필 키로 예약하면 새 계획으로 실행해요. 이미 수락된 Run은 원래 snapshot을 유지하고, 같은 Run 키의 응답 재확인은 기존 멱등 처리로 같은 결과를 반환해요. 실행 이력이 있는 command를 취소한 뒤 사용자가 명시적으로 재시도하는 기존 계약도 유지해요. 별도 표·스키마 변경은 없어요.

원본에서 대상·상위·직계 하위 변경과 하위 추가의 회귀 **4개가 실패**했고, 수정 후 구성 32개와 기존 장면 요청 10개가 통과했어요. 사용자 요청문과 archive 왕복, 새 연결 뒤 옛 command 실행 차단, 배치 원복·롤백, 이미 수락된 Run 재확인도 포함해요. 증거는 `output/integrated-audit-2026-09-09/outline-p2/`의 `red-tests.log`, `green-tests.log`, `report.md`에 있어요.

## 재현과 검증

Reader 비교는 `output/integrated-audit-2026-09-09/measure-reader.mjs`를 같은 Node 24.14.0 / Windows / Ryzen 7 7800X3D에서 실행해요. 10·100·1,000개 합성 원문, 요청문 2,000자, 페이지 5개, 1회 warmup + 5회 표본이며 Reader 함수와 JSON 직렬화까지 측정해요. 원문 DB는 별도 생성·보존하고 모델·네트워크·브라우저 지연은 포함하지 않아요. bulk fixture의 frozen history는 비워두었으므로 실제 장편 snapshot 크기 전체의 성능 증거는 아니에요.

### Reader 비교

| 합성 원문 수 | idle 응답 bytes 변경 전 → 후 | 중앙값 ms 변경 전 → 후 |
| --- | --- | --- |
| 10 | 34,994 → 22,441 | 1.22 → 1.79 |
| 100 | 287,186 → 46,393 | 4.12 → 3.05 |
| 1,000 | 2,724,388 → 201,195 (**92.6% 감소**) | 44.83 → 35.00 (**21.9% 감소**) |

1,000원문 초기 조회도 2,747,875→224,682 bytes, 45.42→37.78ms예요. 10원문에서는 약 0.57ms 늘어 소규모 처리 시간의 개선은 확인하지 못했어요. 표본 수가 작고 시스템 부하 영향을 받으므로 이 중앙값을 운영 지연 보장으로 사용하지 않아요.

처음 페이지 상세만 분리한 측정은 201,195 bytes / 47.11ms로 처리 시간이 줄지 않았어요. `p2/reader-profile.json`에서 중복 메타데이터 조회 비용을 확인하고 한 번의 조회와 제한된 라벨 배열로 정리한 뒤 위 최종 값을 얻었어요. 중간 측정도 `reader-measurements/reader-1788963442171.json`에 보존했어요.

공통 경로는 `output/integrated-audit-2026-09-09/`예요. 변경 전은 `reader-measurements/reader-1788962233388.json`, 최종은 `reader-measurements/reader-1788963736590.json`, 비교와 전후 build identity는 `p2/reader-comparison.json`에 있어요.

### 최종 검사

- `npm run quality:full`: **PASS**, 정적 검사·tooling 27·새 빌드, 단위/통합 **1,705 PASS / 0 FAIL / opt-in 1 미실행**, Vitest 129.38초. `p2/quality-full.log`에 기록했어요. 설치 Codex를 호출하는 opt-in 검사는 실행하지 않았어요.
- `npm run verify:redesign`: **207 PASS / 2 FAIL / 0 SKIP**, 534.76초. 실행 ID는 `redesign-2026-09-09T14-22-29-862Z-c31577c0`예요. 새 LOADUI08의 503 문구 기대값 오류와 기존 PMUI11의 전체 30초 제한 초과였어요. 이 실행을 전체 PASS로 바꾸지 않았어요.
- 503의 임의 서버 오류문을 숨기는 기존 공통 API 동작에 맞춰 LOADUI08 기대값만 고쳤어요. 실제 오류 표시·목록 재시도·8개 전체 작업/Inspector·페이지 밖 읽기/포크·원본 불변 검사는 유지했어요. 제품 코드는 바꾸지 않았어요.
- 같은 빌드의 집중 브라우저: **9 PASS / 0 FAIL / 0 SKIP**, 27.82초. LOADUI01–08과 수정하지 않은 PMUI11을 검사했어요. LOADUI08은 2.19초, PMUI11은 16.36초로 통과했어요. 실행 ID는 `p2-focused-2026-09-09T14-40-51-249Z-e70e63b4`예요. PMUI11의 전체 실행 중 시간 초과 원인은 확정하지 않았고 독립 재실행 통과와 구분해요.

브라우저 직접 증거는 각 `output/playwright/<실행 ID>/summary.json`과 `playwright.json`이에요. 실패 screenshot/trace, `p2/browser.log`, `p2/focused-browser.log`, `p2/browser-verification.json`도 보존했어요. 두 실행 모두 cleanup PASS·잔여 PID 없음이며, 최종 집중 실행의 소스/빌드/검사 지문 일치와 합성 자료 검사도 PASS예요. 전체 실행의 실패 뒤 종결 identity 검사는 수행되지 않았으므로 그 항목을 PASS로 간주하지 않아요.

최종 build/source hash는 `d4d2fd1a74986b02fb4a3790c8fb5d7767b0a765de773f9385f680cb7aa7ccde`, dist hash는 `feb367715d8f1ec3db1d87f974801c86920d9ad7e60015a7ebc72c5d064652c8`예요. 초기 Vitest의 sandbox `spawn EPERM`은 실행 전 차단으로 남겼고, 허용된 로컬 재실행 및 위 전체 검사에서 실제 통과를 확인했어요. 커밋·푸시·배포는 수행하지 않았어요.
