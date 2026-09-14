import type { ContentPackage } from '../core/content-package.js';
import { adaptRisuLuaTriggers } from './risu-lua-adapter.js';
import { present, type RisuCardExtension } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/**
 * Adapts the card's triggers and Lua into isolated actions. No code runs during an import: what the
 * adapter cannot connect is reported and stays in the original file.
 */
export function importRisuTriggers({
  risu,
  findings,
}: {
  risu: RisuCardExtension;
  findings: RisuImportFindings;
}): ContentPackage['behavior'] {
  const lua = adaptRisuLuaTriggers(risu.triggerscript, {
    ...(risu.lowLevelAccess === true ? { lowLevelAccess: true } : {}),
  });
  let behavior: ContentPackage['behavior'];
  if (lua.actions.length && lua.actions.length <= 100) {
    behavior = {
      revision: 1,
      schemaVersion: 1,
      stateSchema: { type: 'record', properties: {} },
      initialState: {},
      actions: lua.actions,
      outputParsers: [],
    };
    findings.add(
      'lua-actions',
      'warning',
      '트리거와 Lua의 생성 전·입력·응답 후·버튼 행동을 격리된 행동으로 가져와요. 가져오기 중에는 코드를 실행하지 않아요. 공유 변수 변경과 추가 모델 호출은 채팅에서 각각 허용해야 하며 아직 연결되지 않은 이벤트·API는 아래 안내를 확인해 주세요.'
    );
  } else if (lua.actions.length > 100) {
    findings.add(
      'lua-actions-limit',
      'unsupported',
      'Lua 행동이 자료의 한도를 넘어 자동 연결하지 않아요. 원본 코드는 파일에 보존해요.'
    );
  }
  for (const issue of lua.findings)
    findings.add(
      `${issue.code}:${issue.triggerIndex}:${issue.effectIndex ?? 0}:${issue.event ?? ''}`,
      issue.code === 'RISU_LUA_FRESH_INVOCATION' ? 'warning' : 'unsupported',
      `트리거 ${issue.triggerIndex + 1}${issue.event ? ` · ${issue.event}` : ''}: ${issue.message}`
    );
  // The adapter connects declarative effects and mixed triggers too, so only what it left behind
  // is unhandled. A triggerscript it cannot read at all still counts as preserved-only.
  const unhandledTriggers = Array.isArray(risu.triggerscript)
    ? lua.unconnectedTriggers.length > 0
    : present(risu.triggerscript);
  if (unhandledTriggers)
    findings.add(
      'trigger-effects-unsupported',
      'unsupported',
      '아직 연결하지 못한 트리거나 효과가 있어요. 실행 순서를 임의로 바꾸지 않고 원본 파일에 보존해요.'
    );
  return behavior;
}
