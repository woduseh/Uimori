# RisuAI 스냅샷 · cad8595a

[RisuAI](https://github.com/kwaroran/RisuAI) 커밋 `cad8595aa39620df4246f56918f0962c2aa0263a`에서 가져온 코드예요. Uimori가 Risu 자료를 읽고 호환 실행하는 데 필요한 조각만 담고, 어떤 파일도 자동으로 갱신하지 않아요.

## 라이선스

이 디렉터리의 파일은 RisuAI의 [GPL-3.0-only](LICENSE)를 따르고 원저작권은 Kwaroran과 RisuAI 기여자에게 있어요. Uimori 프로젝트 소스는 AGPL-3.0-only이며 AGPL-3.0 13조에 따라 GPL-3.0 코드와 결합해요. 파일마다 SPDX 식별자, 원본 경로, 변경 요약을 머리말에 적어요. 별도 조건이 있는 파일(예: RPack)은 자기 하위 디렉터리에 원본 고지를 함께 둬요. 전체 목록은 [제3자 고지](../../../THIRD_PARTY_NOTICES.md)를 봐요.

## 경계

- 이 디렉터리의 코드는 Uimori의 `core/`·`server/`·`web/`를 import하지 않아요. Risu가 전역 상태(`DBState`, `getDatabase()`)에 접근하던 자리는 인터페이스로 바꾸고, 그 구현은 Uimori 쪽 어댑터가 넘겨요.
- 파일 해독·로어 어댑터는 `server/compat/risu/`, 원본 CBS 실행 연결은 `server/risu-native-cbs.ts`에서 이 코드를 사용해요. 검사(`tests/`)에서도 직접 사용하며 경계는 `tests/risu-snapshot-boundary.test.ts`가 확인해요.
- Risu 원본 콘텐츠 실행에 이 스냅샷을 사용해요. 서버 저장·분기·이야기 기억·모델 연결은 Uimori가 소유해요.

## 갱신

[SNAPSHOT.json](SNAPSHOT.json)이 파일별 원본 경로와 그 시점의 SHA-256을 기록해요. 새 Risu 버전과의 차이는 로컬 RisuAI 체크아웃을 가리켜 다음 명령으로 **보고만** 받아요.

```bash
node scripts/risu-vendor-diff.mjs --risu /path/to/RisuAI --ref HEAD
```

새 버전을 반영할 때는 디렉터리 이름의 커밋과 매니페스트를 함께 바꿔요.
