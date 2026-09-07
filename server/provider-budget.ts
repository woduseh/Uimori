import type { DatabaseSync } from 'node:sqlite';
import { ProviderContractError, type WireRecord } from '../core/transport.js';
import { validateVertexEndpoint, validateProviderEndpoint, VERTEX_GEMINI_MODEL_ID, type ProviderProtocol } from '../core/product.js';

export type LiveBudgetLimits = { maxRequests: number; maxCostUsd: number };
export const VERTEX_BUDGET_PRICE_REVISION = 'gemini-3.8-flash-global-standard-gross-2026-09-02-v1';
export const VERTEX_FLEX_PRICE_REVISION = 'gemini-3.8-flash-global-flex-gross-2026-09-07-v1';
export const VERTEX_BUDGET_PRICE_SOURCE = 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing';
// Global Standard text: $1.50/M input and $7.50/M output before promotional credits.
// Reserve the entire model envelope, including thinking, regardless of per-request options.
const MAX_INPUT_TOKENS = 1_048_576;
const MAX_OUTPUT_TOKENS = 65_536;
const INPUT_NANO_USD = 1_500n;
const OUTPUT_NANO_USD = 7_500n;
const RESERVATION_NANO_USD = BigInt(MAX_INPUT_TOKENS) * INPUT_NANO_USD + BigInt(MAX_OUTPUT_TOKENS) * OUTPUT_NANO_USD;
export const VERTEX_BUDGET_RESERVATION_USD = Number(RESERVATION_NANO_USD) / 1e9;
const PRICE_START = Date.parse('2026-09-02T00:00:00Z');
const PRICE_END = Date.parse('2027-01-01T00:00:00Z');
const reject = (code: string): never => { throw new ProviderContractError(code); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function validateLiveBudgetLimits(limits: LiveBudgetLimits | undefined): void {
  if (limits !== undefined && (!Number.isSafeInteger(limits.maxRequests) || limits.maxRequests <= 0 ||
    typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0)) {
    reject('INVALID_LIVE_BUDGET');
  }
}

export function parseLiveBudgetLimits(env: NodeJS.ProcessEnv): LiveBudgetLimits | undefined {
  if (env.NR_LIVE_MAX_REQUESTS === undefined && env.NR_LIVE_MAX_USD === undefined) return undefined;
  const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
  if (env.NR_LIVE_MAX_REQUESTS === undefined || env.NR_LIVE_MAX_USD === undefined ||
    !decimal.test(env.NR_LIVE_MAX_REQUESTS) || !decimal.test(env.NR_LIVE_MAX_USD)) reject('INVALID_LIVE_BUDGET');
  const limits = { maxRequests: Number(env.NR_LIVE_MAX_REQUESTS), maxCostUsd: Number(env.NR_LIVE_MAX_USD) };
  validateLiveBudgetLimits(limits);
  return limits;
}

/** Round the configured positive decimal ceiling down to nanodollars, without float multiplication. */
function nanoUsd(value: number): bigint {
  const [coefficient, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient!.split('.');
  const digits = BigInt(whole! + fraction);
  const shift = 9 + Number(exponent) - fraction.length;
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

function requestScope(wire: Record<string, unknown>): boolean {
  if (wire.modelId !== VERTEX_GEMINI_MODEL_ID || wire.method !== 'POST' || typeof wire.url !== 'string') return false;
  const suffix = `/${VERTEX_GEMINI_MODEL_ID}:streamGenerateContent?alt=sse`;
  if (!wire.url.endsWith(suffix)) return false;
  try { validateVertexEndpoint(wire.url.slice(0, -suffix.length)); return true; } catch { return false; }
}

function flexRequested(wire: Record<string, unknown>): boolean {
  const headers = wire.headers;
  return object(headers) && headers['x-vertex-ai-llm-request-type'] === 'shared' && headers['x-vertex-ai-llm-shared-request-type'] === 'flex';
}
/** Non-Vertex connections are user-operated; their model prices are not supplied by this Vertex test budget. */
function externalProviderScope(wire: Record<string, unknown>): boolean {
  const protocol = wire.protocol;
  if (protocol === 'codex-app-server-v1') return wire.method === 'RPC' && wire.url === 'codex://local' &&
    typeof wire.connectionId === 'string' && !!wire.connectionId && typeof wire.modelId === 'string' && !!wire.modelId &&
    ['main', 'translation', 'status', 'image', 'state', 'memory'].includes(String(wire.role)) &&
    object(wire.headers) && Object.keys(wire.headers).length === 0 && object(wire.body) &&
    wire.body.method === 'turn/start' && wire.body.role === wire.role && wire.body.model === wire.modelId;
  if (!['openai-responses-v1', 'anthropic-messages-v1', 'vercel-chat-v1', 'openai-chat-v1'].includes(String(protocol)) || wire.method !== 'POST' || typeof wire.modelId !== 'string' || !wire.modelId || typeof wire.url !== 'string') return false;
  const suffix = protocol === 'openai-responses-v1' ? '/responses' : protocol === 'anthropic-messages-v1' ? '/messages' : '/chat/completions';
  if (!wire.url.endsWith(suffix)) return false;
  try { validateProviderEndpoint(protocol as ProviderProtocol, wire.url.slice(0, -suffix.length)); return true; } catch { return false; }
}

type AttemptRow = { request: string; status: string; connection_id: string; model_id: string; input_tokens: number | null; output_tokens: number | null; raw_usage: string | null; error: string | null };
function reservedCost(row: AttemptRow, request: Record<string, unknown>): bigint {
  const reservation = request.budgetReservation;
  // Legacy or unrecognized reservation metadata never grants a release.
  if (reservation !== undefined && (!object(reservation) || reservation.maxCostUsd !== VERTEX_BUDGET_RESERVATION_USD || !([VERTEX_BUDGET_PRICE_REVISION, VERTEX_FLEX_PRICE_REVISION] as unknown[]).includes(reservation.priceRevision))) {
    return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
  }
  if (!reservation || !['completed', 'tool_calls', 'refused'].includes(row.status) || row.error !== null ||
    !tokenCount(row.input_tokens) || !tokenCount(row.output_tokens) || row.input_tokens > MAX_INPUT_TOKENS || row.output_tokens > MAX_OUTPUT_TOKENS || row.raw_usage === null) return RESERVATION_NANO_USD;
  let raw: unknown;
  try { raw = JSON.parse(row.raw_usage); } catch { return RESERVATION_NANO_USD; }
  if (!object(raw) || !tokenCount(raw.promptTokenCount) || !tokenCount(raw.candidatesTokenCount) || !tokenCount(raw.thoughtsTokenCount) ||
    !tokenCount(raw.totalTokenCount) || raw.promptTokenCount !== row.input_tokens ||
    raw.candidatesTokenCount + raw.thoughtsTokenCount !== row.output_tokens || raw.totalTokenCount !== row.input_tokens + row.output_tokens ||
    (raw.cachedContentTokenCount !== undefined && (!tokenCount(raw.cachedContentTokenCount) || raw.cachedContentTokenCount > row.input_tokens)) ||
    (raw.toolUsePromptTokenCount !== undefined && raw.toolUsePromptTokenCount !== 0)) return RESERVATION_NANO_USD;
  const flex = reservation.priceRevision === VERTEX_FLEX_PRICE_REVISION && flexRequested(request);
  if (reservation.priceRevision === VERTEX_FLEX_PRICE_REVISION && (!flex || raw.trafficType !== 'ON_DEMAND_FLEX')) return RESERVATION_NANO_USD;
  // All input, including cached input, uses the unreduced gross rate. This is an estimate,
  // not actual billing: attempts.cost_usd and provider usage are never rewritten here.
  return (BigInt(row.input_tokens) * INPUT_NANO_USD + BigInt(row.output_tokens) * OUTPUT_NANO_USD) / (flex ? 2n : 1n);
}

/** DB-lifetime Vertex test admission shared by every Vertex role, candidate and retry. No provider I/O in the transaction. */
export class ProviderBudget {
  private readonly limits: LiveBudgetLimits | undefined;
  constructor(private readonly db: DatabaseSync, limits?: LiveBudgetLimits, private readonly now: () => Date = () => new Date()) {
    validateLiveBudgetLimits(limits);
    this.limits = limits && { ...limits };
  }

  private ledger() {
      let requests = 0; let reserved = 0n; let fullReservationCount = 0;
      const registrationRows:AttemptRow[]=[];
      const entries=this.db.prepare("SELECT body FROM versions v WHERE kind='registration-run' AND revision=(SELECT MAX(revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id)").all() as {body:string}[];
      for(const entry of entries) {
        let run:unknown;try{run=JSON.parse(entry.body);}catch{return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');}
        if(!object(run)||!Array.isArray(run.attempts))return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
        for(const value of run.attempts){if(!object(value)||!object(value.request))return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');const usage=object(value.usage)?value.usage:null;
          registrationRows.push({request:JSON.stringify(value.request),status:String(value.status),connection_id:String(value.request.connectionId),model_id:String(value.request.modelId),input_tokens:usage?.inputTokens as number|null??null,output_tokens:usage?.outputTokens as number|null??null,raw_usage:null,error:value.error as string|null});}
      }
      for (const row of [...this.db.prepare('SELECT request,status,connection_id,model_id,input_tokens,output_tokens,raw_usage,error FROM attempts').all() as AttemptRow[],...registrationRows]) {
        let request: unknown;
        try { request = JSON.parse(row.request); } catch { return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE'); }
        if (!object(request)) return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
        if (request.mock === true && request.protocol === undefined && request.budgetReservation === undefined &&
          row.status === 'mock' && row.connection_id === 'local-scripted' && row.model_id === 'deterministic-fixture') continue;
        if (request.mock !== undefined || request.connectionId !== row.connection_id || request.modelId !== row.model_id) return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
        if (request.protocol === 'fixture-sse-v1') {
          let url: URL;
          try { url = new URL(String(request.url)); } catch { return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE'); }
          if (row.status === 'mock' || request.method !== 'POST' || request.budgetReservation !== undefined || url.protocol !== 'http:' ||
            !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
          continue;
        }
        if (request.externalBilling === 'not-estimated' && request.budgetReservation === undefined && externalProviderScope(request)) continue;
        if (request.protocol !== 'vertex-gemini-v1' || row.model_id !== VERTEX_GEMINI_MODEL_ID || !requestScope(request)) return reject('LIVE_BUDGET_HISTORY_UNVERIFIABLE');
        requests++; const cost = reservedCost(row, request); reserved += cost; if (cost === RESERVATION_NANO_USD) fullReservationCount++;
      }
      return { requests, reserved, fullReservationCount };
  }

  /** Advisory only: start() repeats the same ledger read under the admission write lock. */
  snapshot() {
    const { requests, reserved, fullReservationCount } = this.ledger();
    const time = this.now().getTime();
    const blockedReason = !this.limits ? 'LIVE_BUDGET_NOT_CONFIGURED'
      : !Number.isFinite(time) || time < PRICE_START || time >= PRICE_END ? 'LIVE_PRICE_REVERIFY_REQUIRED'
      : requests >= this.limits.maxRequests ? 'LIVE_REQUEST_BUDGET_EXHAUSTED'
      : reserved + RESERVATION_NANO_USD > nanoUsd(this.limits.maxCostUsd) ? 'LIVE_COST_BUDGET_EXHAUSTED' : null;
    return {
      scope: 'vertex-gemini-3.8-flash-tests', flexPriceRevision: VERTEX_FLEX_PRICE_REVISION,
      requestCount: requests, maxRequests: this.limits?.maxRequests ?? null, maxCostUsd: this.limits?.maxCostUsd ?? null,
      accountedCostUsd: Number(reserved) / 1e9, fullReservationCount,
      fullReservationCostUsd: Number(BigInt(fullReservationCount) * RESERVATION_NANO_USD) / 1e9,
      usageAdjustedCount: requests - fullReservationCount,
      usageAdjustedEstimateUsd: Number(reserved - BigInt(fullReservationCount) * RESERVATION_NANO_USD) / 1e9,
      perRequestReservationUsd: VERTEX_BUDGET_RESERVATION_USD, priceRevision: VERTEX_BUDGET_PRICE_REVISION,
      priceExpiresAt: new Date(PRICE_END).toISOString(), nextRequestAdmissible: blockedReason === null, blockedReason,
    };
  }
  start(wire: WireRecord, persist: (admitted: WireRecord) => string): string {
    if (wire.protocol === 'fixture-sse-v1') return persist(wire);
    if (externalProviderScope(wire)) return persist({ ...wire, externalBilling: 'not-estimated' } as WireRecord);
    if (!this.limits) return reject('LIVE_BUDGET_NOT_CONFIGURED');
    const time = this.now().getTime();
    if (!Number.isFinite(time) || time < PRICE_START || time >= PRICE_END) return reject('LIVE_PRICE_REVERIFY_REQUIRED');
    if (wire.protocol !== 'vertex-gemini-v1' || !requestScope(wire)) return reject('LIVE_PRICE_SCOPE_UNSUPPORTED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { requests, reserved } = this.ledger();
      if (requests >= this.limits.maxRequests) return reject('LIVE_REQUEST_BUDGET_EXHAUSTED');
      if (reserved + RESERVATION_NANO_USD > nanoUsd(this.limits.maxCostUsd)) return reject('LIVE_COST_BUDGET_EXHAUSTED');
      const admitted = { ...wire, budgetReservation: { maxCostUsd: VERTEX_BUDGET_RESERVATION_USD, priceRevision: flexRequested(wire) ? VERTEX_FLEX_PRICE_REVISION : VERTEX_BUDGET_PRICE_REVISION,
        basis: 'gross-published-rate-upper-bound', source: VERTEX_BUDGET_PRICE_SOURCE, reservedAt: new Date(time).toISOString() } };
      const id = persist(admitted);
      if (typeof id !== 'string' || !id) return reject('LIVE_ATTEMPT_PERSISTENCE_FAILED');
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
