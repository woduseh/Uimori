import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sizeOf = text => ({ utf16CodeUnits: text.length, unicodeCodePoints: [...text].length, utf8Bytes: Buffer.byteLength(text), actualTokens: null, estimatedTokens: Math.ceil(text.length / 4), estimateMethod: 'UTF-16 code units / 4; synthetic English heuristic, not model tokenization' });

// Gold is deliberately separate from model-facing source text. These are hand-authored
// probes surrounded by procedurally varied events, not model-generated ground truth.
export function generateCorpus(targetEstimatedTokens = 180000) {
  if (!Number.isSafeInteger(targetEstimatedTokens) || targetEstimatedTokens < 150000 || targetEstimatedTokens > 200000) throw new Error('Target must be 150000..200000 estimated tokens');
  const actors = ['Mira Vale', 'Mira Vail', 'Miro Vale', 'Neri Moss', 'Tavi Reed', 'Lena Ash', 'Orin Pike', 'Sera Lake'];
  const places = ['north quay', 'glass archive', 'east mill', 'reed observatory', 'salt garden', 'river clinic', 'copper station', 'old kiln'];
  const objects = ['weather ledger', 'brass gauge', 'seed crate', 'water map', 'signal lamp', 'cloth parcel', 'clay seal', 'supply register'];
  const actions = ['inspected', 'repaired', 'delivered', 'catalogued', 'borrowed', 'weighed', 'returned', 'relabelled'];
  const probes = [
    { id: 'old-fact', slot: 1, text: 'Mira Vale hid the original harbor key inside a blue ceramic kettle. Only Mira Vale witnessed this hiding.', answer: ['blue ceramic kettle'], question: 'Where did Mira Vale originally hide the harbor key?' },
    { id: 'similar-name', slot: 9, text: 'Mira Vail, the cartographer, carried a silver compass. Mira Vale, the mechanic, carried a wooden ruler. They are different people.', answer: ['Mira Vail: silver compass', 'Mira Vale: wooden ruler'], question: 'Distinguish the tools carried by Mira Vail and Mira Vale. Format each as Name: tool.' },
    { id: 'order-a', slot: 28, text: 'The west bell cracked on story day 12, before the ferry was repaired.', answer: [], question: null },
    { id: 'order-b', slot: 109, text: 'The ferry was repaired on story day 19. The west bell had already cracked on day 12. The festival began on day 23.', answer: ['bell cracked', 'ferry repaired', 'festival began'], question: 'List these events in chronological order: festival began, ferry repaired, bell cracked.' },
    { id: 'old-code', slot: 45, text: 'At this time the archive access code was amber-seven. This describes the old code only.', answer: [], question: null },
    { id: 'changed-fact', slot: 157, text: 'On story day 51 the archive access code changed from amber-seven to violet-nine. The old code no longer works.', answer: ['violet-nine'], forbidden: ['amber-seven'], question: 'Give only the currently working archive access code.' },
    { id: 'private', slot: 75, text: 'Neri Moss privately learned that the lost invoice is beneath the clinic stairs. Neri told nobody. Mira Vale has never learned its location.', answer: ['unknown to Mira Vale'], forbidden: ['beneath the clinic stairs'], question: 'From Mira Vale\'s knowledge alone, where is the lost invoice? Use unknown to Mira Vale if she cannot know.' },
    { id: 'belief-a', slot: 90, text: 'Tavi Reed believes the missing vessel sailed north. This is an unverified belief, not an observed voyage.', answer: [], question: null },
    { id: 'uncertainty', slot: 199, text: 'Sera Lake believes the missing vessel sailed south. Neither Sera nor Tavi has evidence; the vessel route remains unresolved.', answer: ['Tavi: north', 'Sera: south', 'unresolved'], question: 'Report Tavi and Sera\'s conflicting beliefs about the vessel route, and whether the route is resolved.' },
    { id: 'editable', slot: 121, text: 'The museum donation receipt records eleven bronze tokens.', answer: ['eleven bronze tokens'], question: 'What does the museum donation receipt record?' },
  ];
  const sources = []; let chars = 0;
  // At least 220 distinct sources ensure late probes exist at either target size.
  for (let i = 0; chars < targetEstimatedTokens * 4 || i < 220; i++) {
    let text = `Scene ${i + 1}. Transcript position ${i + 1}; local story day ${100 + i}. Historical recollections below retain their earlier event dates.\n`;
    for (let j = 0; j < 8; j++) {
      const n = i * 8 + j; const actor = actors[(i + j) % 8]; const other = actors[(i + j + 3) % 8];
      text += `Record ${n}: At the ${places[(i * 3 + j) % 8]}, ${actor} ${actions[(i + j * 3) % 8]} the ${objects[(i * 5 + j) % 8]} numbered ${1000 + n}. ${other} witnessed batch ${n % 37} and recorded ${2 + n % 29} units in register ${i}-${j}. The task concerned district ${n % 17}; the next inspection was scheduled for day ${200 + i + n % 131}. Both witnesses signed this local record, with no claim about events elsewhere.\n`;
    }
    for (const probe of probes.filter(p => p.slot === i)) {
      const start = text.length; text += `${probe.text}\n`;
      probe.evidence = { revision: `scene-${i}`, start, end: start + probe.text.length, quote: probe.text };
    }
    const source = { revision: `scene-${i}`, text, contentHash: sha256(text), transcriptPosition: i, branch: 'main', storyDay: 100 + i, knowledgePolicy: 'Per-event witnesses and probe exceptions are stated in text; scene participation does not grant every fact to every participant.', participants: actors };
    sources.push(source); chars += text.length;
  }
  for (const probe of probes) probe.evidence.hash = sources[probe.slot].contentHash;
  const declarations = [{ id: 'past', author: 'synthetic-author', text: 'Before the transcript began, Lena Ash founded the river clinic in year 41. This is author-declared past, not a transcript event.' }, { id: 'retcon', author: 'synthetic-author', text: 'Retcon: the founder of the river clinic was Orin Pike, not Lena Ash. Year 41 is unchanged.', replacesId: 'past' }];
  const questions = probes.filter(p => p.question).map(p => ({ id: p.id, question: p.question, expected: p.answer, forbidden: p.forbidden ?? [], evidence: [p.evidence], ordered: p.id === 'order-b' }));
  questions.find(q => q.id === 'order-b').evidence.unshift(probes.find(p => p.id === 'order-a').evidence);
  questions.find(q => q.id === 'uncertainty').evidence.unshift(probes.find(p => p.id === 'belief-a').evidence);
  questions.push({ id: 'declared-past', question: 'Before the retcon, who founded the clinic and when?', expected: ['Lena Ash', '41'], forbidden: [], evidence: [{ declarationId: 'past' }] }, { id: 'retcon', question: 'After the author retcon, who founded the clinic?', expected: ['Orin Pike'], forbidden: ['Lena Ash'], evidence: [{ declarationId: 'retcon' }] }, { id: 'other-branch', question: 'What is the east vault password in this main branch? Say unknown if absent.', expected: ['unknown'], forbidden: ['cedar-five'], evidence: [] });
  const foreignSource = { revision: 'sibling-only', text: 'In the sibling branch only, the east vault password is cedar-five.', branch: 'sibling' };
  foreignSource.contentHash = sha256(foreignSource.text);
  const corpusHash = sha256(JSON.stringify({ sources, declarations, foreignSource, questions }));
  return { version: 1, synthetic: true, language: 'English', targetEstimatedTokens, corpusHash, sources, declarations, foreignSource, probes, questions, size: { ...sizeOf(sources.map(s => s.text).join('')), sourceCount: sources.length, declarationCount: declarations.length, scope: 'main source bodies only; excludes gold, metadata, declarations and sibling' } };
}

