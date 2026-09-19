# 라이선스와 제3자 고지

Uimori 프로젝트 소스의 라이선스는 **GNU Affero General Public License version 3 only (`AGPL-3.0-only`)**예요. 전문은 [LICENSE](LICENSE)에 있어요. 별도 라이선스가 명시된 제3자 구성 요소에는 각자의 조건이 적용돼요. 사용자 봇·프롬프트·이미지·채팅·생성 결과의 권리는 해당 자료의 권리자와 이용 조건에 따르며, 앱을 사용하거나 파일을 가져왔다는 이유만으로 Uimori 소스 라이선스를 부여하지 않아요.

## RisuAI 스냅샷

- 출처: [RisuAI](https://github.com/kwaroran/RisuAI), 기준 revision `cad8595aa39620df4246f56918f0962c2aa0263a`. 원저작권은 Kwaroran과 RisuAI 기여자에게 있어요.
- 적용 조건: RisuAI 본체는 **GPL-3.0-only**예요. 가져온 파일은 GPL-3.0으로 남고 Uimori의 AGPL-3.0-only 소스와는 AGPL-3.0 13조에 따라 결합해요. 전문은 [third_party/risuai/cad8595a/LICENSE](third_party/risuai/cad8595a/LICENSE)에 있고, 다른 조건이 붙은 파일(아래 RPack)은 자기 고지를 따로 둬요.
- 포함 부분과 변경: 파일별 원본 경로·원본 SHA-256·변경 요약은 [SNAPSHOT.json](third_party/risuai/cad8595a/SNAPSHOT.json)이, 경계와 갱신 절차는 [스냅샷 README](third_party/risuai/cad8595a/README.md)가 소유해요. 파일 해독·로어 어댑터는 `server/compat/risu/`, 원본 CBS 실행 연결은 `server/risu-native-cbs.ts`에서 사용하며 자동 갱신은 하지 않아요.

## RPack

- 출처: [RisuAI의 RPack](https://github.com/kwaroran/RisuAI/tree/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/rpack), 기준 revision `cad8595aa39620df4246f56918f0962c2aa0263a`. 위 스냅샷의 일부이며 자기 조건을 따로 가져요.
- 원저작권 고지: Copyright (c) 2026 Kwaroran.
- 포함 부분: `rpack_map.bin`의 해독용 256바이트 치환표를 [third_party/risuai/cad8595a/rpack.ts](third_party/risuai/cad8595a/rpack.ts)에 배열로 표현하고 `server/compat/risu/rpack.ts`를 거쳐 Uimori의 입력 검증 경로에 연결했어요. 인코더나 원본 실행 모듈 전체를 포함하지 않아요.
- 원본 512바이트 파일 SHA-256: `428e939c41617140ef2fad0420d9163cc80ce7c9b2f5e620223a25acc8afd498`.
- 적용 조건: 원본은 RisuAI 내부 사용에 MIT 선택을 허용하지만 다른 앱에는 AGPL-3.0을 요구해요. Uimori에는 **AGPL-3.0** 경로를 적용해요. [원본 조건](third_party/risuai/cad8595a/rpack/LICENSE), [AGPL 전문](third_party/risuai/cad8595a/rpack/LICENSE_AGPL), [원저작권·MIT 고지](third_party/risuai/cad8595a/rpack/LICENSE_MIT), [원본 README](third_party/risuai/cad8595a/rpack/README)를 보존해요. MIT 문서 보존은 Uimori에서 MIT 조건으로 사용한다는 뜻이 아니에요.
- 변경: 2026-09-13, 바이너리 치환표의 해독 부분을 TypeScript 상수로 옮겨 프리셋 파일 가져오기에 사용했어요. 2026-09-14, 위 스냅샷 디렉터리로 옮겼어요. Risu 런타임이나 내부 DB에 의존하지 않아요.

## Wasmoon

- 출처: [Wasmoon](https://github.com/ceifa/wasmoon), npm `wasmoon@1.16.0`과 포함된 Lua WebAssembly 실행기.
- 적용 조건: MIT. 패키지의 원저작권 고지와 전문을 [third_party/wasmoon/LICENSE](third_party/wasmoon/LICENSE)에 보존해요.
- 사용: 별도 Worker에서 Lua 코드를 실행하고 Uimori의 공통 Host API로 JSON 요청·결과만 교환해요. Uimori의 Worker는 포함된 WASM의 메모리 상한을 제한하며 원본 npm 패키지 파일은 수정하지 않아요.

## 배포와 소스 제공

프로젝트 소스 저장소는 [woduseh/Uimori](https://github.com/woduseh/Uimori)예요. 배포자는 실행·배포한 빌드와 일치하는 대응 소스, 로컬 수정 사항, 빌드·설치에 필요한 파일과 라이선스 고지를 제공해야 해요. 네트워크 이용자에게도 해당 소스를 받을 수 있는 안내를 쉽게 찾을 수 있게 제공해요. 다른 revision이나 미공개 변경을 포함하지 않은 저장소 링크만으로 배포본의 대응 소스가 제공됐다고 보지 않아요. 실제 절차는 [개인 서버 안내](docs/SELF-HOST.md#라이선스와-대응-소스)를 따라요.

이 문서는 프로젝트가 채택한 배포 정책과 고지를 기록해요. 전체 의존성의 개별 고지를 대체하지 않으며, 배포 패키지에 포함한 npm·WASM 등 제3자 구성 요소의 라이선스와 고지도 함께 유지해요.
