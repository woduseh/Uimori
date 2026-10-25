import type { RisuContent } from '../core/risu-content.js';
import type { RisuContentSource } from '../core/risu-native.js';
import { nativeRisuTriggers } from '../core/risu-native.js';
import { importRisuAssets, type PreparedRisuAsset } from './risu-import-assets.js';
import { object, string, type RisuCard, type RisuCardInput } from './risu-import-card.js';
import { createRisuImportFindings } from './risu-import-findings.js';
import { projectNativeRisuPackage } from './risu-native-projection.js';
import { buildRisuTransfer } from './risu-import-transfer.js';
import { text } from './request-validation.js';
import type { NativeTransferFile } from '../core/native-transfer.js';
import type { PreparedNativeTransferFile } from '../core/native-transfer-validation.js';
import type { RisuImportPreview } from '../core/risu-import.js';

/** Preserve Risu documents; build only the projections the existing library and chat store need. */
export function analyzeNativeRisuImport(input: RisuCardInput): {
  file: NativeTransferFile;
  preview: RisuImportPreview;
  hash: string;
};
export function analyzeNativeRisuImport(
  input: RisuCardInput,
  preparedAssets: Map<string, PreparedRisuAsset | null>
): { file: PreparedNativeTransferFile; preview: RisuImportPreview; hash: string };
export function analyzeNativeRisuImport(
  input: RisuCardInput,
  preparedAssets?: Map<string, PreparedRisuAsset | null>
) {
  const card = input.card as RisuCard;
  const title = text(card.name, 'card name', 200);
  const findings = createRisuImportFindings();
  const notes = string(card.creator_notes);
  const description =
    notes ||
    (input.kind !== 'module' ? `Risu 캐릭터 카드에서 가져온 자료: ${input.source.name}` : '');
  if (description.length > 4000)
    findings.add(
      'creator-notes-truncated',
      'info',
      '자료 설명은 앞 4000자까지 표시해요. 제작자 코멘트 전체는 Risu 카드 원문에 보존해요.'
    );
  const assetInput = {
    card,
    kind: input.kind,
    members: input.members,
    findings,
    native: true,
  };
  const assets = preparedAssets
    ? importRisuAssets({ ...assetInput, preparedAssets })
    : importRisuAssets(assetInput);
  const native: RisuContentSource = {
    version: 1,
    card: structuredClone(input.nativeCard),
    ...(input.nativeModule ? { module: structuredClone(input.nativeModule) } : {}),
    sourceHash: input.hash,
    assets: assets.packageImages.map((image) => {
      const index = Number(image.id.slice('image-'.length));
      const source = object(card.assets?.[index]);
      return {
        name: string(source.name) || image.title,
        uri: string(source.uri),
        imageId: image.id,
      };
    }),
  };
  const { pkg, lore } = projectNativeRisuPackage(
    {
      version: 2,
      id: `card-${input.hash.slice(0, 32)}`,
      revision: 1,
      title,
      description,
      body: '',
      nativeRisu: native,
      lore: [],
      images: assets.packageImages,
      ...(assets.portraitImageId ? { portraitImageId: assets.portraitImageId } : {}),
    } satisfies RisuContent,
    input.kind,
    findings
  );
  if (pkg.lore.length)
    findings.add(
      'native-lore-model',
      'info',
      '로어 원문과 규칙은 보존하며 선택적 로어의 관련성은 JEV가 판단해요. 선택되지 않은 로어도 작문 모델이 조회할 수 있어요.'
    );
  if (input.source.base64 === undefined)
    findings.add(
      'source-file-not-retained',
      'info',
      '카드와 모듈의 원문, 지원 이미지는 자료에 보존해요. 원본 파일 자체가 필요하면 직접 보관해 주세요.'
    );
  findings.add(
    'native-risu',
    'info',
    '카드, 모듈, CBS, 정규식, 트리거 코드는 Risu 원문으로 보존해요. 본문, 첫 메시지, 로어는 이 원문에서 읽어 표시해요. 원문을 보존해도 모든 스크립트가 실행되는 것은 아니에요.'
  );
  if (
    nativeRisuTriggers(native).some(
      (trigger) =>
        Array.isArray(trigger.effect) &&
        trigger.effect.some((raw) => {
          const effect = object(raw);
          return (
            /LLM/iu.test(string(effect.type)) ||
            (effect.type === 'triggerlua' &&
              /\b(?:LLM|axLLM|simpleLLM)\s*\(/u.test(string(effect.code)))
          );
        })
    )
  )
    findings.add(
      'native-model-calls',
      'info',
      '스크립트에서 모델 호출로 보이는 코드를 찾았어요. 가져오기에서는 이 코드를 유지하며, JEV 호출로 자동 변환하지 않아요.'
    );
  const transferInput = {
    input,
    card,
    pkg,
    title,
    lore,
    findings,
  };
  const { file, preview } = preparedAssets
    ? buildRisuTransfer({ ...transferInput, images: assets.images, prepared: true })
    : buildRisuTransfer({
        ...transferInput,
        images: (assets as ReturnType<typeof importRisuAssets>).images,
        prepared: false,
      });
  return { file, preview, hash: input.hash };
}
