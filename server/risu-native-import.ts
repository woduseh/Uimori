import type { ContentPackage } from '../core/content-package.js';
import type { NativeRisuContent } from '../core/risu-native.js';
import { nativeRisuTriggers } from '../core/risu-native.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { importRisuAssets } from './risu-import-assets.js';
import { object, string, type RisuCard, type RisuCardInput } from './risu-import-card.js';
import { createRisuImportFindings } from './risu-import-findings.js';
import { projectNativeRisuPackage } from './risu-native-projection.js';
import { buildRisuTransfer } from './risu-import-transfer.js';
import { text } from './request-validation.js';

/** Preserve Risu documents; build only the projections the existing library and chat store need. */
export function analyzeNativeRisuImport(input: RisuCardInput) {
  const card = input.card as RisuCard;
  const title = text(card.name, 'card name', 200);
  const findings = createRisuImportFindings();
  const notes = string(card.creator_notes);
  const description =
    notes ||
    (input.kind === 'bot' ? `Risu 캐릭터 카드에서 가져온 자료 · ${input.source.name}` : '');
  if (description.length > 4000)
    findings.add(
      'creator-notes-truncated',
      'info',
      '자료 설명은 앞 4000자까지 표시해요. 제작자 코멘트 전체는 Risu 카드 원문에 보존해요.'
    );
  const assets = importRisuAssets({
    card,
    kind: input.kind,
    members: input.members,
    findings,
    native: true,
  });
  const native: NativeRisuContent = {
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
      version: 1,
      id: `card-${input.hash.slice(0, 32)}`,
      revision: 1,
      title,
      description,
      body: '',
      nativeRisu: native,
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
      images: assets.packageImages,
      ...(assets.portraitImageId ? { portraitImageId: assets.portraitImageId } : {}),
    } satisfies ContentPackage,
    input.kind,
    findings
  );
  if (pkg.lore.length)
    findings.add(
      'native-lore-model',
      'info',
      '로어 원문과 활성 규칙을 보존하고 기본 선택은 Uimori의 모델 선택을 사용해요. 키워드 선택으로 바꿀 수도 있어요.'
    );
  if (input.source.base64 === undefined)
    findings.add(
      'source-file-not-retained',
      'warning',
      `원본 컨테이너가 ${Math.ceil(RISU_IMPORT_MAX_BYTES / 1024 / 1024)} MiB를 넘어 파일 사본은 보관하지 않아요. 카드·모듈 원문과 지원되는 에셋은 자료에 보존해요. 원본 파일 지문: ${input.hash}`
    );
  findings.add(
    'native-risu',
    'info',
    '카드·모듈·CBS·정규식·트리거 원문을 Risu 자료로 보존해요. 저장용 본문·시작문·로어는 그 자료에서 읽은 표시이며, 보존 자체가 모든 스크립트의 실행 지원을 뜻하지는 않아요.'
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
      '스크립트에 모델 호출로 보이는 코드가 있어요. 원래 호출은 유지해요. 상태창이나 이미지 선택을 위한 의미 판단은 JEV로 바꿀 후보가 될 수 있으며, 자유문·이미지 생성 호출 자체는 별도 기능이에요.'
    );
  const { file, preview } = buildRisuTransfer({
    input,
    card,
    pkg,
    title,
    images: assets.images,
    lore,
    findings,
  });
  return { file, preview, hash: input.hash };
}
