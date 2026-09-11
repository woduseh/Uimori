import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { CodexRuntimeStatus } from '../core/agent-runtime.js';
import type { Connection, ModelGeneration } from '../core/product.js';
import {
  detectImageMime,
  ILLUSTRATION_MAX_IMAGE_BYTES,
  isValidIllustrationImage,
  type IllustrationImageMime,
} from '../core/illustration.js';
import {
  buildCodexDescriptor,
  buildCodexTurn,
  CODEX_BUILTIN_TOOLS,
  CODEX_ENDPOINT,
  decodeCodexOutput,
} from '../core/codex-protocol.js';
import { assertContextBudget } from '../core/context-budget.js';
import {
  ProviderContractError,
  type Json,
  type ProviderConnection,
  type ProviderExecutionOptions,
  type ProviderRequest,
  type ProviderResult,
  type ProviderRole,
  type ProviderUsage,
} from '../core/transport.js';
import { CodexProcess, CodexProcessError } from './codex-process.js';

const runFile = promisify(execFile);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const boundedString = (v: unknown, max = 300): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= max;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Bound allocation before decoding; Buffer.from alone silently accepts malformed base64. */
function decodeIllustrationBase64(value: unknown): Buffer | undefined {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 4 * Math.ceil(ILLUSTRATION_MAX_IMAGE_BYTES / 3) ||
    value.length % 4 !== 0
  )
    return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= ILLUSTRATION_MAX_IMAGE_BYTES && bytes.toString('base64') === value
    ? bytes
    : undefined;
}
const error = (code: string): never => {
  throw new ProviderContractError(code);
};
const safeError = (value: unknown) =>
  value instanceof CodexProcessError || value instanceof ProviderContractError
    ? value.message
    : 'CODEX_UNAVAILABLE';
const emptyUsage = (): ProviderUsage => ({
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  raw: { kind: 'codex-agent-turn', modelCalls: null },
  priceRevision: null,
});
const failure = (code: string, usage = emptyUsage()): ProviderResult => ({
  status: code === 'CANCELLED' ? 'cancelled' : 'error',
  text: '',
  toolCalls: [],
  refusal: null,
  error: { code },
  usage,
  opaqueState: null,
});

export type CodexRuntimeOptions = {
  enabled?: boolean;
  executable?: string;
  maxConcurrent?: number;
  /** Host-side test injection only; never accepted in an API request or archive. */
  launch?: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
};
export type CodexExecutionOptions = ProviderExecutionOptions & { beforeTurn?: () => void };
/** One illustration turn: the official image generation tool renders, Uimori stores the bytes. */
export type CodexImageRequest = {
  modelId: string;
  reasoningEffort?: ModelGeneration['reasoningEffort'];
  developerInstructions: string;
  text: string;
  outputSchema: Json;
  references: { mime: string; base64: string }[];
};
export type CodexImageResult = {
  status: 'completed' | 'error' | 'cancelled';
  images: { mime: IllustrationImageMime; bytes: Buffer }[];
  revisedPrompt: string | null;
  /** Final agent message text; the caller parses the caption envelope. */
  text: string;
  usage: ProviderUsage;
  error: { code: string; usageLimit?: { limitId: string; resetsAt: number | null } } | null;
};
export interface CodexRuntimeService {
  status(): Promise<CodexRuntimeStatus>;
  login(): Promise<CodexRuntimeStatus>;
  cancelLogin(): Promise<CodexRuntimeStatus>;
  logout(): Promise<CodexRuntimeStatus>;
  catalog(): Promise<Connection['catalog']>;
  execute(
    connection: ProviderConnection,
    request: ProviderRequest,
    options: CodexExecutionOptions
  ): Promise<ProviderResult>;
  generateImage(
    connection: ProviderConnection,
    request: CodexImageRequest,
    options: CodexExecutionOptions
  ): Promise<CodexImageResult>;
  close(): Promise<void>;
}
type TurnPlan = {
  role: ProviderRole;
  modelId: string;
  effort?: string;
  developerInstructions: string;
  input: Json[];
  outputSchema: Json;
  /** Attempt record body; never carries attachment bytes or image results. */
  descriptor: Json;
  stablePrefix: string;
  config: Record<string, unknown>;
  maxLineBytes?: number;
  allowedItems: readonly string[];
  onItem?: (item: Record<string, unknown>, method: 'item/started' | 'item/completed') => void;
};
type TurnOutcome =
  | { ok: true; output: string; usage: ProviderUsage }
  | { ok: false; code: string; usage: ProviderUsage };
