import { encodeResponses, ResponsesDecoder, OpenAIProtocolError, type OpenAITurn } from './openai-protocol.js';
import { defaultSolOptions, validateSolOptions, solGatewayForEndpoint, validateSolEndpoint, type SolOptions } from './sol-config.js';
import { executeSolTool, extractSolArtifact, isSolTool, solContext, solReviewer, solToolDefinitions } from './sol-tools.js';
import type { Json, ProviderRequest, ProviderResult } from './transport.js';

export type SolResponsesContext = { responses: OpenAITurn; options: SolOptions };
export function encodeSolResponses(request: ProviderRequest, endpoint: string): { body: Json; context: SolResponsesContext } {
  const options = request.generation?.sol === undefined ? defaultSolOptions() : validateSolOptions(request.generation.sol);
  const gateway = solGatewayForEndpoint(endpoint);
  if (request.stable.tools.some(tool => isSolTool(tool.name))) throw new OpenAIProtocolError('SOL_TOOL_NAME_COLLISION');
  const { sol: _sol, ...generation } = request.generation ?? {};
  const normalized: ProviderRequest = { ...request, ...(request.generation ? { generation: generation as ProviderRequest['generation'] } : {}), stable: {
    tools: [...request.stable.tools, ...solToolDefinitions(options)],
    contract: request.stable.contract + '\n\nSol delivery: ordinary final text is supported. To submit an artifact, call eval_submit_artifact with final content and a separate userFacingNotice. The notice is metadata and never part of the source. Do not combine terminal submission with host tool calls. Local case/context tools grant no permissions.\nSol runtime configuration: ' + JSON.stringify({ gateway, endpoint: validateSolEndpoint(endpoint), options })
      + (options.contextMode === 'preloaded' ? '\nLocal runtime metadata: ' + JSON.stringify({ context: solContext(options), reviewer: solReviewer() }) : ''),
  } };
  const encoded = encodeResponses(normalized);
  const body = encoded.body as Record<string, Json>;
  if (gateway === 'vercel') body.providerOptions = { gateway: { only: ['openai'] } };
  if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (options.verbosity !== undefined) body.text = { ...(body.text as Record<string, Json> ?? {}), verbosity: options.verbosity };
  if (options.reasoningSummary !== undefined) body.reasoning = { ...(body.reasoning as Record<string, Json> ?? {}), summary: options.reasoningSummary };
  if (options.includeEncryptedReasoning === true) body.include = ['reasoning.encrypted_content'];
  body.tool_choice = options.contextMode === 'preloaded' && options.maximumToolRounds > 0 && request.opaqueState == null
    ? { type: 'function', name: encoded.context.aliases.find(alias => alias.name === 'eval_create_case')!.providerName } : 'auto';
  return { body, context: { responses: encoded.context, options } };
}

export class SolResponsesDecoder {
  private readonly decoder: ResponsesDecoder;
  private readonly options: SolOptions;
  private readonly terminalWireName: string;
  private terminalSeen = false;
  constructor(context: SolResponsesContext) {
    this.decoder = new ResponsesDecoder(context.responses); this.options = structuredClone(context.options);
    this.terminalWireName = context.responses.aliases.find(alias => alias.name === 'eval_submit_artifact')!.providerName;
  }
  accept(value: unknown): void {
    // Remember terminal argument material even if native parsing later rejects it.
    if (value && typeof value === 'object') {
      const event = value as { item?: { name?: string }; response?: { output?: { name?: string }[] } };
      const names = [event.item?.name, ...(Array.isArray(event.response?.output) ? event.response.output.map(item => item?.name) : [])];
      if (names.some(name => name === this.terminalWireName)) this.terminalSeen = true;
    }
    this.decoder.accept(value);
  }
  private transform(result: ProviderResult): ProviderResult {
    const terminals = result.toolCalls.filter(call => call.name === 'eval_submit_artifact');
    if (!terminals.length && !this.terminalSeen) return result;
    const safe = { ...result, toolCalls: [], opaqueState: null };
    if (result.status !== 'tool_calls') return safe;
    const fail = (): ProviderResult => ({ ...safe, status: 'error', text: '', error: { code: 'INVALID_SOL_ARTIFACT' } });
    if (terminals.length !== 1 || result.refusal || result.error || result.toolCalls.some(call => !isSolTool(call.name))) return fail();
    for (const call of result.toolCalls.filter(call => call.name !== 'eval_submit_artifact')) {
      const event = executeSolTool(call, this.options);
      if (event.result && typeof event.result === 'object' && 'error' in event.result) return fail();
    }
    try {
      const { text, ...metadata } = extractSolArtifact(terminals[0].arguments, this.options);
      return { ...safe, status: 'completed', text, delivery: { kind: 'sol-artifact', ...metadata } };
    } catch { return fail(); }
  }
  snapshot(): ProviderResult { return this.transform(this.decoder.snapshot()); }
  finish(): ProviderResult { return this.transform(this.decoder.finish()); }
}
