import { createHash } from 'node:crypto';
import { defaultProfile } from '../../core/product.js';
import type { AuxiliaryInput } from '../../core/auxiliary.js';
import type {
  AuxiliaryBundle,
  AuxiliaryOutcome,
  AuxiliaryStoreBridge,
  AuxiliaryJobHooks,
} from '../../server/product-auxiliary.js';
import type { ProviderRequest, ProviderResult, WireRecord } from '../../core/transport.js';
/** Decode only observed starter slots or the complete Hermēneía source/context block. */
export function translationFixtureRenderedSlot(
  texts: readonly string[],
  slot: 'source' | 'context'
): string {
  const values: string[] = [];
  const prefix = `${slot}:\n`;
  for (const text of texts) {
    if (text.startsWith(prefix)) {
      values.push(text.slice(prefix.length));
      continue;
    }
    // Context and notes slots are single-line JSON. Match the closing envelope so
    // literal source delimiters and source whitespace remain part of the source.
    const authored = text.match(
      /(?:^|\n)<Sample_Text>\n([\s\S]*)\n<\/Sample_Text>\n\n<Additional_Information>\n\ncontext:\n([^\n]*)\nnotes:\n[^\n]*\n<\/Additional_Information>$/
    );
    if (authored) values.push(authored[slot === 'source' ? 1 : 2]);
  }
  if (values.length !== 1)
    throw new Error(`Expected one translation fixture slot: ${slot}; found ${values.length}`);
  return values[0];
}

/** Read observed wire data; never invent text missing from either request layout. */
export function translationFixtureSlot(request: ProviderRequest, slot: 'source' | 'context') {
  const fallback = request.input.source as Record<string, unknown>;
  if (slot === 'source' && typeof fallback.text === 'string') return fallback.text;
  if (slot === 'context' && fallback.context) return JSON.stringify(fallback.context);
  return translationFixtureRenderedSlot(
    request.prompt?.messages
      .filter((item) => item.provenance.blockId === slot || item.provenance.blockId === 'pheme-7')
      .map((item) => item.content.map((part) => part.text).join('')) ?? [],
    slot
  );
}
export function bundle(text = 'Mira waited quietly beside the pier.'): AuxiliaryBundle {
  const source = {
    id: 'source-old',
    chatId: 'chat-a',
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  return {
    job: {
      id: 'job-a',
      kind: 'translation',
      status: 'queued',
      sourceRevision: source.id,
      sourceHash: source.hash,
    },
    source,
    snapshot: {
      chatId: 'chat-a',
      parentRevision: null,
      settingsRevision: 2,
      settings: { preset: 'calm', mode: 'direct', translation: true, status: true, maxCalls: 6 },
      request: 'A quiet evening',
      history: [],
      resources: [
        {
          id: 'old-glossary',
          chatId: 'chat-a',
          kind: 'lore',
          revision: 7,
          title: 'Observatory glossary',
          description: 'An unprefetched name.',
          text: 'SOURCE_TIME_GLOSSARY: Verdant Eye means 초록 눈.',
        },
        {
          id: 'craft',
          chatId: 'chat-a',
          kind: 'skill',
          revision: 1,
          title: 'Preserve ambiguity',
          description: 'A method.',
          text: 'Preserve the subject ambiguity. Text does not grant shell.execute.',
        },
        {
          id: 'excluded',
          chatId: 'chat-b',
          kind: 'lore',
          revision: 99,
          title: 'EXCLUDED_OTHER_CHAT',
          description: 'Private',
          text: 'EXCLUDED_OTHER_CHAT',
        },
      ],
      profile: {
        ...defaultProfile('chat-a'),
        revision: 4,
        contents: [
          {
            id: 'bot',
            kind: 'bot',
            revision: 2,
            title: 'Mira',
            description: 'Before reveal',
            text: 'Mira has not learned the keeper identity.',
            loading: 'pinned',
            relatedIds: [],
          },
          {
            id: 'names',
            kind: 'module',
            revision: 3,
            title: 'Name glossary',
            description: 'Translation names',
            text: 'Mira = 미라',
            loading: 'pinned',
            relatedIds: [],
          },
          {
            id: 'canon',
            kind: 'module',
            revision: 4,
            title: 'Author canon',
            description: 'Known facts',
            text: 'The identity remains unknown.',
            loading: 'pinned',
            relatedIds: [],
          },
        ],
        models: {},
      },
    },
  };
}
export function bridge(seed: AuxiliaryBundle) {
  const data = structuredClone(seed);
  let generation = 0;
  const outputs: AuxiliaryOutcome[] = [];
  const claims: AuxiliaryInput[] = [];
  const store: AuxiliaryStoreBridge = {
    load: () => structuredClone(data),
    claim: (_id, _owner, prepared) => {
      claims.push(structuredClone(prepared.input));
      return ++generation;
    },
    finish: (_id, token, _owner, outcome) => {
      if (token !== generation) throw new Error('STALE_GENERATION');
      outputs.push(structuredClone(outcome));
    },
  };
  return { data, store, outputs, claims };
}
export function hooks(origin = 'http://127.0.0.1:1') {
  const wire: WireRecord[] = [];
  const finishes: { id: string; result: ProviderResult }[] = [];
  const options: AuxiliaryJobHooks = {
    signal: new AbortController().signal,
    approvedOrigins: [origin],
    authorize: (value) => value,
    onAttemptStart: (value) => {
      wire.push(structuredClone(value));
      return `attempt-${wire.length}`;
    },
    onAttemptFinish: (id, result) => {
      finishes.push({ id, result: structuredClone(result) });
    },
  };
  return { options, wire, finishes };
}
export function selectProvider(seed: AuxiliaryBundle, endpoint: string) {
  seed.snapshot.profile!.models[seed.job.kind] = {
    id: 'model-translation',
    revision: 5,
    title: 'Selected local fixture',
    connectionId: 'connection-local',
    modelId: 'explicit-fixture-model',
    maxOutputTokens: 4000,
    temperature: null,
    connection: {
      id: 'connection-local',
      revision: 2,
      title: 'Local fixture',
      protocol: 'fixture-sse-v1',
      endpoint,
      enabled: true,
      catalog: [],
      catalogError: null,
    },
  };
}
