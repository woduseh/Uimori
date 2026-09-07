import { validateContentPackage, type ContentPackage } from '../../core/content-package.js';

/** Authored synthetic data exercising common package features; no source-specific runtime or importer. */
export function createActionPackage(imageHash?: string): ContentPackage {
  return validateContentPackage({
    version: 1,
    id: 'expedition-fixture',
    revision: 1,
    title: '합성 탐험 동료',
    description: '공통 자료와 행동 검증용 합성 예제',
    body: 'A fictional adult explorer proposes plans and waits for the user to choose. Do not invent the user response.',
    identity: { name: 'Ari', description: 'An adult expedition companion in a synthetic setting.' },
    controls: [
      {
        id: 'responseLanguage',
        label: '응답 언어',
        type: 'select',
        default: 'ko',
        options: [
          { label: '한국어', value: 'ko' },
          { label: 'English', value: 'en' },
          { label: '日本語', value: 'ja' },
          { label: 'Français', value: 'fr' },
        ],
      },
      {
        id: 'responseSize',
        label: '응답 분량',
        type: 'select',
        default: 'brief',
        options: [
          { label: '짧게', value: 'brief' },
          { label: '자세히', value: 'detailed' },
        ],
      },
    ],
    loreFolders: [{ id: 'places', name: '탐험 장소' }],
    lore: [
      {
        id: 'base',
        folderId: 'places',
        title: '기지',
        description: 'Known departure point',
        text: 'The expedition begins at a small observatory.',
        loading: 'pinned',
        relatedIds: ['bridge'],
      },
      {
        id: 'bridge',
        folderId: 'places',
        title: '다리',
        description: 'Optional route',
        text: 'A footbridge connects the observatory path to the ridge.',
        loading: 'discoverable',
        relatedIds: ['base'],
      },
    ],
    instructions: [
      {
        id: 'preferences',
        target: 'main',
        text: '',
        template: [
          { kind: 'text', text: 'RESPONSE_LANGUAGE=' },
          { kind: 'value', expression: { control: 'responseLanguage' } },
          { kind: 'text', text: ';RESPONSE_SIZE=' },
          { kind: 'value', expression: { control: 'responseSize' } },
          { kind: 'text', text: ';ENERGY=' },
          { kind: 'value', expression: { context: ['state', 'energy'] } },
        ],
      },
    ],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: {
          energy: { type: 'number', min: 0, max: 120, label: '활력' },
          progress: { type: 'number', min: 0, max: 20, integer: true, label: '진행' },
          ready: { type: 'boolean', label: '준비됨' },
          plan: { type: 'string', maxLength: 4000, label: '제안' },
        },
      },
      initialState: { energy: 25, progress: 0, ready: true, plan: '' },
      actions: [
        {
          id: 'set-energy',
          label: '활력 설정',
          inputSchema: {
            type: 'record',
            properties: { value: { type: 'number', min: -1000, max: 1000, label: '새 활력' } },
          },
          effects: [
            {
              path: ['energy'],
              value: { op: 'clamp', args: [{ context: ['input', 'value'] }, 0, 120] },
            },
          ],
        },
        {
          id: 'propose',
          label: '다음 탐험 예약',
          description: '활력이 10 이상일 때 제안해요. 원문 생성은 별도로 요청해요.',
          triggers: ['user'],
          inputSchema: {
            type: 'record',
            properties: { request: { type: 'string', maxLength: 4000, label: '장면 제안' } },
          },
          when: { op: 'gte', args: [{ context: ['state', 'energy'] }, 10] },
          draws: [{ id: 'route', type: 'choice', values: ['ridge', 'bridge', 'observatory'] }],
          effects: [{ path: ['plan'], value: { context: ['input', 'request'] } }],
          result: { context: ['input', 'request'] },
          nextRequest: { context: ['result'] },
        },
      ],
      outputParsers: [],
    },
    stateView: {
      title: '탐험 상태',
      fields: [
        { key: 'energy', label: '활력', format: 'number' },
        { key: 'progress', label: '진행', format: 'number' },
        { key: 'ready', label: '준비됨', format: 'boolean' },
        { key: 'plan', label: '제안', format: 'text' },
      ],
    },
    starts: [
      {
        id: 'arrival',
        title: '기지 도착',
        mode: 'authored',
        text: 'Ari opens the observatory door and waits for your greeting.',
      },
      {
        id: 'journey',
        title: '탐험 시작',
        mode: 'generate',
        text: 'Propose a route from the observatory without assuming that the user agrees.',
      },
    ],
    ...(imageHash
      ? {
          images: [
            {
              id: 'map',
              title: '합성 지도',
              description: 'Fixture image',
              blobHash: imageHash,
              mime: 'image/png',
              allowedUse: 'both',
            },
          ],
          portraitImageId: 'map',
        }
      : {}),
    transforms: [],
  });
}
