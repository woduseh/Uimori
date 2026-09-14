import type { ContentPackage } from '../core/content-package.js';
import { RISU_IMPORT_MAX_LORE_ENTRIES, type RisuImportPreview } from '../core/risu-import.js';
import { HttpError, record } from './request-validation.js';
import {
  parseRisuLoreContent,
  risuLoreAlwaysActivates,
  risuLoreNeverActivates,
} from './risu-lore-decorators.js';
import {
  object,
  present,
  string,
  type RisuCard,
  type RisuCardLoreEntry,
} from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';
import type { RisuImportText } from './risu-import-text.js';

/**
 * Reads the card's lorebook. Every entry appears in the preview so the import screen can offer it
 * as a memory, while only the entries the package actually uses reach its lore.
 */
export function importRisuLore({
  card,
  cardText,
  findings,
}: {
  card: RisuCard;
  cardText: RisuImportText;
  findings: RisuImportFindings;
}): { preview: RisuImportPreview['lore']; lore: ContentPackage['lore'] } {
  const book = object(card.character_book);
  const entries = book.entries === undefined ? [] : book.entries;
  if (!Array.isArray(entries) || entries.length > RISU_IMPORT_MAX_LORE_ENTRIES)
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const preview: RisuImportPreview['lore'] = [];
  const lore: ContentPackage['lore'] = [];
  for (const [index, raw] of entries.entries()) {
    const entry = record(raw) as RisuCardLoreEntry;
    const id = `lore-${index}`;
    const name = string(entry.name) || string(entry.comment) || `로어 ${index + 1}`;
    const parsed = parseRisuLoreContent(string(entry.content));
    const content = parsed.text;
    // Risu never sends an entry it never activates; that content belongs to the material's own use.
    const executable = risuLoreNeverActivates(parsed);
    const enabled = entry.enabled !== false && !executable;
    const loading =
      entry.constant === true || risuLoreAlwaysActivates(parsed)
        ? ('pinned' as const)
        : ('discoverable' as const);
    preview.push({
      id,
      title: name.slice(0, 200),
      text: content,
      enabled,
      loading,
      memoryCandidate: false,
    });
    if (executable)
      findings.add(
        'lore-not-activated',
        'warning',
        '활성화하지 않는 로어는 모델에 보내지 않아요. 자료가 스스로 쓰는 자료·코드로 보고 원본 파일에만 보존해요.'
      );
    if (parsed.decorators.some((item) => !['dont_activate', 'activate'].includes(item.name)))
      findings.add(
        'lore-decorators',
        'warning',
        '로어의 `@@` 지시문 중 활성 여부 외의 위치·깊이·확률 규칙은 그대로 재현하지 않고 본문에서 제거해요.'
      );
    if (parsed.trailing)
      findings.add(
        'lore-decorator-position',
        'unsupported',
        '본문 중간의 `@@` 지시문은 해석하지 않고 그대로 남겨요. 원래 규칙과 다르게 동작할 수 있어요.'
      );
    if (!enabled || !content.trim()) continue;
    if (loading === 'discoverable')
      findings.add(
        'lore-discovery',
        'warning',
        '키워드로 켜지던 로어는 모델이 필요할 때 조회하는 자료로 가져와요. 항상 활성인 로어는 그대로 전달해요.'
      );
    if (
      entry.use_regex ||
      entry.selective ||
      entry.position === 'after_char' ||
      present(entry.extensions)
    )
      findings.add(
        'lore-rules',
        'warning',
        '로어의 원래 위치·추가 활성 조건은 그대로 재현하지 않아요. 본문과 항상 활성 여부를 가져와요.'
      );
    const loreText = cardText.convert(content),
      template = cardText.template(loreText),
      order = entry.insertion_order;
    lore.push({
      id,
      title: name.slice(0, 200),
      description: Array.isArray(entry.keys)
        ? entry.keys
            .filter((key: unknown) => typeof key === 'string')
            .join(', ')
            .slice(0, 4000)
        : '',
      text: loreText,
      ...(template ? { template } : {}),
      loading,
      ...(typeof order === 'number' && Number.isSafeInteger(order) && Math.abs(order) <= 1_000_000
        ? { loreContext: { placement: 'background' as const, order } }
        : {}),
    });
  }
  if (preview.some((item) => !item.enabled))
    findings.add('disabled-lore', 'info', '비활성 로어는 적용하지 않고 원본 파일에 보존해요.');
  return { preview, lore };
}
