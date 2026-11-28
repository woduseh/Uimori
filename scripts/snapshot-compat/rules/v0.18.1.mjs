export const commit = '13e5d62bad381888249b6642a382a447b8e35c0d';
const string = { type: 'string' },
  object = { type: 'object' },
  list = { type: 'array' },
  number = { type: 'number' };
const field = (path, before, after) => ({ path, before, after });
const removed = (path, type = string) => field(path, type, undefined);
const added = (path, value) => field(path, undefined, value);
const read = (id, routes, fields, reason) => ({ id, routes, status: [200, 200], fields, reason });
const restored = (id, route, fields, reason) => ({
  id,
  routes: [route],
  status: [200, 200],
  when: id,
  fields,
  reason,
});
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
    'The deletion dialog did not render the old server description.'
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
    'reader-opening-flag',
    ['/api/chats/:/reader'],
    [added('body.runs.*.opening', true)],
    'Reader runs name the authored opening so the web hides its request and rewrite controls.'
  ),
  read(
    'reader-runs-opening-flag',
    ['/api/chats/:/reader-runs'],
    [added('body.*.opening', true)],
    'Reader runs name the authored opening so the web hides its request and rewrite controls.'
  ),
  read(
    'archive-notices',
    [archive],
    [removed('body.manifest.backup.notices', { type: 'strings' })],
    'New exports omit the static notices that the importer never rendered.'
  ),
  {
    id: 'scene-detail-refusal',
    routes: ['/api/attempts/:/scene-detail'],
    status: [404, 404],
    when: 'scene-detail-refusal',
    fields: [removed('body.error', 'Scene invocation not found'), added('body.code', deletedCode)],
    reason: 'An attempt without a writing scene now returns the stable missing-record code.',
  },
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
    id: 'risu-export-refusal-cache',
    routes: ['/api/content/:/risu-export', '/api/prompt-presets/:/risu-export'],
    status: [404, 404],
    when: 'deleted-refusal',
    fields: [added('headers.cache-control', 'no-store')],
    reason:
      'These routes set no-store only on a successful export; registerRawRoute now sets it on every reply, so the deleted-item refusal carries it too.',
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
  read(
    'model-preset-evaluation-tools',
    ['/api/model-presets/:'],
    [removed('body.evaluationTools', object)],
    'The evaluation tools feature was removed, so a preset no longer carries its setting.'
  ),
  read(
    'library-evaluation-tools',
    ['/api/library'],
    [removed('body.models.*.evaluationTools', object)],
    'The evaluation tools feature was removed, so a library model no longer carries its setting.'
  ),
  read(
    'helper-workspace-cache',
    [
      '/api/helper/projects',
      '/api/helper/conversations',
      '/api/helper/conversations/:',
      '/api/helper/conversations/:/context',
      '/api/helper/conversations/:/deletion',
    ],
    [added('headers.cache-control', 'no-store')],
    'The helper workspace routes became typed endpoints, which disable caching on every reply.'
  ),
  read(
    'helper-task-results-changes',
    ['/api/helper/tasks/:/results'],
    [removed('body.changes', list)],
    'Helper change cards and turn rollback were removed, so task results no longer carry change records.'
  ),
  read(
    'backup-helper-changes',
    ['/api/backup'],
    [
      removed('body.helper_changes', object),
      field('body.image_cleanup_candidates.rows', number, number),
      field('body.image_cleanup_candidates.sha256', string, string),
    ],
    'Opening the database drops the helper change table and queues the images that only its rollback baselines held for cleanup.'
  ),
  restored(
    'restored-opening-manuscript',
    '/api/chats/:/manuscript',
    [field('body.scenes.*.number', number, number)],
    'A chat restored from an archive now counts its authored opening as scene zero, so every number moves down by one.'
  ),
  restored(
    'restored-opening-reader',
    '/api/chats/:/reader',
    [
      field('body.reader.navigation.*.number', number, number),
      field('body.reader.navigation.0.label', string, '첫 메시지'),
      added('body.reader.navigation.0.opening', true),
      field('body.runs.*.modelTitle', string, null),
    ],
    'A chat restored from an archive now reads its authored opening as the opening: scene numbers move down by one, its entry is labelled and flagged, and its run names no model.'
  ),
  restored(
    'restored-opening-reader-runs',
    '/api/chats/:/reader-runs',
    [field('body.*.modelTitle', string, null)],
    'The run of an authored opening restored from an archive no longer names a model.'
  ),
  restored(
    'restored-opening-archive',
    archive,
    [
      removed('body.manifest.backup.chats.0.state.messages.0.authored', object),
      added('body.manifest.backup.chats.0.state.messages.0.opening', true),
    ],
    'The archive of a restored authored opening names it as the opening instead of carrying its authored text.'
  ),
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
