import { ProviderContractError } from './provider-errors.js';
import {
  fileInputUnsupportedReason,
  providerFileLimits,
  type RequestFile,
} from './request-files.js';
import type { ProviderProtocol } from './product.js';
import type { Json, ProviderRequest } from './transport.js';

export function providerFileReference(file: RequestFile): string {
  return `uimori-file://${file.hash}/${file.bytes}/${file.kind}/${file.tokenEstimate ?? 'unknown'}`;
}
export function requestFiles(request: Pick<ProviderRequest, 'prompt'>): RequestFile[] {
  return (request.prompt?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) => (part.type === 'file' ? [part.file] : []))
  );
}
export function assertProviderFileSupport(
  request: Pick<ProviderRequest, 'prompt' | 'modelId'>,
  protocol: ProviderProtocol
): void {
  const files = requestFiles(request);
  const limits = providerFileLimits(protocol);
  let total = 0;
  for (const file of files) {
    const reason = fileInputUnsupportedReason(protocol, request.modelId, file);
    if (reason) throw new ProviderContractError(reason);
    const max =
      (protocol === 'google-gemini-v1' || protocol === 'vertex-gemini-v1') &&
      file.mime === 'application/pdf'
        ? 50_000_000
        : limits.maxFileBytes;
    if (file.bytes >= max) throw new ProviderContractError('FILE_INPUT_TOO_LARGE');
    total += file.bytes;
  }
  if (total >= limits.maxTotalBytes) throw new ProviderContractError('FILE_REQUEST_TOO_LARGE');
}
export function providerFilePart(file: RequestFile, protocol: ProviderProtocol): Json {
  const reference = providerFileReference(file);
  if (protocol === 'openai-responses-v1')
    return { type: 'input_file', filename: file.name, file_data: reference };
  if (protocol === 'openai-chat-v1' || protocol === 'vercel-chat-v1')
    return { type: 'file', file: { filename: file.name, file_data: reference } };
  if (protocol === 'anthropic-messages-v1')
    return {
      type: 'document',
      source: {
        type: file.kind === 'text' ? 'text' : 'base64',
        media_type: file.kind === 'text' ? 'text/plain' : file.mime,
        data: reference,
      },
      title: file.name,
    };
  if (protocol === 'google-gemini-v1' || protocol === 'vertex-gemini-v1')
    return { inlineData: { mimeType: file.mime, data: reference } };
  if (protocol === 'fixture-sse-v1')
    return { type: 'file', file: { filename: file.name, file_data: reference } };
  throw new ProviderContractError('FILE_INPUT_UNSUPPORTED_PROTOCOL');
}
const object = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Only native file-bearing slots have authority to request binary resolution. */
export function fileSlot(
  value: Record<string, Json>
): { owner: Record<string, Json>; key: string; url: boolean; text?: boolean } | undefined {
  if (value.type === 'input_file') return { owner: value, key: 'file_data', url: true };
  if (value.type === 'file' && object(value.file))
    return { owner: value.file, key: 'file_data', url: true };
  if (
    value.type === 'document' &&
    object(value.source) &&
    ['base64', 'text'].includes(String(value.source.type))
  )
    return { owner: value.source, key: 'data', url: false, text: value.source.type === 'text' };
  if (object(value.inlineData)) return { owner: value.inlineData, key: 'data', url: false };
  return undefined;
}
export function plannedFileMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const slot = fileSlot(value as Record<string, Json>);
  const reference = slot?.owner[slot.key];
  if (typeof reference !== 'string') return;
  const match =
    /^uimori-file:\/\/([a-f0-9]{64})\/([1-9][0-9]*)\/(document|text|audio|video)\/(unknown|[1-9][0-9]*)$/u.exec(
      reference
    );
  if (!match) return;
  return {
    bytes: Number(match[2]),
    kind: match[3] as RequestFile['kind'],
    tokenEstimate: match[4] === 'unknown' ? undefined : Number(match[4]),
  };
}
