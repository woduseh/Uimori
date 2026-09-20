import { detectRisuImageHandoff } from '../core/risu-image-handoff.js';
import type { RisuContent } from '../core/risu-content.js';
import { normalizeRisuContentSource } from '../core/risu-native.js';
import type { ContentKind } from '../core/product.js';
import { object, string, type RisuCard } from './risu-import-card.js';
import { createRisuImportFindings, type RisuImportFindings } from './risu-import-findings.js';
import { importRisuLore } from './risu-import-lore.js';
import { moduleLoreEntries } from './risu-module-json.js';
import { importRisuVariableDefaults } from './risu-variable-defaults.js';
import { text } from './request-validation.js';

/** The raw card/module is authoritative. This projection is shared by import and editing. */
export function projectNativeRisuPackage(
  base: RisuContent,
  kind: ContentKind,
  findings: RisuImportFindings = createRisuImportFindings()
) {
  const native = normalizeRisuContentSource(base.nativeRisu);
  const module = native.module;
  const standalone = !Object.keys(native.card).length && !!module;
  const card = structuredClone(native.card) as RisuCard;
  if (standalone) {
    card.name = string(module.name);
    card.creator_notes = string(module.description);
    card.extensions = { risuai: { ...module } };
  }
  if (module?.lorebook != null)
    card.character_book = {
      ...object(card.character_book),
      entries: moduleLoreEntries(module.lorebook),
    } as RisuCard['character_book'];
  const title = text(card.name, 'card name', 200);
  const notes = string(card.creator_notes);
  const description =
    typeof card.creator_notes === 'string' ? notes : standalone ? '' : base.description;
  if (description.length > 4000)
    findings.add(
      'creator-notes-truncated',
      'info',
      '자료 설명은 앞 4000자까지 표시해요. 제작자 코멘트 전체는 Risu 카드 원문에 보존해요.'
    );
  const loreFindings = createRisuImportFindings();
  const lore = importRisuLore({
    card,
    findings: loreFindings,
  });
  findings.append(loreFindings.list);
  const pkg: RisuContent = {
    version: 1,
    id: base.id,
    revision: base.revision,
    title,
    description: description.length > 4000 ? `${description.slice(0, 3999)}…` : description,
    body: string(card.description),
    ...(kind === 'bot' ? { identity: { name: title, description: '' } } : {}),
    nativeRisu: native,
    ...(detectRisuImageHandoff(native, base.imageHandoff)
      ? { imageHandoff: detectRisuImageHandoff(native, base.imageHandoff) }
      : {}),
    lore: lore.lore,
    ...(lore.loreActivation
      ? {
          loreActivation: {
            ...lore.loreActivation,
            mode: base.loreActivation?.mode ?? ('model' as const),
          },
        }
      : {}),
    // The native preset owns global-note placement; a projection instruction would send it twice.
    instructions: [],
    starts: [
      card.first_mes,
      ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : []),
    ].flatMap((value, index) =>
      string(value).trim()
        ? [
            {
              id: `start-${index}`,
              title: index === 0 ? '기본 시작문' : `시작문 ${index + 1}`,
              mode: 'authored' as const,
              text: string(value),
            },
          ]
        : []
    ),
    images: base.images ?? [],
    ...(base.portraitImageId ? { portraitImageId: base.portraitImageId } : {}),
    ...(base.modules ? { modules: base.modules } : {}),
  };
  try {
    const values = importRisuVariableDefaults(
      object(object(card.extensions).risuai).defaultVariables
    );
    if (values) pkg.variableDefaults = { values, attachmentRoles: ['bot'] };
  } catch {
    findings.add(
      'native-variable-projection',
      'warning',
      '기본 변수 원문은 보존했어요. 현재 변수 읽기 형식으로 표현할 수 없는 항목은 실행 범위를 확인해야 해요.'
    );
  }
  return { pkg, lore: lore.preview };
}
