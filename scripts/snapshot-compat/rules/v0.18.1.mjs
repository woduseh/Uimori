export const commit = '13e5d62bad381888249b6642a382a447b8e35c0d';
const string = { type: 'string' },
  object = { type: 'object' },
  list = { type: 'array' },
  number = { type: 'number' };
const field = (path, before, after) => ({ path, before, after });
const removed = (path, type = string) => field(path, type, undefined);
const added = (path, value) => field(path, undefined, value);
const read = (id, routes, fields, reason) => ({ id, routes, status: [200, 200], fields, reason });
const deletedCode = 'LIBRARY_ITEM_DELETED';
const archive = '/api/chats/:/backup-archive';

export const rules = [
  read(
    'manuscript-label',
    ['/api/chats/:/manuscript'],
    [removed('body.scenes.*.label')],
    'The reader formats scene labels from manuscript metadata.'
  ),
  read(
    'backup-cache',
    ['/api/backup', archive],
    [added('headers.cache-control', 'no-store')],
    'Backup downloads now explicitly disable caching.'
  ),
  read(
    'backup-status',
    ['/api/backups'],
    [
      field(
        'body.error',
        '이전 백업이 중단됐어요. 완성된 백업만 목록에 표시해요.',
        'BACKUP_INTERRUPTED'
      ),
    ],
    'Interrupted backups return the stable error code.'
  ),
  read(
    'option-conflict',
    ['/api/chats/:/options'],
    [
      field(
        'body.conflicts.*',
        '프롬프트 소속이나 옵션 정의가 바뀌어 이전 채팅 고정값을 적용하지 않아요. 현재 정의로 다시 저장해 주세요.',
        'fixed_definition_changed'
      ),
      field(
        'body.conflicts.*',
        '다음 요청 옵션의 프롬프트 정의가 바뀌었어요. 선택을 취소하고 다시 지정해 주세요.',
        'pending_definition_changed'
      ),
    ],
    'The client translates the fixed and pending option conflict codes.'
  ),
  read(
    'deletion-description',
    ['/api/chats/:/deletion-impact'],
    [removed('body.description')],
    'The client owns the deletion explanation.'
  ),
  read(
    'template-list-description',
    ['/api/prompt-templates'],
    [removed('body.*.description')],
    'Template list descriptions moved to the client.'
  ),
  read(
    'template-description',
    ['/api/prompt-templates/:'],
    [removed('body.description')],
    'Template detail descriptions moved to the client.'
  ),
  read(
    'push-reason',
    ['/api/push'],
    [removed('body.reason')],
    'The client explains notification availability.'
  ),
  read(
    'archive-notices',
    [archive],
    [removed('body.manifest.backup.notices', { type: 'strings' })],
    'Transfer notices are localized by the importing client.'
  ),
  {
    id: 'deleted-library-refusal',
    routes: [
      '/api/content/:',
      '/api/content/:/risu-preview',
      '/api/content/:/risu-export',
      '/api/prompt-presets/:',
      '/api/prompt-presets/:/risu-export',
      '/api/connections/:',
      '/api/connections/:/catalog',
      '/api/model-presets/:',
      '/api/revisions/content/:/:',
      '/api/revisions/prompt-preset/:/:',
    ],
    status: [404, 404],
    when: 'deleted-refusal',
    fields: [removed('body.error', 'Library item not found'), added('body.code', deletedCode)],
    reason: 'The library visibility check reports deleted items with a stable code.',
  },
  {
    id: 'retained-chat-archive',
    routes: [archive],
    status: [404, 200],
    when: 'hidden-archive-root',
    fields: [
      field('status', 404, 200),
      removed('body.error', 'Library item deleted'),
      added('body.manifest', object),
      added('body.images', object),
      added('headers.cache-control', 'no-store'),
      field('headers.content-type', 'application/json; charset=utf-8', 'application/zip'),
      added('headers.content-disposition', 'attachment; filename="chat-backup.uimori"'),
      added('headers.transfer-encoding', 'chunked'),
    ],
    reason: 'Chat backup can export retained data for a hidden library attachment.',
  },
  {
    id: 'hidden-content-editor',
    routes: ['/api/resources/content/:'],
    status: [200, 404],
    when: 'hidden-content',
    fields: [
      field('status', 200, 404),
      added('body.code', deletedCode),
      ...['id', 'kind', 'title', 'description', 'text', 'loading'].map((k) => removed('body.' + k)),
      removed('body.revision', number),
      removed('body.relatedIds', list),
      removed('body.package', object),
    ],
    reason: 'Opening a hidden content resource now refuses access to its retained revision.',
  },
];
