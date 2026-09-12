# 문제 보고용 진단

설정 → 데이터 관리에서 **시스템 진단 만들기** 또는 **선택 채팅 진단 만들기**를 사용해요. 작업 현황의 실행 상세에서는 **문제 보고용 진단 만들기**로 해당 실행만 선택해요. 미리보기에서 범위와 파일 내용을 확인한 뒤 JSON을 다운로드하고 원하는 곳에 직접 공유해요. 자동 업로드는 하지 않아요.

## 포함 범위

`uimori-diagnostic-report` v1은 작품 백업과 별도 형식이에요. 시스템 범위에는 build·DB/지원 schema·Node·OS·architecture와 합성 모드 여부만 포함해요. 채팅 범위에는 그 채팅의 최신 Run 요약과 attempt 요약을, Run 범위에는 선택한 Run과 `run_id`로 직접 연결된 attempt만 포함해요. 보조 작업·도우미의 독립 진행 이력은 아직 포함하지 않아요.

- Run 상태, 알려진 오류 코드, 입력/도구 호출 수, 거절 도구 수, 원문 확정/부분 출력 여부, 상태 준비 상태, 사용량을 포함해요.
- attempt에는 보고서 내부 별칭으로 된 연결 관계, 프로토콜, 역할, 상태, 알려진 오류 코드·HTTP 상태·허용된 거절 필드, 사용량을 포함해요. 알 수 없는 비용과 토큰은 `null`이에요.
- 순서는 최신부터이고 `sequence`는 포함된 attempt 중 오래된 항목부터 세요. 과거 항목이 잘리면 전체 호출 번호가 아니에요. `preparedOffsetMs`는 저장된 가격/요청 준비 시점 중 이 보고서의 가장 이른 값으로부터의 상대 시간이에요. 실제 공급자 전송/완료 시각을 뜻하지 않아요. 저장되지 않은 `durationMs`는 `null`이에요.
- Run의 `elapsedToLastUpdateMs`는 생성부터 마지막 저장 갱신까지의 경과이며 대기 시간도 포함해요. 공급자 응답 시간으로 해석하지 않아요.
- 현재 구현 상한은 Run 50개, attempt 100개, JSON 256 KiB예요. 오래된 항목 제외는 `coverage.*.truncated`, 미지원 범위는 `coverage.omitted`로 명시해요. 이 값은 진단 보관 기간이나 향후 제품 정책이 아니에요.

원문·프롬프트·로어·메모·상태/추첨 값·이미지·요청/응답 본문·도구 인자/결과·raw usage·키·환경변수·endpoint·경로·제목·원래 ID·본문 hash·임의 오류 문장과 stack은 포함하지 않아요. build 지문은 제품 코드 식별용 SHA-256만 허용하며 사용자 콘텐츠의 hash와 달라요. 그 밖의 build ID는 `null`이에요. 알 수 없는 enum/오류는 `unknown`/`UNKNOWN_ERROR`로 표시해요.

기존 로컬 Inspector의 실제 입력·원문·응답·tool 기록은 그대로 유지해요. 이 기록은 다음 로어 문맥, 상태/작업 귀속, 복원 검증에도 사용하므로 진단 로그로 취급해 삭제하지 않아요. 내보내기는 실행·데이터·설정·재시도 상태를 바꾸거나 모델을 호출하지 않아요.

## 구현과 후속 범위

계약과 허용 값은 `core/diagnostic-report.ts`, 제한된 SQL projection과 인증된 API 등록은 `server/diagnostic-report.ts`, 공통 미리보기/다운로드는 `web/DiagnosticReport.tsx`예요. `POST /api/diagnostics/report`는 `{scope:'system'}` 또는 `{scope:'chat',chatId,runId?}`만 받으며 기존 세션·브라우저 origin 검사를 통과해야 해요. Run의 chat 귀속을 확인하고 응답은 `Cache-Control: no-store`예요. 출력 필드를 추가할 때 DB 객체 spread나 범용 redact로 전체 데이터를 전달하지 않아요.

새 HTTP/worker JSONL 수집, 보관/회전, 상세 진단 opt-in, 프론트엔드 오류 기록, 개별 보조/도우미 작업의 전체 수명주기 보고는 **미구현**이에요. 현재 보고서는 이미 저장된 제한된 증거를 추릴 뿐이에요. 원문 의미나 공급자 내부 지연 원인은 이 파일만으로 판단할 수 없어요.

집중 검사는 `tests/diagnostic-report.test.ts`, 기존 Inspector 보존은 `tests/reader-diagnostics.test.ts`, 합성 화면 검사는 `npm run verify:diagnostics`예요. 실제 모델·사용자 DB·외부 업로드는 검증에 사용하지 않아요.
