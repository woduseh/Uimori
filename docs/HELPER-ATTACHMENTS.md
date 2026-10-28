# 도우미 첨부

도우미 입력창의 클립 버튼, 붙여넣기, 파일 드롭으로 자료를 첨부해요. 이미지와 파일만으로도 요청할 수 있어요. 같은 대화를 사이드와 메인 화면에서 오가거나 다른 대화를 열어도 첨부 초안은 대화별로 보존돼요. 전송한 이미지의 미리보기를 열거나 파일 이름을 눌러 원본을 내려받을 수 있어요.

## 지원 범위

2026-10-28에 확인한 GPT-6 계열, Claude 5 이상, Gemini 4 계열의 공식 API 계약을 기준으로 해요. 선택한 모델뿐 아니라 연결의 프로토콜도 적용돼요. 미지원 파일은 전송 전에 표시하고, 모델을 바꿨다고 첨부를 자동으로 제거하지 않아요.

| 연결 | 첨부 |
| --- | --- |
| OpenAI Responses | 이미지, PDF, 텍스트와 코드, API가 허용하는 문서와 스프레드시트 |
| OpenAI Chat Completions | 이미지와 PDF |
| Anthropic Messages | 이미지, PDF, 텍스트와 코드 |
| Gemini / Vertex Gemini | 이미지, PDF, 텍스트와 코드, 지원 오디오와 영상 |
| Codex 연결 | 현재 연결 계약이 지원하는 이미지 |

문서 파일 지원은 각 서비스의 웹앱 지원과 별개예요. OpenAI의 비 PDF 문서는 텍스트 추출 방식이며, 문서 안의 이미지나 차트를 모두 전달하는 방식은 아니에요. 스프레드시트는 공급자의 처리 범위를 따르고, Claude의 별도 hosted code execution이나 앱 안의 문서 변환기는 사용하지 않아요.

공식 근거: [OpenAI 파일 입력](https://developers.openai.com/api/docs/guides/file-inputs), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Claude 파일](https://platform.claude.com/docs/en/build-with-claude/files), [Claude PDF](https://platform.claude.com/docs/en/build-with-claude/pdf-support), [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon), [Gemini 문서](https://ai.google.dev/gemini-api/docs/document-processing).

크기는 파일 원본, 요청 내 합계, 실제 전송 본문을 각각 검사해요. OpenAI 파일 합계 50MB, Claude 전송 본문 32MB, Gemini PDF 파일당 50MB 제한을 적용하며, 일반 첨부의 앱 저장 상한은 요청당 100MB예요. base64 인코딩과 함께 전송하는 대화 내용 때문에 허용되는 원본 합계는 더 작을 수 있어요. PDF 페이지 수와 미디어 길이는 공급자의 실제 입력 검증을 따르고 로컬에서 임의로 추정하지 않아요.

## 보존과 사용량

첨부는 해당 메시지와 함께 보존돼요. 대화 복사는 첨부도 포함하고, 본문을 편집해도 기존 첨부는 유지해요. 요청을 재시도하면 원래 전송한 첨부를 사용해요. 응답을 받지 못한 전송 확인도 같은 요청 키와 첨부 참조를 사용하며, 확인이 늦어져도 새로 작성한 초안을 지우지 않아요.

메시지나 대화를 삭제하면 더 이상 다른 대화나 재시도에서 참조하지 않는 파일을 정리해요. SQLite 전체 백업에는 첨부 바이트도 포함돼요. 기존 채팅 내보내기는 도우미 대화를 포함하지 않는 별도의 계약을 유지해요.

텍스트 파일은 추출한 텍스트로 토큰을 추정해요. PDF와 미디어처럼 로컬에서 전체 입력량을 알 수 없는 파일은 사용량을 0으로 계산하거나 완전한 컨텍스트 비율로 표시하지 않아요. 실제 공급자가 보고한 입력, 출력, 캐시와 비용은 실행 기록에 별도로 남아요.

## 구현 경계

- `core/request-files.ts`: 형식, 한도, 연결별 입력 정책
- `core/provider-file-reference.ts`, `core/provider-files.ts`: 명시적으로 첨부한 참조만 실제 전송 바이트로 변환
- `server/request-files.ts`, `server/request-file-storage.ts`: 업로드 확인, 형식 검사, 원본 보관과 다운로드
- `server/helper-attachments.ts`, `server/helper-attachment-prompt.ts`: 메시지 소유권, 정리와 모델 입력 구성
- `web/helper-attachment-draft.ts`: 대화별 Blob 초안과 전송 확인

일반 문자열이나 도구 출력에 파일 참조처럼 보이는 문자열이 있어도 저장 파일을 읽을 권한이 생기지 않아요. 다운로드는 인증된 앱 경로에서 attachment 응답으로 제공해요. 로컬 프로토콜 및 브라우저 검증은 실제 유료 공급자 전송과 구분해요.
