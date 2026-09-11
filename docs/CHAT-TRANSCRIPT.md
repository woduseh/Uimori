# 채팅 본문 추출과 가져오기

한 분기의 **요청·원문·최신 번역·사용자 메모**를 담는 작은 JSON 형식이에요. 2026-09-10 [방향 결정 7](DECISIONS-2026-09-10.md)에서 시작했으며, 외부에서 작성한 본문을 새 채팅으로 읽거나 글만 교환할 때 사용해요. 모든 분기·자료 본문·이미지·상태·실행 기록까지 보존하려면 [채팅 전체 백업](CHAT-BACKUP.md)을 사용해요. 파일 형식의 버전은 SQLite schema와 독립이며, 지원하지 않는 파일 버전은 거절해요.

## 형식 · `uimori-chat-transcript` v1

정의는 `core/chat-transcript.ts`, 검증은 `validateChatTranscript`예요.

| 필드 | 내용 |
| --- | --- |
| `format` · `version` | `uimori-chat-transcript` · `1`. 다른 값은 거절해요. |
| `exportedAt` | ISO 시각. |
| `title` | 채팅 제목(200자). |
| `attachments` | 채팅 프로필의 자료 참조 `{id, revision}` 목록. |
| `packageAttachments` | 장착 패키지 참조 `{id, revision, role}` 목록. `role`은 `bot`·`persona`·`module`. |
| `notes` | 사용자 메모 `{text, author, atIndex}`. `atIndex`는 메모가 붙은 항목 번호이고 `null`은 첫 항목 이전이에요. |
| `entries` | 순서대로 `{request, text, translation}`. `request`는 그 원문을 만든 요청(빈 문자열 가능), `text`는 최신 수정을 반영한 원문, `translation`은 원문 hash가 일치하는 최신 번역 또는 `null`. |

담지 않는 것: Run·snapshot·attempt·사용량·패키지 상태·추첨·삽화·이미지 배치·구성(outline)·도우미 대화·로어 변경·옵션 위임·읽기 위치·폴더. 이 형식은 언어 정보를 갖지 않아요. 번역은 한 벌만 담아요.

한도: 항목 5,000개, 항목마다 원문 2,000,000자·요청 20,000자·번역 2,000,000자, 메모 500개(본문 32,000자·작성자 200자), 각 참조 목록 300개, 채팅 제목 200자예요. 글자 수는 JavaScript 문자열 길이인 UTF-16 단위로 계산해요. 일반 원문 저장·수정과 본문 가져오기는 `core/content-limits.ts`의 같은 원문·번역·제목 한도를 사용하며 내용을 잘라 맞추지 않아요. HTTP 가져오기 본문 한도는 64MiB여서 개별 항목 한도와 별도로 적용돼요. 알 수 없는 필드도 거절해요.

## 추출

`GET /api/chats/:id/transcript`가 기본 분기의 머리 원문부터 조상을 따라 위 형식을 만들어요(`server/chat-transcript.ts`의 `exportChatTranscript`). 내부 함수는 명시한 분기도 추출할 수 있어요. 현재 채팅 메뉴의 다운로드는 **채팅 백업 내보내기**이며 모든 분기를 포함하는 백업 파일을 받아요. 이 메뉴를 본문 JSON 추출로 설명하거나 두 형식을 같은 파일로 다루지 않아요.

## 가져오기

`POST /api/chats/import-transcript` 본문은 `{ transcript, title?, idempotencyKey }`예요. 응답은 `{ chat, created, skippedAttachments }`. 화면에서는 설정 → 데이터 관리 → **채팅 본문 가져오기**에서 외부의 `uimori-chat-transcript` 파일을 고르면 바로 새 채팅을 만들어요. 전체 백업 파일은 같은 화면의 별도 **채팅 백업 가져오기**에서 내용을 확인한 뒤 복원해요.

- 새 채팅을 만들어요. 기존 채팅에 합치지 않아요.
- 항목마다 완료된 Run 하나와 원문 하나를 일반 저장 경로(`createRunInTransaction` → `completeRunInTransaction`)로 기록해요. 모델 호출 수는 0이며 입력·출력 토큰·비용은 `null`이에요. snapshot의 `transcriptImport`는 `{ index, storage: 'source-only-v1' }`이고 `history`는 빈 배열이에요. 작성된 도입문과 같이 모델 준비·상태 예약·표시 상태·이미지·삽화 작업은 만들지 않아요.
- ancestry는 원문의 부모 연결로 관리하므로 이전 본문 전체를 뒤따르는 모든 snapshot에 반복 저장하지 않아요. 본문 저장량은 누적 본문량에 비례해 늘어요. 리더·다음 요청 예약·원문 수정·포크·archive는 이 부모 연결을 읽으며, `source-only-v1` 검증은 snapshot에 가짜 실행 이력이나 모델·상태 실행 필드를 넣는 것을 거절해요.
- 번역은 사용자 직접 편집과 같은 완료 job(`manual: true`, revision 1)으로 넣어요.
- 메모는 `atIndex`에 해당하는 원문이 머리일 때 기록해서 원래 위치에 붙어요.
- 봇 패키지는 이 서재에 있어야 해요. 없으면 `CHAT_TRANSCRIPT_BOT_REQUIRED`로 거절해요. 다른 자료·패키지 참조는 같은 ID의 **현재 저장본**으로 장착하고, 서재에 없는 것은 `skippedAttachments`로 돌려주며 채팅은 만들어요.
- 같은 `idempotencyKey`의 재요청은 이미 만든 채팅을 `created: false`로 돌려줘요. 새 키의 같은 파일은 새 채팅이에요. 기록은 `events`의 `chat.transcript-imported`예요.
- 검증 실패는 아무것도 쓰지 않고 400으로 끝나요. 오류 코드는 `CHAT_TRANSCRIPT_*`예요.

모든 항목은 하나의 transaction으로 저장해요. 검사는 `tests/chat-transcript.test.ts`에서 최대 원문·제목, 저장 증가 구조, 수정 뒤 ancestry, 포크·archive·다음 예약, HTTP 경로를 확인해요. 반복 측정 스크립트는 `scripts/measure-transcript-import.mjs`이며 실행 결과와 통합 검증 상태는 [안정화 기록](STABILIZATION-2026-09-11.md)에 기록해요. 실제 공급자 호출이나 작품 의미 품질은 이 가져오기 검사의 범위가 아니에요.

## 개발 단계의 사용 순서

채팅을 계속 사용할 목적이면 먼저 채팅 전체 백업을 받아요. 본문 JSON만 남기는 경우에는 필요한 봇·페르소나·모듈을 새 서재에 먼저 등록해야 하며, 상태·추첨·다른 분기·실행 기록을 본문 파일에서 복원할 수는 없어요. 정식 배포 전 DB 초기화는 사용자가 보존 범위를 확인한 뒤 별도로 실행해요.
