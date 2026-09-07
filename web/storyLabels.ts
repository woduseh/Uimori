import type { Branch, Library, ModelPreset } from '../core/product.js';
import type { ReaderDetail } from '../core/types.js';

export function modelLabel(model: ModelPreset, library: Library | null) {
  const connection = library?.connections.find(item => item.id === model.connectionId);
  const providers: Record<string, string> = { 'codex-app-server-v1':'Codex', 'vertex-gemini-v1': 'Vertex AI', 'openai-responses-v1': 'OpenAI Responses', 'openai-chat-v1': 'OpenAI Chat', 'anthropic-messages-v1': 'Anthropic', 'vercel-chat-v1': 'Vercel AI Gateway', 'fixture-sse-v1': '검사용 fixture' };
  const provider = connection ? providers[connection.protocol] ?? '저장된 연결' : '연결 확인 필요';
  return `${model.title} · ${provider}`;
}

export function branchLabel(branch: Branch, detail: ReaderDetail) {
  if (branch.default) return '기본 전개';
  if (branch.title !== '후보 분기') return branch.title;
  // Run order is creation order; adding a candidate never renumbers earlier ones.
  const candidates = detail.runs.filter(run => run.snapshot.candidateOf && run.snapshot.branchId);
  const index = candidates.findIndex(run => run.snapshot.branchId === branch.id);
  return index >= 0 ? `다른 응답 ${index + 1}` : '보관된 다른 응답';
}
