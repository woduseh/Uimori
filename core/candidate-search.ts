export type CandidateSearchDocument = { id: string; title: string; text: string };

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  const normalized = text.normalize('NFC').toLowerCase();
  for (const word of normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    add(word);
    // Names remain discoverable inside Korean particles and unspaced Japanese sentences.
    for (const match of word.matchAll(cjk)) {
      const characters = [...match[0]];
      for (let index = 1; index < characters.length; index++) {
        const pair = characters[index - 1] + characters[index];
        if (pair !== word) add(pair);
      }
    }
  }
  return counts;
}

type Posting = { index: number; score: number };

export function createCandidateSearch(documents: readonly CandidateSearchDocument[]): {
  rank(queries: readonly { text: string; weight: number }[]): string[];
} {
  const ids = documents.map((document) => document.id);
  const postings = new Map<string, Posting[]>();
  documents.forEach((document, index) => {
    const title = termCounts(document.title);
    const body = termCounts(document.text);
    for (const term of new Set([...title.keys(), ...body.keys()])) {
      const titleCount = title.get(term) ?? 0;
      const bodyCount = body.get(term) ?? 0;
      // Saturating frequency prevents repeated prose from overwhelming a rare detail.
      // No body-length penalty: a long lore entry's late paragraphs are still useful.
      const score = (3 * titleCount) / (titleCount + 1) + bodyCount / (bodyCount + 1);
      const list = postings.get(term) ?? [];
      list.push({ index, score });
      postings.set(term, list);
    }
  });
  const inverseFrequency = new Map<string, number>();
  for (const [term, list] of postings) {
    const idf = Math.log(1 + (documents.length - list.length + 0.5) / (list.length + 0.5));
    inverseFrequency.set(term, idf);
    for (const posting of list) posting.score *= idf;
  }
  const order = ids.map((_, index) => index);
  order.sort((left, right) => (ids[left] < ids[right] ? -1 : ids[left] > ids[right] ? 1 : 0));

  return {
    rank(queries) {
      const scores = new Float64Array(ids.length);
      for (const query of queries) {
        if (!Number.isFinite(query.weight) || query.weight <= 0) continue;
        const terms = [...termCounts(query.text).keys()];
        const total = terms.reduce((sum, term) => sum + (inverseFrequency.get(term) ?? 0), 0);
        if (total === 0) continue;
        // Each query has its own weight; a long or repetitive old scene cannot inflate it.
        const weight = query.weight / total;
        for (const term of terms) {
          for (const posting of postings.get(term) ?? []) {
            scores[posting.index] += posting.score * weight;
          }
        }
      }
      // Stable sort preserves ID order for both equal matches and unmatched documents.
      return [...order]
        .sort((left, right) => scores[right] - scores[left])
        .map((index) => ids[index]);
    },
  };
}
