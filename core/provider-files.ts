import { createHash } from 'node:crypto';
import { ProviderContractError } from './provider-errors.js';
import { fileSlot, providerFileReference, requestFiles } from './provider-file-reference.js';
import { providerFileLimits, type ResolvedRequestFile } from './request-files.js';
import type { ProviderProtocol } from './product.js';
import type { Json, ProviderExecutionOptions, ProviderRequest } from './transport.js';
import { requestImages } from './provider-image-reference.js';
export {
  assertProviderFileSupport,
  providerFilePart,
  providerFileReference,
  requestFiles,
  plannedFileMetadata,
} from './provider-file-reference.js';

/** Detach the outgoing body; retained plans, diagnostics and signed replay keep references. */
export async function materializeProviderFiles(
  body: Json,
  request: Pick<ProviderRequest, 'prompt'>,
  options: Pick<ProviderExecutionOptions, 'resolveFile'>,
  protocol: ProviderProtocol,
  signal?: AbortSignal
): Promise<Json> {
  const files = requestFiles(request);
  if (!files.length) {
    if (
      requestImages(request).length &&
      Buffer.byteLength(JSON.stringify(body)) > providerFileLimits(protocol).maxRequestBytes
    )
      throw new ProviderContractError('FILE_REQUEST_TOO_LARGE');
    return body;
  }
  const allowed = new Map(files.map((file) => [providerFileReference(file), file]));
  const resolved = new Map<string, ResolvedRequestFile>();
  const limit = providerFileLimits(protocol).maxRequestBytes;
  let wireBytes = Buffer.byteLength(JSON.stringify(body));
  if (wireBytes > limit) throw new ProviderContractError('FILE_REQUEST_TOO_LARGE');
  const copy = structuredClone(body);
  const visit = async (value: Json): Promise<void> => {
    signal?.throwIfAborted();
    if (Array.isArray(value)) {
      for (const item of value) await visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const slot = fileSlot(value);
    const reference = slot?.owner[slot.key];
    if (slot && typeof reference === 'string' && reference.startsWith('uimori-file://')) {
      const file = allowed.get(reference);
      if (!file || !options.resolveFile) throw new ProviderContractError('FILE_INPUT_UNAVAILABLE');
      let data = resolved.get(reference);
      if (!data) {
        data = await options.resolveFile(file, signal);
        signal?.throwIfAborted();
        if (
          data.mime !== file.mime ||
          typeof data.base64 !== 'string' ||
          data.base64.length !== 4 * Math.ceil(file.bytes / 3)
        )
          throw new ProviderContractError('FILE_INPUT_INVALID');
        const bytes = Buffer.from(data.base64, 'base64');
        if (
          bytes.length !== file.bytes ||
          bytes.toString('base64') !== data.base64 ||
          createHash('sha256').update(bytes).digest('hex') !== file.hash
        )
          throw new ProviderContractError('FILE_INPUT_INVALID');
        resolved.set(reference, data);
      }
      let payload: string;
      if (slot.text) {
        if (file.kind !== 'text') throw new ProviderContractError('FILE_INPUT_INVALID');
        try {
          payload = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.from(data.base64, 'base64')
          );
        } catch {
          throw new ProviderContractError('FILE_INPUT_INVALID');
        }
      } else payload = slot.url ? `data:${data.mime};base64,${data.base64}` : data.base64;
      wireBytes += payload.length - reference.length;
      if (wireBytes > limit) throw new ProviderContractError('FILE_REQUEST_TOO_LARGE');
      slot.owner[slot.key] = payload;
      return;
    }
    // Native tool results and ordinary reference JSON never grant attachment authority.
    // Only message arrays and their typed content/parts are traversed.
    for (const key of ['input', 'messages', 'contents', 'content', 'parts']) {
      const item = value[key];
      if (Array.isArray(item) && value.type !== 'tool_result') await visit(item);
    }
  };
  await visit(copy);
  if (Buffer.byteLength(JSON.stringify(copy)) > limit)
    throw new ProviderContractError('FILE_REQUEST_TOO_LARGE');
  return copy;
}
