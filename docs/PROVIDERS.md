# 프로바이더와 모델

## 등록

**설정 → 프로바이더·모델 → 프로바이더 관리**에서 종류·이름·API 기본 주소·API 키를 입력하고 저장해요. 키 값은 앱에서 바로 등록하고 서버 DB에 저장해요. 별도 환경변수 이름, 주소 허용 목록, 서버 재시작은 필요하지 않아요. 수정 시 비워둔 키 입력은 기존 키를 유지하고, 키 삭제 동작은 저장된 연결에서 키를 해제해요.

OpenAI Responses·Chat 호환, Anthropic Messages 등 프로토콜과 주소를 구분해요. 공식 주소는 초기값이고 사용자 지정 호환 주소도 입력할 수 있어요. LAN HTTP 주소도 지원해요. 컨테이너 안의 localhost는 컨테이너 자신이므로 다른 PC의 주소를 직접 지정해야 해요.

모델 프리셋에는 공급자 모델 ID와 출력·사고·생성 옵션을 저장하고, **역할별 모델**에서 작문·번역·도우미 등의 모델을 선택해요. 목록에 없는 모델 ID도 수동 입력할 수 있어요. 연결 확인과 모델 목록 조회는 실제 외부 요청이므로 명시적으로 실행해요. 저장만으로 유료 생성을 시작하지 않아요.

## 키와 전체 백업

일반 키와 JEV 키는 같은 DB 저장소를 사용해요. 일반 조회·개별 자료/채팅 내보내기에는 키 원문을 포함하지 않아요. **전체 SQLite 백업에는 키와 이미지가 포함**되므로 공유용 파일로 사용하지 않아요. 별도 암호화 키 파일을 요구하는 이중 저장소는 없어요.

## TypeSafe / JEV 연결과 테스트

**프로바이더 추가 → TypeSafe AI**에서 API 키를 저장해요. JEV는 로어 관련성·이미지 선택·선택적인 서비스 거절 감지에 사용해요. 본문 거절 감지는 기본적으로 꺼져 있으며 **역할별 모델 → 거절 감지**에서 켤 수 있어요. 켰을 때는 본문 생성 후 JEV 판정을 수행해요. 다른 JEV 기능을 함께 끄는 설정은 아니에요.

이미지 선택은 이미지 이름·설명 등 카탈로그 메타데이터를 사용해요. 이름을 저장하면 다음 선택부터 반영하고 과거 삽입 이미지는 변경하지 않아요. JEV 키의 환경변수 fallback이나 별도 `.jev-credentials` 파일은 일반 실행에서 사용하지 않아요.

## Google Agent Platform / Vertex

Gemini용 `vertex-gemini-v1` 연결에서는 서비스 계정 JSON을 앱에서 등록해요. JSON은 DB에 저장하고 프로젝트 ID를 주소에 반영해요. 모델 목록용 Gemini API 키는 별도의 선택 입력이며 목록 조회에만 사용해요. 실제 모델 접근 권한은 Google 계정 설정에 따라요.

## Codex

Codex는 API 키를 입력하는 연결이 아니라 전용 실행기의 로그인 상태를 사용해요. [Codex 안내](CODEX.md)를 따라 등록해요. 외부 실행기의 로그인 파일은 SQLite 백업과 별개예요.

## 구현 경계

`server/provider-connections.ts`는 연결 입력·키 저장을, `server/credentials.ts`는 DB 키 읽기/쓰기를 맡아요. 프로토콜별 encoder와 transport는 모델 요청 형식과 응답 파싱을 맡아요. 자료 편집과 과거 백업 검증이 공급자 전송 경로에 개입하지 않아요. 실제 지원 옵션과 응답 품질은 해당 서비스에서 확인해야 해요.

## Reversible settings and concurrent edits

Enabling/disabling a provider or model applies immediately; it does not delete resources and does not require a separate impact-confirmation panel. Unsaved form text is still protected when switching editors. A conflicting save keeps the draft and its original revision until the user loads the latest settings; the provider/model detail GET endpoints return the current editable resource, never the stored API key itself.
