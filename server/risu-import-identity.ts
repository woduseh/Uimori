import type { ContentPackage } from '../core/content-package.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { text } from './request-validation.js';
import { importRisuVariableDefaults } from './risu-variable-defaults.js';
import {
  present,
  string,
  type RisuCard,
  type RisuCardExtension,
  type RisuCardInput,
} from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/** The package description limit `validateContentPackage` enforces in core/content-package.ts. */
const DESCRIPTION_LIMIT = 4000;
/** Card metadata the package has no field for; the preserved original keeps it. */
const METADATA_FIELDS = ['tags', 'creator', 'character_version', 'nickname'];

/**
 * Opens the package a card becomes: its identity and description, the notice about an original the
 * app does not keep, and the default variables the card declares. Later stages fill the rest in.
 */
export function importRisuIdentity({
  input,
  card,
  risu,
  findings,
}: {
  input: RisuCardInput;
  card: RisuCard;
  risu: RisuCardExtension;
  findings: RisuImportFindings;
}): { pkg: ContentPackage; title: string } {
  const { hash, source, kind } = input;
  const title = text(card.name, 'card name', 200);
  // The creator's own notes describe the material better than any generated line, so they become
  // the description; a card without notes keeps the generated one naming the file it came from.
  const notes = string(card.creator_notes);
  const written =
    kind === 'module' || notes.trim() ? notes : `Risu 캐릭터 카드에서 가져온 자료 · ${source.name}`;
  const description =
    written.length > DESCRIPTION_LIMIT ? `${written.slice(0, DESCRIPTION_LIMIT - 1)}…` : written;
  const pkg: ContentPackage = {
    version: 1,
    id: `card-${hash.slice(0, 32)}`,
    revision: 1,
    title,
    description,
    body: '',
    ...(kind === 'bot' ? { identity: { name: title, description: '' } } : {}),
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    starts: [],
    images: [],
  };
  if (description !== written)
    findings.add(
      'creator-notes-truncated',
      'info',
      `제작자 코멘트가 ${DESCRIPTION_LIMIT}자를 넘어 자료 설명에는 앞부분만 담고 뒤를 줄임표로 줄였어요. 전체 내용은 원본 파일에 보존해요.`
    );
  if (METADATA_FIELDS.some((field) => present(card[field])))
    findings.add(
      'card-metadata',
      'info',
      '태그·제작자·카드 버전·별칭은 자료 필드로 옮기지 않아요. 보존한 원본 파일에만 남으며 검색이나 표시에 쓰지 않아요.'
    );
  if (source.base64 === undefined)
    findings.add(
      'source-file-not-retained',
      'warning',
      `원본 파일이 ${Math.ceil(RISU_IMPORT_MAX_BYTES / 1024 / 1024)} MiB를 넘어 앱에 사본을 보관하지 않아요. 가져온 자료만 저장하므로 원본 파일은 직접 보관해 주세요. 확인용 지문은 ${source.name} · SHA-256 ${hash}예요.`
    );
  try {
    const values = importRisuVariableDefaults(risu.defaultVariables);
    if (values !== undefined) {
      pkg.variableDefaults = { values, attachmentRoles: ['bot'] };
      findings.add(
        'variable-defaults',
        'warning',
        '기본 변수를 공통 템플릿의 읽기 기본값으로 가져와요. 이 자료를 봇으로 선택하면 프리셋보다 우선하며, 모듈·페르소나로 장착할 때는 이 기본값을 적용하지 않아요. 행동의 공유 변수 쓰기는 해당 채팅에서 허용해야 하며 코드 지원 범위는 별도로 안내해요.'
      );
    }
  } catch {
    findings.add(
      'variable-defaults-invalid',
      'unsupported',
      '기본 변수의 형식·이름·크기가 지원 범위를 벗어나 자동 적용하지 않아요. 원본 파일에 보존해요.'
    );
  }
  return { pkg, title };
}
