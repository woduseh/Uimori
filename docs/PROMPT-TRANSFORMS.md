# 프롬프트 텍스트 변환

`PromptProgram.transforms`는 자료 출처와 무관한 선택적 텍스트 처리예요. 프롬프트 편집기의 **텍스트 변환**에서 순서·활성·처리 단계·역할·패턴·플래그·치환문을 관리해요. 모델·도구 권한을 부여하거나 저장 원문을 고치는 기능이 아니에요.

```ts
type PromptTextTransform = {
  id: string; title: string; enabled?: boolean;
  stage: 'input' | 'display'; role?: 'all' | 'user' | 'assistant';
  pattern: string; flags: string; replacement: string;
  replacementTemplate?: PromptTemplate;
};
```

`input`은 전송용 구간 필터를 통과한 원문 대화와 현재 요청에 적용해요. 새 문맥 요약·로어·프롬프트 지침·Host 정보에는 적용하지 않아요. 변환 뒤 문맥 크기를 계산하고 같은 결과를 실제 모델 입력에 사용해요. `display`는 해당 응답을 만든 시점의 프롬프트로 Reader의 요청·응답을 표시해요. 프리셋 표시 변환 뒤 기존 패키지 표시 변환을 적용해요. 번역은 기존 번역 대상 패키지 규칙을 유지해요. 구간 경계가 있는 응답은 경계 보존을 위해 응답 표시 변환을 건너뛰고 안내해요.

원래 요청·본문·hash는 그대로예요. Reader는 표시문이 달라졌거나 전송 변환이 적용되면 원래 요청과 전송문을 펼쳐 비교할 수 있게 해요. 편집·재요청은 원래 요청을 사용해요. 새 프롬프트를 저장해도 과거 응답의 표시 규칙을 바꾸지 않아요.

## 실행과 보존

- `server/text-transforms.ts`의 `applyTextTransformBatch`/`applyTextTransforms`가 공통 Worker를 소유해요. 기존 패키지 `applyPackageTransforms`와 작은 표시 미리보기 `presentText`도 같은 실행기에 연결해요. 이전 표시 미리보기의 리터럴 치환·한도·오류 계약은 facade에서 유지해요.
- 순서대로 ECMAScript 패턴·문자열 캡처를 치환해요. 플래그는 `gimsuy`, 최대 32개 규칙, 패턴 4,096자·치환문 16,384자예요. 한 Worker batch는 최대 2,000개 메시지·입력 합계 2,000,000자, 출력 합계 2,000,000자·기본 1초예요. 데이터는 Worker 인자로만 전달하고 제작자 JavaScript를 평가하지 않아요.
- `preparePromptInputTransforms`는 예약 transaction 밖에서 계산하고 `RunSnapshot.promptInputTransforms`에 입력·설정 hash와 변경된 출력·적용 규칙을 보관해요. 설정 hash에는 DB ID가 아니라 규칙·옵션·이름과 선언이 있을 때의 공통 템플릿 변수가 들어가요. 선언 없는 과거 설정에는 빈 변수 필드를 추가하지 않아요. `projectPromptInputTransforms`는 저장된 결과만 동기 적용하므로 문맥 측정·실제 전송·후보·포크·복원에서 같은 결과를 사용해요. 원문 대화가 줄어드는 문맥 투영에서도 원래 메시지 index를 유지해요.
- 준비 실패는 원 입력과 오류 코드로 고정해 채팅을 계속해요. 같은 입력의 후보·복원에서 실패한 정규식을 다시 시도하지 않아요. 명시적인 새 요청이나 규칙 변경은 새 계산이에요. 취소 후 늦은 계산은 채택하지 않아요.
- 복원은 입력·설정·출력 hash, 구조와 한도를 검증해요. Worker를 다시 실행하지 않으므로 과거 계산의 실행시간이나 창작 의미를 재판정하지 않아요. 실제 전송 기록이 있는 Run의 영수증 누락은 거절해요. 이 선택적 snapshot 필드는 기존 DB 18·archive 15·채팅 백업 1로 보존하며 새 DB 표나 이관은 필요 없어요.

## 템플릿과 Risu 대응

변수 조회는 본문과 같은 공통 resolver를 사용하고 별도 평가 프로그램은 자신의 기본값을 사용해요. 합산 변수 한도를 넘은 변수 참조 변환은 기존 오류 영수증과 원문 fallback으로 보존해요.

동적 치환은 기존 `PromptTemplate` AST를 사용해요. 옵션 값, `bot.name`, `user.name`, `variables`, `message.text/role/index/lastIndex/current`만 읽어요. index는 요약 전 전송 가능 원문 메시지 목록의 0부터 시작하는 위치예요. input의 마지막은 현재 요청, display의 마지막은 해당 시점의 완성 응답이에요. `message.text`는 앞선 규칙의 출력이 아닌 원래 대상 텍스트예요. `char` 슬롯은 봇 이름, `slot`은 빈 문자열이에요. 임의 DB·상태·통신 접근은 없어요. 계산된 값의 `$`는 리터럴로 처리하며 제작자가 text 노드에 작성한 캡처 토큰은 유지해요. 치환문을 직접 수정하면 이전 동적 템플릿이 해제되고 안내해요. 복잡한 AST는 기존 전체 구성 JSON 편집을 사용해요.

`server/risu-preset-regex.ts`는 고정 Risu 구현의 `editprocess`→`input`, `editdisplay`→`display`, order·기본 flags·개행·캡처·지원 CBS 조건을 이 구조로 변환해요. Risu `#if`의 줄 들여쓰기 제거는 일반 AST의 `trimIndent`로 표현해요. 프리셋 이름·특정 패턴·봇 전용 분기는 없어요.

`editinput`·`editoutput`, 동적 패턴·상태 변경·주입/이동 명령, CBS와 캡처를 섞어 평가 순서가 달라지는 규칙은 미지원으로 보존해요. Risu의 변환 후 전체 메시지 CBS 재평가는 수행하지 않아요. `{{data}}`는 고정 Risu 소스에서 캡처 치환이 아니므로 임의로 `$&`로 바꾸지 않아요. 미지원·실행 차이는 가져오기 화면에서 확인해요.

검증 근거는 `tests/prompt-transform-flow.test.ts`의 합성 native HTTP 전송·후보·fork/archive, `tests/prompt-transforms.test.ts`의 내용 결합·동일 문장 index·시간 초과·값 이스케이프·표시/전송 분리와 기존 표시 검사의 공통 실행기 회귀예요. 브라우저는 `verify:packages`의 프리셋 저장·재개방·요청 비교를 사용해요. 개인 Phēmē 표본은 로컬 실행만 확인했고 실제 외부 모델의 창작 품질이나 전체 표본 인수를 뜻하지 않아요.