export function scoreAnswers(corpus, answers) {
  if (!Array.isArray(answers) || new Set(answers.map(a => a.id)).size !== answers.length || answers.some(a => !corpus.questions.some(q => q.id === a.id))) throw new Error('Invalid or duplicate answer IDs');
  const rows = corpus.questions.map(q => {
    const a = answers.find(a => a.id === q.id); const text = typeof a?.text === 'string' ? a.text : ''; const refs = a?.evidence ?? [];
    if (!Array.isArray(refs)) throw new Error('Invalid evidence');
    const positions = q.expected.map(atom => text.toLowerCase().indexOf(atom.toLowerCase()));
    const recalled = positions.filter(p => p >= 0).length;
    const exactRef = (r, e) => e.declarationId ? r.declarationId === e.declarationId && Object.keys(r).length === 1 : r.revision === e.revision && r.hash === e.hash && r.start === e.start && r.end === e.end && r.quote === e.quote;
    const correctRefs = refs.filter(r => q.evidence.some(e => exactRef(r, e))).length;
    const coveredRefs = q.evidence.filter(e => refs.some(r => exactRef(r, e))).length;
    const contamination = q.forbidden.filter(atom => text.toLowerCase().includes(atom.toLowerCase()));
    const ordered = !q.ordered || positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]));
    return { id: q.id, answered: !!a, recalled, expected: q.expected.length, contamination, ordered, correctRefs, suppliedRefs: refs.length, expectedRefs: q.evidence.length, coveredRefs, pass: !!a && recalled === q.expected.length && !contamination.length && ordered && correctRefs === refs.length && coveredRefs === q.evidence.length };
  });
  const sum = key => rows.reduce((n, r) => n + r[key], 0);
  return { rubric: 'Exact required atoms, forbidden atoms, ordered positions and exact gold evidence; manual semantic review still required (extra unsupported prose is not fully detected)', rows, answerRecall: sum('recalled') / sum('expected'), contaminatedQuestions: rows.filter(r => r.contamination.length).length, citationPrecision: sum('suppliedRefs') ? sum('correctRefs') / sum('suppliedRefs') : null, citationRecall: sum('coveredRefs') / sum('expectedRefs'), passed: rows.filter(r => r.pass).length, total: rows.length };
}