/** Bounded concurrent processes with a bounded, cancellable wait queue. */
class Slots {
  occupied = 0;
  private waiters: { resolve(): void; reject(error: Error): void; cleanup(): void }[] = [];
  constructor(
    readonly limit: number,
    private readonly maxWaiting: number
  ) {}
  async acquire(signal: AbortSignal, closed: boolean): Promise<void> {
    if (signal.aborted) error('CANCELLED');
    if (closed) error('CODEX_CLOSED');
    if (this.occupied < this.limit) {
      this.occupied++;
      return;
    }
    if (this.waiters.length >= this.maxWaiting) error('CODEX_BUSY');
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.cleanup();
        reject(new ProviderContractError('CANCELLED'));
      };
      const waiter = {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', aborted),
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  release(): void {
    this.occupied--;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup();
      this.occupied++;
      waiter.resolve();
    }
  }
  rejectWaiting(code: string): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(new ProviderContractError(code));
    }
  }
}

/** The command comes from server configuration, never a browser, model or saved connection. */
export function codexExecutable(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (explicit && (!isAbsolute(explicit) || /\.(?:cmd|bat|ps1)$/i.test(explicit)))
    error('CODEX_EXECUTABLE_INVALID');
  const platform = process.platform,
    arch = process.arch;
  const triple =
    platform === 'win32'
      ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
      : platform === 'darwin'
        ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
        : `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
  const native = (packageRoot: string) =>
    join(
      packageRoot,
      'node_modules',
      '@openai',
      `codex-${platform === 'win32' ? 'win32' : platform}-${arch}`,
      'vendor',
      triple,
      'bin',
      platform === 'win32' ? 'codex.exe' : 'codex'
    );
  const candidates = explicit
    ? [explicit]
    : [
        ...(env.PATH ?? env.Path ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((folder) => join(folder, platform === 'win32' ? 'codex.exe' : 'codex')),
        ...(platform === 'win32' && env.APPDATA
          ? [native(join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'))]
          : []),
      ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const file = realpathSync(candidate);
    if (extname(file) === '.js') {
      const binary = native(dirname(dirname(file)));
      if (existsSync(binary)) return realpathSync(binary);
      if (explicit) error('CODEX_EXECUTABLE_INVALID');
      continue;
    }
    return file;
  }
  return undefined;
}

/** No provider/API keys or existing Codex auth/config are inherited by the agent. */
export function codexEnvironment(
  home: string,
  work: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'LANG',
    'LC_ALL',
  ])
    if (env[name]) result[name] = env[name];
  return {
    ...result,
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'appdata'),
    LOCALAPPDATA: join(home, 'localappdata'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: work,
    TMP: work,
    TEMP: work,
  };
}

// Native search and isolated JavaScript can assist a decision. Environment tools
// remain unavailable: read-only alone would also expose host files and auth.json.
// CLI 0.153+ supports environments:[] to enforce that boundary independently of prompts.
export const CODEX_RUNTIME_CONFIG = {
  forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file',
  approval_policy: 'never',
  approvals_reviewer: 'user',
  sandbox_mode: 'read-only',
  web_search: CODEX_BUILTIN_TOOLS.webSearch,
  project_doc_max_bytes: 0,
  check_for_update_on_startup: false,
  'analytics.enabled': false,
  'apps._default.enabled': false,
  'features.apps': false,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.code_mode': CODEX_BUILTIN_TOOLS.codeMode,
  'features.code_mode_only': false,
  'features.js_repl': false,
  'features.view_image': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.collab': false,
  'features.codex_hooks': false,
  'features.memory_tool': false,
  'features.skills': false,
  'features.search_tool': false,
  'features.workspace_dependencies': false,
  'features.request_permissions': false,
  'features.request_permissions_tool': false,
  'features.unbounded_connection_retries': false,
  'features.image_generation': false,
} as const;
/** Illustration turns add image generation while retaining the same native utility tools. */
export const CODEX_ILLUSTRATION_CONFIG = {
  ...CODEX_RUNTIME_CONFIG,
  'features.image_generation': true,
} as const;
const ILLUSTRATION_LINE_BYTES = 64 * 1024 * 1024;
const TEXT_ITEMS = [
  'userMessage',
  'agentMessage',
  'reasoning',
  'webSearch',
  'functionCallOutput',
  'plan',
  'sleep',
  'contextCompaction',
] as const;

/** Owns one Uimori-specific login and isolated, disposable agent turns. */
export class CodexRuntime implements CodexRuntimeService {
  private readonly home: string;
  private work?: string;
  private manager?: CodexProcess;
  private managerStart?: Promise<CodexProcess>;
  private installation?: Promise<{ command: string; args: string[] }>;
  private active = new Set<CodexProcess>();
  private readonly textSlots: Slots;
  private readonly imageSlots = new Slots(1, 8);
  private closed = false;
  private closing?: Promise<void>;
  private revision = 0;
  private loginValue: CodexRuntimeStatus['login'] = null;
  private loginError: string | null = null;
  private authAction?: Promise<CodexRuntimeStatus>;
  private limitValue: CodexRuntimeStatus['limits'] = [];
  private limitsAt = 0;
  constructor(
    dbPath: string,
    private readonly options: CodexRuntimeOptions = {}
  ) {
    this.home = resolve(dbPath) + '.codex';
    if (
      options.maxConcurrent !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrent) ||
        options.maxConcurrent < 1 ||
        options.maxConcurrent > 8)
    )
      error('CODEX_INVALID_CONCURRENCY');
    this.textSlots = new Slots(options.maxConcurrent ?? 2, 32);
  }
  private get occupied(): number {
    return this.textSlots.occupied + this.imageSlots.occupied;
  }
  private rejectWaiting(code: string): void {
    this.textSlots.rejectWaiting(code);
    this.imageSlots.rejectWaiting(code);
  }

  private async launch(): Promise<{ command: string; args: string[] }> {
    if (this.closed) error('CODEX_CLOSED');
    if (!this.options.enabled) error('CODEX_DISABLED');
    if (!this.installation)
      this.installation = (async () => {
        const command = this.options.launch?.command ?? codexExecutable(this.options.executable);
        if (!command) error('CODEX_NOT_INSTALLED');
        const args = this.options.launch?.args ?? [];
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
        this.work ??= mkdtempSync(join(tmpdir(), 'uimori-codex-'));
        const env = { ...codexEnvironment(this.home, this.work), ...this.options.launch?.env };
        let version: string;
        try {
          version = (
            await runFile(command!, [...args, '--version'], {
              env,
              cwd: this.work,
              windowsHide: true,
              timeout: 5000,
              maxBuffer: 4096,
            })
          ).stdout.trim();
        } catch {
          return error('CODEX_NOT_INSTALLED');
        }
        const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
        if (!match || (Number(match[1]) === 0 && Number(match[2]) < 153))
          error('CODEX_VERSION_UNSUPPORTED');
        return { command: command!, args };
      })().catch((caught) => {
        this.installation = undefined;
        throw caught;
      });
    return this.installation;
  }
  private async process(
    config: Record<string, unknown> = CODEX_RUNTIME_CONFIG,
    maxLineBytes?: number
  ): Promise<CodexProcess> {
    const launch = await this.launch();
    if (this.closed) error('CODEX_CLOSED');
    const args = [
      ...launch.args,
      'app-server',
      '--listen',
      'stdio://',
      ...Object.entries(config).flatMap(([key, value]) => [
        '-c',
        `${key}=${JSON.stringify(value)}`,
      ]),
    ];
    return new CodexProcess({
      command: launch.command,
      args,
      cwd: this.work!,
      env: { ...codexEnvironment(this.home, this.work!), ...this.options.launch?.env },
      timeoutMs: 15_000,
      experimentalApi: true,
      ...(maxLineBytes ? { maxLineBytes } : {}),
    });
  }
  private async control(): Promise<CodexProcess> {
    if (this.managerStart) return this.managerStart;
    if (this.manager) return this.manager;
    return (this.managerStart ??= (async () => {
      const process = await this.process();
      if (this.closed) {
        await process.close();
        return error('CODEX_CLOSED');
      }
      process.onExit(() => {
        if (this.manager === process) {
          this.manager = undefined;
          this.managerStart = undefined;
          this.loginValue = null;
          this.revision++;
        }
      });
      process.onNotification((method, value) => {
        if (
          method === 'account/login/completed' &&
          object(value) &&
          value.loginId === this.loginValue?.id
        ) {
          this.loginValue = null;
          this.loginError = value.success === true ? null : 'CODEX_LOGIN_FAILED';
          this.revision++;
          this.limitsAt = 0;
        }
      });
      this.manager = process;
      try {
        await process.start();
      } catch (caught) {
        await process.close();
        if (this.manager === process) this.manager = undefined;
        throw caught;
      }
      return process;
    })().catch((caught) => {
      this.managerStart = undefined;
      throw caught;
    }));
  }
  private async account(
    process: CodexProcess,
    signal?: AbortSignal
  ): Promise<{ type: 'chatgpt' | 'apikey' | null; plan: string | null }> {
    const response = await process.request<unknown>(
      'account/read',
      { refreshToken: false },
      { signal }
    );
    if (!object(response)) error('CODEX_INVALID_ACCOUNT');
    const account = (response as Record<string, unknown>).account;
    if (account === null) return { type: null, plan: null };
    if (!object(account)) error('CODEX_INVALID_ACCOUNT');
    const row = account as Record<string, unknown>;
    return {
      type: row.type === 'chatgpt' ? 'chatgpt' : row.type === 'apiKey' ? 'apikey' : null,
      plan: boundedString(row.planType, 80) ? row.planType : null,
    };
  }
  async status(): Promise<CodexRuntimeStatus> {
    const base: CodexRuntimeStatus = {
      available: false,
      authenticated: false,
      authMode: null,
      error: null,
      login: null,
      planType: null,
      limits: [],
    };
    try {
      const process = await this.control(),
        account = await this.account(process);
      if (account.type === 'chatgpt' && Date.now() - this.limitsAt > 30_000) {
        try {
          this.limitValue = parseRateLimits(await process.request('account/rateLimits/read', {}));
          this.limitsAt = Date.now();
        } catch {
          this.limitValue = [];
        }
      }
      return {
        available: true,
        authenticated: account.type === 'chatgpt',
        authMode: account.type,
        error: account.type === 'apikey' ? 'CODEX_SUBSCRIPTION_REQUIRED' : this.loginError,
        login: this.loginValue ? { ...this.loginValue } : null,
        planType: account.plan,
        limits: account.type === 'chatgpt' ? structuredClone(this.limitValue) : [],
      };
    } catch (caught) {
      return { ...base, error: safeError(caught) };
    }
  }
  private auth(work: () => Promise<CodexRuntimeStatus>): Promise<CodexRuntimeStatus> {
    if (this.authAction) return Promise.reject(new ProviderContractError('CODEX_AUTH_BUSY'));
    const pending = work().finally(() => {
      if (this.authAction === pending) this.authAction = undefined;
    });
    this.authAction = pending;
    return pending;
  }
  login(): Promise<CodexRuntimeStatus> {
    return this.auth(async () => {
      if (this.occupied) error('CODEX_BUSY');
      const process = await this.control();
      if (this.loginValue) return this.status();
      const current = await this.account(process);
      if (current.type === 'chatgpt') return this.status();
      if (current.type === 'apikey') error('CODEX_SUBSCRIPTION_REQUIRED');
      this.revision++;
      this.loginError = null;
      const value = await process.request<unknown>('account/login/start', {
        type: 'chatgptDeviceCode',
      });
      if (
        !object(value) ||
        value.type !== 'chatgptDeviceCode' ||
        !boundedString(value.loginId) ||
        !boundedString(value.userCode, 100) ||
        typeof value.verificationUrl !== 'string'
      )
        error('CODEX_INVALID_LOGIN');
      const item = value as { loginId: string; userCode: string; verificationUrl: string };
      const url = new URL(item.verificationUrl);
      if (
        url.origin !== 'https://auth.openai.com' ||
        url.pathname !== '/codex/device' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        error('CODEX_INVALID_LOGIN');
      this.loginValue = { id: item.loginId, verificationUrl: url.href, userCode: item.userCode };
      return this.status();
    });
  }
  cancelLogin(): Promise<CodexRuntimeStatus> {
    return this.auth(async () => {
      const process = await this.control();
      if (this.loginValue)
        await process.request('account/login/cancel', { loginId: this.loginValue.id });
      this.loginValue = null;
      this.loginError = null;
      this.revision++;
      return this.status();
    });
  }
  logout(): Promise<CodexRuntimeStatus> {
    return this.auth(async () => {
      this.revision++;
      this.loginValue = null;
      this.limitValue = [];
      this.limitsAt = 0;
      this.rejectWaiting('CODEX_AUTH_CHANGED');
      await Promise.allSettled([...this.active].map((process) => process.close()));
      const process = await this.control();
      await process.request('account/logout', {});
      this.loginError = null;
      return this.status();
    });
  }
  async catalog(): Promise<Connection['catalog']> {
    const process = await this.control(),
      revision = this.revision;
    if ((await this.account(process)).type !== 'chatgpt') error('CODEX_LOGIN_REQUIRED');
    const models: Connection['catalog'] = [],
      ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const value = await process.request<unknown>('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (revision !== this.revision) error('CODEX_AUTH_CHANGED');
      if (!object(value) || !Array.isArray(value.data) || value.data.length > 100)
        error('CODEX_INVALID_CATALOG');
      const response = value as { data: unknown[]; nextCursor?: unknown };
      for (const raw of response.data) {
        if (!object(raw) || !boundedString(raw.model) || !boundedString(raw.displayName, 400))
          error('CODEX_INVALID_CATALOG');
        const row = raw as { model: string; displayName: string; hidden?: boolean };
        if (row.hidden || ids.has(row.model)) continue;
        ids.add(row.model);
        models.push({
          id: row.model,
          name: row.displayName,
          capabilities: { tools: null, structuredOutput: null },
          priceRevision: null,
        });
      }
      if (response.nextCursor === null || response.nextCursor === undefined) return models;
      if (!boundedString(response.nextCursor, 2000) || response.nextCursor === cursor)
        error('CODEX_INVALID_CATALOG');
      cursor = response.nextCursor as string;
    }
    return error('CODEX_INVALID_CATALOG');
  }
  async execute(
    connection: ProviderConnection,
    request: ProviderRequest,
    options: CodexExecutionOptions
  ): Promise<ProviderResult> {
    if (options.signal.aborted) return failure('CANCELLED');
    if (this.authAction || this.loginValue) return failure('CODEX_BUSY');
    let plan: TurnPlan;
    try {
      assertCodexConnection(connection);
      const built = buildCodexTurn(request);
      const descriptor = buildCodexDescriptor(request, built);
      assertContextBudget(descriptor, request.contextBudget);
      plan = {
        role: request.role,
        modelId: request.modelId,
        effort: request.generation?.reasoningEffort,
        developerInstructions: built.developerInstructions,
        input: [{ type: 'text', text: built.inputText, text_elements: [] }],
        outputSchema: built.outputSchema,
        descriptor,
        stablePrefix: built.developerInstructions,
        config: CODEX_RUNTIME_CONFIG,
        allowedItems: TEXT_ITEMS,
      };
    } catch (caught) {
      return failure(options.signal.aborted ? 'CANCELLED' : safeError(caught));
    }
    const outcome = await this.runTurn(connection, plan, options, this.textSlots);
    if (!outcome.ok) return failure(outcome.code, outcome.usage);
    return { ...decodeCodexOutput(outcome.output, request), usage: outcome.usage };
  }
  async generateImage(
    connection: ProviderConnection,
    request: CodexImageRequest,
    options: CodexExecutionOptions
  ): Promise<CodexImageResult> {
    const result = (
      status: CodexImageResult['status'],
      usage: ProviderUsage,
      error: CodexImageResult['error'],
      partial: Partial<CodexImageResult> = {}
    ): CodexImageResult => ({
      status,
      images: [],
      revisedPrompt: null,
      text: '',
      ...partial,
      usage,
      error,
    });
    if (options.signal.aborted) return result('cancelled', emptyUsage(), { code: 'CANCELLED' });
    if (this.authAction || this.loginValue)
      return result('error', emptyUsage(), { code: 'CODEX_BUSY' });
    const generated: Record<string, unknown>[] = [];
    let plan: TurnPlan;
    try {
      assertCodexConnection(connection);
      if (!boundedString(request.modelId)) error('CODEX_INVALID_MODEL');
      if (request.references.length > 8) error('CODEX_IMAGE_TOO_MANY_REFERENCES');
      const attachments = request.references.map((reference) => {
        const bytes = decodeIllustrationBase64(reference.base64);
        if (!bytes || !isValidIllustrationImage(bytes, reference.mime))
          return error('CODEX_IMAGE_INVALID_REFERENCE');
        return {
          mime: reference.mime,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      });
      plan = {
        role: 'illustration',
        modelId: request.modelId,
        effort: request.reasoningEffort,
        developerInstructions: request.developerInstructions,
        input: [
          { type: 'text', text: request.text, text_elements: [] },
          ...request.references.map(
            (reference): Json => ({
              type: 'image',
              url: `data:${reference.mime};base64,${reference.base64}`,
            })
          ),
        ],
        outputSchema: request.outputSchema,
        descriptor: {
          method: 'turn/start',
          role: 'illustration',
          model: request.modelId,
          ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
          developerInstructions: request.developerInstructions,
          input: [{ type: 'text', text: request.text }],
          attachments,
          outputSchema: request.outputSchema,
          imageGeneration: true,
          builtinTools: CODEX_BUILTIN_TOOLS,
          environmentAccess: false,
          ephemeral: true,
        },
        stablePrefix: request.developerInstructions,
        config: CODEX_ILLUSTRATION_CONFIG,
        maxLineBytes: ILLUSTRATION_LINE_BYTES,
        allowedItems: [...TEXT_ITEMS, 'imageGeneration'],
        onItem: (item, method) => {
          if (method === 'item/completed' && item.type === 'imageGeneration') generated.push(item);
        },
      };
    } catch (caught) {
      return result('error', emptyUsage(), {
        code: options.signal.aborted ? 'CANCELLED' : safeError(caught),
      });
    }
    const outcome = await this.runTurn(connection, plan, options, this.imageSlots);
    if (!outcome.ok)
      return result(outcome.code === 'CANCELLED' ? 'cancelled' : 'error', outcome.usage, {
        code: outcome.code,
      });
    const images: CodexImageResult['images'] = [];
    let revisedPrompt: string | null = null;
    let usageLimit: NonNullable<CodexImageResult['error']>['usageLimit'];
    for (const item of generated) {
      if (object(item.failure)) {
        if (item.failure.type === 'usageLimitExceeded')
          usageLimit = {
            limitId: boundedString(item.failure.limitId, 200) ? item.failure.limitId : 'codex',
            resetsAt: integer(item.failure.resetsAt) ? item.failure.resetsAt : null,
          };
        continue;
      }
      if (boundedString(item.revisedPrompt, 20_000)) revisedPrompt = item.revisedPrompt;
      const decoded = this.decodeGeneratedImage(item);
      if (decoded) images.push(decoded);
    }
    if (!images.length)
      return result(
        'error',
        outcome.usage,
        {
          code: usageLimit ? 'CODEX_IMAGE_USAGE_LIMIT' : 'CODEX_IMAGE_NOT_GENERATED',
          ...(usageLimit ? { usageLimit } : {}),
        },
        { revisedPrompt, text: outcome.output }
      );
    return result('completed', outcome.usage, null, {
      images,
      revisedPrompt,
      text: outcome.output,
    });
  }
  /** Prefer validated inline bytes. Only accepted files inside the real Codex home are removed. */
  private decodeGeneratedImage(
    item: Record<string, unknown>
  ): CodexImageResult['images'][number] | undefined {
    if (
      typeof item.result === 'string' &&
      item.result.length <= 4 * Math.ceil(ILLUSTRATION_MAX_IMAGE_BYTES / 3) + 100
    ) {
      const data = /^data:(image\/(?:png|jpeg|webp));base64,/u.exec(item.result);
      const bytes =
        item.result.startsWith('data:') && !data
          ? undefined
          : decodeIllustrationBase64(data ? item.result.slice(data[0].length) : item.result);
      if (bytes) {
        const mime = data?.[1] ?? detectImageMime(bytes);
        if (isValidIllustrationImage(bytes, mime)) return { mime, bytes };
      }
    }
    if (typeof item.savedPath !== 'string' || !isAbsolute(item.savedPath)) return undefined;
    let descriptor: number | undefined;
    try {
      const path = realpathSync(item.savedPath);
      const inside = relative(realpathSync(this.home), path);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
      descriptor = openSync(path, 'r');
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size < 1 || before.size > ILLUSTRATION_MAX_IMAGE_BYTES)
        return undefined;
      const opened = statSync(path);
      if (realpathSync(path) !== path || opened.dev !== before.dev || opened.ino !== before.ino)
        return undefined;
      // Read through the checked descriptor and a fixed-size buffer: a growing file cannot
      // turn an accepted stat into an unbounded readFile allocation.
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) return undefined;
        offset += count;
      }
      const after = fstatSync(descriptor);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return undefined;
      const mime = detectImageMime(bytes);
      if (!isValidIllustrationImage(bytes, mime)) return undefined;
      closeSync(descriptor);
      descriptor = undefined;
      try {
        const current = statSync(path);
        if (
          realpathSync(path) === path &&
          current.dev === before.dev &&
          current.ino === before.ino &&
          current.size === before.size &&
          current.mtimeMs === before.mtimeMs
        )
          unlinkSync(path);
      } catch {
        /* A replaced, moved or locked file must not discard the validated result. */
      }
      return { mime, bytes };
    } catch {
      /* An unreadable or out-of-home result remains an image-generation failure. */
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return undefined;
  }
  private async runTurn(
    connection: ProviderConnection,
    plan: TurnPlan,
    options: CodexExecutionOptions,
    slots: Slots
  ): Promise<TurnOutcome> {
    const fail = (code: string, usage: ProviderUsage): TurnOutcome => ({ ok: false, code, usage });
    const duration = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1_800_000)
      return fail('INVALID_TIMEOUT', emptyUsage());
    const timeout = AbortSignal.timeout(duration),
      signal = AbortSignal.any([options.signal, timeout]);
    let process: CodexProcess | undefined,
      threadId: string | undefined,
      turnId: string | undefined,
      slot = false;
    let offNotification = () => {},
      offExit = () => {};
    let usage = emptyUsage(),
      output = '',
      outputItem: string | undefined,
      legacyOutput = '';
    let rejectTurn: (reason: unknown) => void = () => {};
    const aborted = () =>
      rejectTurn(new ProviderContractError(options.signal.aborted ? 'CANCELLED' : 'TIMEOUT'));
    let processStop: Promise<void> | undefined;
    const stopProcess = () =>
      (processStop ??= (async () => {
        if (process && threadId && turnId)
          await process
            .request('turn/interrupt', { threadId, turnId }, { timeoutMs: 500 })
            .catch(() => {});
        await process?.close();
      })());
    const stopOnAbort = () => {
      aborted();
      void stopProcess();
    };
    const abortCode = () =>
      options.signal.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMEOUT' : 'CODEX_AUTH_CHANGED';
    try {
      const revision = this.revision;
      await slots.acquire(signal, this.closed);
      slot = true;
      if (revision !== this.revision) error('CODEX_AUTH_CHANGED');
      process = await this.process(plan.config, plan.maxLineBytes);
      if (revision !== this.revision || this.authAction) return fail('CODEX_AUTH_CHANGED', usage);
      this.active.add(process);
      signal.addEventListener('abort', stopOnAbort, { once: true });
      if (signal.aborted) return fail(options.signal.aborted ? 'CANCELLED' : 'TIMEOUT', usage);
      await process.start();
      if ((await this.account(process, signal)).type !== 'chatgpt') error('CODEX_LOGIN_REQUIRED');
      if (revision !== this.revision) error('CODEX_AUTH_CHANGED');
      if (signal.aborted) return fail(options.signal.aborted ? 'CANCELLED' : 'TIMEOUT', usage);
      const serialized = JSON.stringify(plan.descriptor);
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: plan.role,
        modelId: plan.modelId,
        method: 'RPC',
        url: CODEX_ENDPOINT,
        headers: {},
        body: plan.descriptor,
        bodySha256: hash(serialized),
        stablePrefixSha256: hash(plan.stablePrefix),
      });
      if (signal.aborted || revision !== this.revision) return fail(abortCode(), usage);
      const started = await process.request<unknown>(
        'thread/start',
        {
          model: plan.modelId,
          modelProvider: 'openai',
          cwd: this.work,
          ephemeral: true,
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: 'read-only',
          environments: [],
          selectedCapabilityRoots: [],
          developerInstructions: plan.developerInstructions,
          config: plan.config,
        },
        { signal }
      );
      if (
        !object(started) ||
        !object(started.thread) ||
        !boundedString(started.thread.id) ||
        started.model !== plan.modelId
      )
        error('CODEX_INVALID_THREAD');
      threadId = (started as { thread: { id: string } }).thread.id;
      let resolveTurn: () => void;
      const completed = new Promise<void>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      // Attach the rejection handler before issuing RPC: completion may precede its reply.
      void completed.catch(() => {});
      offExit = process.onExit(() =>
        rejectTurn(new ProviderContractError('CODEX_EXECUTION_INTERRUPTED'))
      );
      offNotification = process.onNotification((method, params) => {
        if (method === 'uimori/unsupportedRequest') {
          rejectTurn(new ProviderContractError('CODEX_TOOL_NOT_ALLOWED'));
          return;
        }
        if (
          ![
            'turn/started',
            'turn/completed',
            'thread/tokenUsage/updated',
            'item/started',
            'item/completed',
          ].includes(method)
        )
          return;
        if (!object(params) || params.threadId !== threadId) return;
        const eventTurn =
          (method === 'turn/started' || method === 'turn/completed') && object(params.turn)
            ? params.turn.id
            : params.turnId;
        if (!boundedString(eventTurn) || (turnId && eventTurn !== turnId)) {
          rejectTurn(new ProviderContractError('CODEX_EVENT_MISMATCH'));
          return;
        }
        turnId ??= eventTurn;
        if (
          method === 'thread/tokenUsage/updated' &&
          object(params.tokenUsage) &&
          object(params.tokenUsage.total)
        ) {
          const value = params.tokenUsage.total;
          usage = {
            ...emptyUsage(),
            inputTokens: integer(value.inputTokens) ? value.inputTokens : null,
            outputTokens: integer(value.outputTokens) ? value.outputTokens : null,
          };
        }
        if ((method === 'item/started' || method === 'item/completed') && object(params.item)) {
          const item = params.item;
          if (!plan.allowedItems.includes(String(item.type))) {
            rejectTurn(new ProviderContractError('CODEX_TOOL_NOT_ALLOWED'));
            return;
          }
          // Native work and commentary are intermediate. A phase-less message is
          // only a legacy final candidate until a later activity supersedes it.
          if (!['userMessage', 'reasoning', 'agentMessage'].includes(String(item.type)))
            legacyOutput = '';
          if (
            method === 'item/completed' &&
            item.type === 'agentMessage' &&
            item.phase === 'commentary'
          )
            legacyOutput = '';
          if (
            method === 'item/completed' &&
            item.type === 'agentMessage' &&
            (item.phase === 'final_answer' || item.phase == null)
          ) {
            if (
              !boundedString(item.id) ||
              typeof item.text !== 'string' ||
              item.text.length > 2_000_000 ||
              (item.phase === 'final_answer' && outputItem && outputItem !== item.id)
            ) {
              rejectTurn(new ProviderContractError('CODEX_INVALID_OUTPUT'));
              return;
            }
            if (item.phase === 'final_answer') {
              outputItem = item.id;
              output = item.text;
            } else legacyOutput = item.text;
          }
          try {
            plan.onItem?.(item, method);
          } catch {
            rejectTurn(new ProviderContractError('CODEX_INVALID_OUTPUT'));
            return;
          }
        }
        if (method === 'turn/completed') {
          if (
            !object(params.turn) ||
            params.turn.status !== 'completed' ||
            params.turn.error != null
          )
            rejectTurn(
              new ProviderContractError(
                params.turn && object(params.turn) && params.turn.status === 'interrupted'
                  ? 'CODEX_EXECUTION_INTERRUPTED'
                  : 'CODEX_TURN_FAILED'
              )
            );
          else resolveTurn!();
        }
      });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      options.beforeTurn?.();
      const turn = await process.request<unknown>(
        'turn/start',
        {
          threadId,
          model: plan.modelId,
          input: plan.input,
          outputSchema: plan.outputSchema,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...(plan.effort ? { effort: plan.effort } : {}),
        },
        { signal }
      );
      if (
        !object(turn) ||
        !object(turn.turn) ||
        !boundedString(turn.turn.id) ||
        (turnId && turn.turn.id !== turnId)
      )
        error('CODEX_EVENT_MISMATCH');
      turnId = (turn as { turn: { id: string } }).turn.id;
      await completed;
      if (signal.aborted || revision !== this.revision) return fail(abortCode(), usage);
      return { ok: true, output: outputItem ? output : legacyOutput, usage };
    } catch (caught) {
      return fail(
        options.signal.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMEOUT' : safeError(caught),
        usage
      );
    } finally {
      signal.removeEventListener('abort', aborted);
      signal.removeEventListener('abort', stopOnAbort);
      offNotification();
      offExit();
      if (process) {
        // Closing the isolated process prevents a late or uncertain turn being reused.
        // A request can already be executing upstream; it is never replayed here.
        if (signal.aborted) await stopProcess();
        else await process.close();
        this.active.delete(process);
      }
      if (slot) slots.release();
    }
  }
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown(): Promise<void> {
    this.closed = true;
    this.revision++;
    this.rejectWaiting('CODEX_CLOSED');
    await Promise.allSettled(
      [...this.active, ...(this.manager ? [this.manager] : [])].map((process) => process.close())
    );
    await Promise.allSettled([this.installation, this.managerStart]);
    this.manager = undefined;
    this.active.clear();
    if (
      this.work &&
      dirname(this.work) === resolve(tmpdir()) &&
      this.work.startsWith(join(resolve(tmpdir()), 'uimori-codex-'))
    )
      await rm(this.work, { recursive: true, force: true });
  }
}

function assertCodexConnection(connection: ProviderConnection): void {
  if (
    connection.protocol !== 'codex-app-server-v1' ||
    connection.endpoint !== CODEX_ENDPOINT ||
    connection.credentialEnv
  )
    error('CODEX_INVALID_CONNECTION');
}
function parseRateLimits(value: unknown): CodexRuntimeStatus['limits'] {
  if (!object(value)) return [];
  const snapshots = object(value.rateLimitsByLimitId)
    ? Object.entries(value.rateLimitsByLimitId).slice(0, 10)
    : [['codex', value.rateLimits]];
  const result: CodexRuntimeStatus['limits'] = [];
  for (const [name, snapshot] of snapshots)
    if (object(snapshot))
      for (const slot of ['primary', 'secondary']) {
        const window = snapshot[slot];
        if (
          object(window) &&
          typeof window.usedPercent === 'number' &&
          Number.isFinite(window.usedPercent)
        )
          result.push({
            name: `${String(name).slice(0, 80)} · ${slot}`,
            usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
            resetsAt: integer(window.resetsAt) ? window.resetsAt : null,
          });
      }
  return result;
}
