import { createHash } from 'node:crypto';

/** Read-only, one-time extraction. Old execution snapshots are deliberately never expanded. */
export function readLegacy24(db) {
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 24)
    throw new Error('This transfer accepts only the previous schema-24 database.');
  const exists = (name) =>
    !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  const rows = (table) => (exists(table) ? db.prepare(`SELECT * FROM ${table}`).all() : []);
  const parse = (value, fallback = null) =>
    value === null || value === undefined ? fallback : JSON.parse(String(value));
  const latest = new Map();
  for (const row of rows('versions')) {
    const key = `${row.kind}:${row.id}`,
      prior = latest.get(key);
    if (!prior || row.revision > prior.revision) latest.set(key, row);
  }
  const values = (kind) =>
    [...latest.values()].filter((row) => row.kind === kind).map((row) => parse(row.body));
  const contents = values('content'),
    prompts = values('prompt-preset');
  const contentKeys = new Map(contents.map((value, index) => [value.id, `content-${index + 1}`]));
  const contentById = new Map(contents.map((value) => [value.id, value]));
  const combinations = values('prompt-combination');
  const images = values('package-image').map((image) => ({
    id: image.hash,
    revision: 1,
    ...image,
  }));
  const imageByHash = new Map(images.map((image) => [image.hash, image]));
  const assetUrls = new Map();
  const addImage = (bytes, mime) => {
    const data = Buffer.from(bytes),
      hash = createHash('sha256').update(data).digest('hex');
    imageByHash.set(hash, { id: hash, revision: 1, hash, mime, base64: data.toString('base64') });
    return hash;
  };
  for (const row of rows('assets')) {
    const body = parse(row.body);
    assetUrls.set(`/api/assets/${row.id}`, addImage(row.bytes, body.mime));
  }
  const illustrationImages = rows('illustration_images');
  for (const row of illustrationImages)
    assetUrls.set(`/api/illustration-images/${row.id}`, addImage(row.bytes, row.mime));
  const rewriteMedia = (text) =>
    String(text).replace(/\/api\/(?:assets|illustration-images)\/[A-Za-z0-9_.-]+/gu, (url) =>
      assetUrls.has(url) ? `/api/package-image-blobs/${assetUrls.get(url)}` : url
    );
  const file = {
    format: 'uimori-native-transfer',
    version: 1,
    roots: [
      ...contents.map((_item, index) => ({ kind: 'content', key: `content-${index + 1}` })),
      ...prompts.map((_item, index) => ({ kind: 'prompt-preset', key: `prompt-${index + 1}` })),
    ],
    contents: contents.map((source, index) => {
      const copy = structuredClone(source);
      copy.package.modules = (copy.package.modules ?? []).map((ref) => {
        const target = contentById.get(ref.id);
        if (!target)
          throw new Error(`Missing module ${ref.id}; no destination data has been committed.`);
        return { id: target.id, revision: target.revision };
      });
      return {
        key: `content-${index + 1}`,
        source: copy,
        modules: copy.package.modules.map((ref) => contentKeys.get(ref.id)),
      };
    }),
    prompts: prompts.map((source, index) => ({
      key: `prompt-${index + 1}`,
      source,
      combinations: combinations.filter(
        (item) => item.owner?.kind === 'preset' && item.owner.id === source.id
      ),
    })),
    images: [...imageByHash.values()],
  };
  const chats = rows('chats'),
    branches = rows('branches'),
    profiles = new Map(rows('profiles').map((row) => [row.chat_id, parse(row.body)]));
  const sources = new Map(rows('sources').map((row) => [row.id, row]));
  const runs = new Map(rows('runs').map((row) => [row.id, row]));
  const edits = new Map();
  for (const row of rows('source_edits'))
    if (!edits.has(row.source_id) || edits.get(row.source_id).revision < row.revision)
      edits.set(row.source_id, row);
  const notes = rows('author_notes').map((row) => ({ ...row, entry: parse(row.entry) }));
  const outputs = new Map(
    rows('chat_variable_outputs').map((row) => [row.source_id, parse(row.body)])
  );
  const variableStates = rows('chat_variable_states');
  const jobs = rows('jobs'),
    results = new Map(rows('job_results').map((row) => [row.job_id, parse(row.result)]));
  const illustrationJobs = new Map(rows('illustration_jobs').map((row) => [row.id, row]));
  const conversationCopies = [];
  for (const chat of chats) {
    const profile = profiles.get(chat.id);
    if (!profile?.packageAttachments?.some((ref) => ref.role === 'bot'))
      throw new Error(`Chat ${chat.id} has no owning bot.`);
    const ownBranches = branches.filter((row) => row.chat_id === chat.id);
    for (const branch of ownBranches.length
      ? ownBranches
      : [
          {
            id: `main:${chat.id}`,
            title: 'Main',
            head_revision: chat.head_revision,
            is_default: 1,
          },
        ]) {
      const chain = [],
        visited = new Set();
      let head = branch.head_revision;
      while (head) {
        if (visited.has(head)) throw new Error(`Cyclic message history in chat ${chat.id}.`);
        visited.add(head);
        const source = sources.get(head);
        if (!source || source.chat_id !== chat.id) throw new Error(`Missing message ${head}.`);
        chain.push(source);
        head = source.parent_revision;
      }
      chain.reverse();
      const checkpoints = chain.map((source) => outputs.get(source.id) ?? null);
      const currentVariables = variableStates.find(
        (row) => row.chat_id === chat.id && row.branch_id === branch.id
      );
      const title = branch.is_default
        ? chat.title
        : `${chat.title} · ${branch.title}`.slice(0, 200);
      const entries = chain.map((source) => {
        const authored = edits.get(source.id) ?? source;
        const translated = jobs
          .filter(
            (job) =>
              job.source_revision === source.id &&
              job.kind === 'translation' &&
              job.status === 'completed' &&
              job.source_hash === authored.hash
          )
          .sort((a, b) => b.revision - a.revision)
          .map((job) => results.get(job.id))
          .find((result) => typeof result?.text === 'string');
        return {
          request: String(runs.get(source.run_id)?.request ?? ''),
          text: rewriteMedia(authored.text),
          translation: translated ? rewriteMedia(translated.text) : null,
        };
      });
      const visibleNotes = notes.filter(
        (row) =>
          row.chat_id === chat.id &&
          (row.entry.atRevision === null || visited.has(row.entry.atRevision))
      );
      const replacedNotes = new Set(visibleNotes.map((row) => row.replaces_id).filter(Boolean));
      const transcriptNotes = visibleNotes
        .filter((row) => !row.entry.retired && !replacedNotes.has(row.id))
        .map((row) => {
          const entry = row.entry;
          return {
            text: entry.text,
            author: entry.declaration?.author ?? 'user',
            atIndex:
              entry.atRevision === null
                ? null
                : chain.findIndex((source) => source.id === entry.atRevision),
            kind: entry.kind ?? 'author-note',
            ...(entry.kind === 'imported-memory' ? { origin: entry.origin } : {}),
          };
        });
      const illustrations = illustrationImages.flatMap((image) => {
        const job = illustrationJobs.get(image.job_id),
          entry = chain.findIndex((source) => source.id === job?.source_revision);
        if (!job || job.status !== 'completed' || entry < 0) return [];
        return [
          {
            entry,
            mime: image.mime,
            base64: Buffer.from(image.bytes).toString('base64'),
            title: String(parse(image.body)?.caption ?? ''),
          },
        ];
      });
      conversationCopies.push({
        sourceChatId: chat.id,
        copy: {
          transcript: {
            format: 'uimori-chat-transcript',
            version: 2,
            exportedAt: new Date().toISOString(),
            title,
            packageAttachments: profile.packageAttachments,
            notes: transcriptNotes,
            entries,
          },
          state: {
            variables: currentVariables
              ? {
                  revision: currentVariables.revision,
                  values: parse(currentVariables.values_json, {}),
                }
              : (checkpoints.at(-1) ?? { revision: 0, values: {} }),
            checkpoints,
            settings: parse(chat.settings),
            profile: {
              image: !!profile.image,
              imageTranslation: !!profile.imageTranslation,
              ...(profile.loreContext ? { loreContext: profile.loreContext } : {}),
              ...(profile.pinned ? { pinned: profile.pinned } : {}),
            },
          },
          illustrations,
        },
      });
    }
  }
  return {
    file,
    conversations: conversationCopies,
    connections: rows('provider_settings')
      .filter((row) => row.kind === 'connection')
      .map((row) => parse(row.body)),
    models: rows('provider_settings')
      .filter((row) => row.kind === 'model')
      .map((row) => parse(row.body)),
    workspace: parse(rows('prompt_workspace')[0]?.body),
    notices: [
      '과거 실행 입력·권한 기록·서버 초안·스트리밍 기록은 옮기지 않아요.',
      '각 분기는 독립 채팅으로 옮겨요. 자동 요약과 기기 로그인은 새로 시작해요.',
      '기존 폴더 배치와 예약된 작업·일회성 옵션은 옮기지 않아요.',
    ],
  };
}