export function preflight(corpus, config = {}) {
  const blockers = [];
  if (config.resumeQualityEvaluation !== true) blockers.push('Explicit resumption approval required');
  if (config.corpusHash !== corpus.corpusHash || config.syntheticOnly !== true) blockers.push('Exact synthetic corpus approval required');
  for (const key of ['provider', 'model', 'approvalReference']) if (typeof config[key] !== 'string' || !config[key].trim()) blockers.push(`${key} required`);
  const minimumCalls = corpus.sources.length + corpus.questions.length * 2;
  if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < minimumCalls) blockers.push(`maxCalls must cover ${minimumCalls} calls (one extraction/source + two answer arms; tool rounds/retries additional)`);
  if (!Number.isFinite(config.maxUsd) || config.maxUsd <= 0) blockers.push('Positive maxUsd required');
  if (!config.tokenCount || config.tokenCount.corpusHash !== corpus.corpusHash || config.tokenCount.model !== config.model || !Number.isSafeInteger(config.tokenCount.tokens) || config.tokenCount.tokens < 150000 || config.tokenCount.tokens > 200000 || !config.tokenCount.method) blockers.push('Model-matched 150k..200k token count and method required; estimates are insufficient');
  if (!config.pricing?.source || !Number.isFinite(config.pricing.inputUsdPerMillion) || config.pricing.inputUsdPerMillion < 0 || !Number.isFinite(config.pricing.outputUsdPerMillion) || config.pricing.outputUsdPerMillion < 0) blockers.push('Verified pricing basis required for budget reservation; billing remains separate');
  if (!Number.isSafeInteger(config.maxOutputTokensPerCall) || config.maxOutputTokensPerCall <= 0) blockers.push('maxOutputTokensPerCall required');
  if (!Number.isSafeInteger(config.maxInputTokensPerCall) || config.maxInputTokensPerCall < (config.tokenCount?.tokens ?? Infinity) + 8000) blockers.push('maxInputTokensPerCall must cover source tokens plus at least 8000 tokens for instructions/tools; count actual assembled requests before sending');
  const reservedUpperBoundUsd = Number.isSafeInteger(config.maxCalls) && Number.isSafeInteger(config.maxInputTokensPerCall) && Number.isSafeInteger(config.maxOutputTokensPerCall) && Number.isFinite(config.pricing?.inputUsdPerMillion) && Number.isFinite(config.pricing?.outputUsdPerMillion) ? config.maxCalls * (config.maxInputTokensPerCall * config.pricing.inputUsdPerMillion + config.maxOutputTokensPerCall * config.pricing.outputUsdPerMillion) / 1000000 : null;
  if (reservedUpperBoundUsd !== null && reservedUpperBoundUsd > config.maxUsd) blockers.push('Worst-case reservation exceeds maxUsd; reduce approved calls/context/output or explicitly approve a sufficient budget');
  return { status: blockers.length ? 'BLOCKED' : 'READY_FOR_REVIEW', networkCalls: 0, costUsd: null, reservedUpperBoundUsd, minimumCalls, blockers, executeSupported: false, note: 'Read-only offline validation of user-supplied attestations, not approval, verified pricing, or automatic live execution. Revalidate host permission, reserve cumulative worst-case cost before each attempt, and never replay uncertain execution.' };
}
