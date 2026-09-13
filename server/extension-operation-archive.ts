import { isDeepStrictEqual } from 'node:util';
import { packageInstanceId } from '../core/execution-context.js';
import { validateExtensionUserModelAttribution } from '../core/extension-model.js';
import type { ExtensionOperationSnapshot } from '../core/extension-operation.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import {
  validateExtensionVariablePermission,
  projectExtensionVariableMutation,
  variableStateFromProfile,
} from './extension-variables.js';
import {
  behaviorActionTriggers,
  validateBehaviorValue,
  validatePackageBehavior,
} from '../core/package-behavior.js';
import { inspectRuntimeValue } from '../core/prompt-values.js';
import {
  validateExtensionProgramReceipt,
  validateExtensionComputationReceipt,
} from './extension-program-receipt.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { validateExtensionConversationPermission } from './extension-conversation-access.js';
import {
  extensionConversationViewHash,
  resolveExtensionConversation,
} from './extension-conversation.js';

export { EXTENSION_OPERATION_TABLES } from './extension-operations.js';
type Row = Record<string, any>;
const fail = (reason: string): never => {
  throw new HttpError(400, `Invalid extension operation archive: ${reason}`);
};
const same = (a: unknown, b: unknown, reason: string) => {
  if (!isDeepStrictEqual(a, b)) fail(reason);
};
export function normalizeExtensionOperationArchiveRow(table: string, row: Row): void {
  if (table !== 'package_extension_operations') return;
  const snapshot = record(JSON.parse(row.snapshot));
  const profile = record(snapshot.profile);
  for (const model of [
    ...Object.values(profile.models ?? {}),
    ...Object.values(profile.collaborationModels ?? {}),
    profile.contextModel,
    profile.extensionModel,
  ]) {
    if (!model) continue;
    const connection = record(record(model).connection);
    for (const key of ['credentialEnv', 'secret', 'apiKey', 'accessToken']) delete connection[key];
    connection.enabled = false;
  }
  row.snapshot = JSON.stringify(snapshot);
  row.owner = null;
  if (['queued', 'running'].includes(row.status)) {
    number(row.generation, 'extension generation', 0);
    row.generation += 1;
    row.status = 'interrupted';
    row.error = 'Restored uncertain extension operation; explicit new action required';
  }
}

/** Validate frozen receipts and their single attempt owner without executing guest code. */
export function validateExtensionOperationArchive(
  store: Store,
  validateProfile?: (profile: unknown, chatId: string) => void
): Set<string> {
  const owners = new Set<string>();
  const operations = store.db.prepare('SELECT * FROM package_extension_operations').all() as Row[];
  const known = new Set(operations.map((row) => row.id));
  const joins = store.db
    .prepare('SELECT * FROM package_extension_operation_attempts ORDER BY call_index')
    .all() as Row[];
  for (const link of joins) if (!known.has(link.operation_id)) fail('orphan attempt link');
  for (const row of operations) {
    text(row.id, 'operation ID', 100);
    number(row.generation, 'operation generation', 0, Number.MAX_SAFE_INTEGER);
    if (
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status) ||
      row.owner !== null
    )
      fail('status or owner');
    for (const key of ['created_at', 'updated_at', 'started_at']) {
      if (key === 'started_at' && row[key] === null) continue;
      if (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key]))) fail('timestamp');
    }
    if (row.error !== null && typeof row.error !== 'string') fail('error');
    const command = record(JSON.parse(row.command));
    fields(command, [
      'actionId',
      'input',
      'expectedStateRevision',
      'expectedSourceHash',
      'idempotencyKey',
      'panel',
    ]);
    text(command.actionId, 'action ID', 200);
    text(command.idempotencyKey, 'idempotency key', 200);
    number(command.expectedStateRevision, 'expected state revision', 0, Number.MAX_SAFE_INTEGER);
    inspectRuntimeValue(command.input);
    same(row.request_key, command.idempotencyKey, 'request key');
    same(row.request_hash, behaviorPayloadHash(command), 'request hash');
    const snapshot = record(JSON.parse(row.snapshot));
    fields(snapshot, [
      'version',
      'scope',
      'stateRevision',
      'state',
      'runtime',
      'guard',
      'profile',
      'settings',
      'sourceRevision',
      'sourceHash',
      'extensionConversation',
    ]);
    if (snapshot.version !== 1) fail('snapshot version');
    const scope = record(snapshot.scope);
    fields(scope, [
      'chatId',
      'branchId',
      'attachmentInstanceId',
      'packageId',
      'packageRevision',
      'behaviorRevision',
      'schemaVersion',
    ]);
    same(
      [scope.chatId, scope.branchId, scope.attachmentInstanceId],
      [row.chat_id, row.branch_id, row.attachment_instance_id],
      'scope ownership'
    );
    store.product.branch(row.chat_id, row.branch_id);
    same(snapshot.profile.chatId, row.chat_id, 'profile owner');
    validateProfile?.(snapshot.profile, row.chat_id);
    for (const key of ['packageRevision', 'behaviorRevision', 'schemaVersion'])
      number(scope[key], key, 1);
    if (typeof snapshot.guard !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshot.guard))
      fail('guard');
    same(snapshot.stateRevision, command.expectedStateRevision, 'state expectation');
    same(snapshot.sourceHash, command.expectedSourceHash, 'source expectation');
    if (snapshot.sourceRevision === null) {
      if (snapshot.sourceHash !== null) fail('source pair');
    } else {
      const source = store.sourceAtHash(snapshot.sourceRevision, snapshot.sourceHash);
      same(source.chatId, row.chat_id, 'source owner');
    }
    const frozen = snapshot as ExtensionOperationSnapshot;
    const conversation = frozen.extensionConversation;
    const conversationView =
      conversation === undefined
        ? undefined
        : (() => {
            if (conversation.admissionRunId !== null) fail('conversation admission owner');
            for (const ref of conversation.messages) {
              const run = store.db.prepare('SELECT created_at FROM runs WHERE id=?').get(ref.runId);
              if (!run || Date.parse(String(run.created_at)) > Date.parse(row.created_at))
                fail('conversation admission time');
            }
            const refs = new Map(
              conversation.messages
                .filter((ref) => ref.kind === 'source')
                .map((ref) => [ref.sourceRevision, ref])
            );
            if (
              frozen.sourceRevision !== null &&
              refs.get(frozen.sourceRevision)?.hash !== frozen.sourceHash
            )
              fail('conversation source hash binding');
            const history = store.history(frozen.sourceRevision).map((item) => {
              const ref = refs.get(item.revision);
              if (!ref) return fail('conversation source reference');
              const source = store.sourceAtHash(item.revision, ref.hash);
              return { ...item, text: source.text, contentHash: source.hash };
            });
            return resolveExtensionConversation(
              store,
              {
                chatId: row.chat_id,
                branchId: row.branch_id,
                parentRevision: frozen.sourceRevision,
                history,
              },
              conversation
            );
          })();
    const ref = frozen.profile.packageAttachments?.find(
      (item) => packageInstanceId(item) === scope.attachmentInstanceId
    );
    if (!ref || ref.id !== scope.packageId || ref.revision !== scope.packageRevision)
      fail('package reference');
    const pkg = frozen.profile.packages?.find(
      (item) => item.id === scope.packageId && item.revision === scope.packageRevision
    );
    if (!pkg?.behavior) fail('package definition');
    const definition = validatePackageBehavior(pkg!.behavior);
    same(
      [definition.revision, definition.schemaVersion],
      [scope.behaviorRevision, scope.schemaVersion],
      'definition revision'
    );
    validateBehaviorValue(definition.stateSchema, snapshot.state);
    inspectRuntimeValue(record(snapshot.runtime));
    const action = definition.actions.find((item) => item.id === command.actionId);
    if (!action?.program || !behaviorActionTriggers(action).includes('user')) fail('action');
    const validateVariables = (
      variables: import('../core/chat-variables.js').ChatVariableMutation | undefined
    ) => {
      if (!variables) return;
      validateExtensionVariablePermission(variables, snapshot.profile, ref!, action!.program!);
      projectExtensionVariableMutation(variableStateFromProfile(snapshot.profile), variables);
    };
    const validateConversation = (receipt: { viewHash: string } | undefined) => {
      if (!receipt) return;
      if (!conversationView) fail('conversation context missing');
      validateExtensionConversationPermission(
        receipt,
        frozen.profile,
        ref!,
        action!.program!,
        extensionConversationViewHash(conversationView!)
      );
    };
    validateBehaviorValue(action!.inputSchema, command.input);
    if (command.panel !== undefined) {
      const panel = record(command.panel);
      fields(panel, ['id', 'packageRevision']);
      text(panel.id, 'panel ID', 200);
      same(panel.packageRevision, scope.packageRevision, 'panel revision');
    }
    const settings = record(snapshot.settings);
    fields(settings, ['preset', 'mode', 'translation', 'status', 'maxCalls']);
    if (
      !['calm', 'vivid'].includes(settings.preset) ||
      !['direct', 'research'].includes(settings.mode) ||
      typeof settings.translation !== 'boolean' ||
      typeof settings.status !== 'boolean'
    )
      fail('settings');
    number(settings.maxCalls, 'call budget', 1, Number.MAX_SAFE_INTEGER);
    const links = joins.filter((link) => link.operation_id === row.id);
    if (links.length > settings.maxCalls) fail('call budget');
    for (const [index, link] of links.entries()) {
      same(link.call_index, index, 'call index');
      if (owners.has(link.attempt_id)) fail('duplicate attempt owner');
      owners.add(link.attempt_id);
      const attempt = store.db.prepare('SELECT * FROM attempts WHERE id=?').get(link.attempt_id) as
        | Row
        | undefined;
      if (
        !attempt ||
        attempt.chat_id !== row.chat_id ||
        attempt.role !== 'state' ||
        attempt.run_id !== null ||
        attempt.job_id !== null ||
        attempt.story_job_id !== null ||
        attempt.status === 'mock'
      )
        fail('attempt ownership');
      const request = record(JSON.parse(attempt!.request));
      if (request.agentId !== undefined) fail('attempt agent');
      const { target } = validateExtensionUserModelAttribution(
        frozen.profile,
        { instanceId: row.attachment_instance_id, actionId: command.actionId },
        request.extensionAction
      );
      same(
        [attempt!.model_id, attempt!.connection_id, request.modelId, request.connectionId],
        [target.modelId, target.connectionId, target.modelId, target.connectionId],
        'attempt target'
      );
    }
    if (row.usage !== null) {
      const usage = record(JSON.parse(row.usage));
      fields(usage, ['modelCalls', 'inputTokens', 'outputTokens', 'costUsd']);
      same(usage.modelCalls, links.length, 'usage calls');
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'])
        if (
          usage[key] !== null &&
          (typeof usage[key] !== 'number' ||
            !Number.isFinite(usage[key]) ||
            usage[key] < 0 ||
            (key !== 'costUsd' && !Number.isSafeInteger(usage[key])))
        )
          fail('usage');
    }
    const journal = store.db
      .prepare(
        'SELECT payload,result FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
      )
      .get(row.chat_id, row.branch_id, row.attachment_instance_id, command.idempotencyKey) as
      | Row
      | undefined;
    if (row.status === 'completed') {
      if (row.result === null || row.usage === null || row.error !== null) fail('completed result');
      const result = record(JSON.parse(row.result));
      const receipt = validateExtensionProgramReceipt(
        { api: EXTENSION_PROGRAM_API, ...result },
        {
          programHash: behaviorPayloadHash(action!.program),
          stateSchema: definition.stateSchema,
          state: result.state,
          result: result.result,
        }
      );
      validateVariables(receipt.variables);
      validateConversation(receipt.conversation);
      if (!journal) fail('completed journal missing');
      const payload = JSON.parse(journal!.payload),
        adopted = JSON.parse(journal!.result);
      same(payload.scope, scope, 'journal scope');
      same(payload.provenance, 'ui-action', 'journal provenance');
      for (const key of [
        'actionId',
        'input',
        'expectedStateRevision',
        'expectedSourceHash',
        'idempotencyKey',
      ])
        same(payload[key], command[key], `journal ${key}`);
      same(payload.hostRuntime, snapshot.runtime, 'journal runtime');
      same(payload.program, receipt, 'journal program');
      same(adopted.beforeState, snapshot.state, 'journal previous state');
      same(adopted.state, result.state, 'journal adopted state');
    } else {
      if (journal && JSON.parse(journal.payload).provenance === 'ui-action')
        fail('uncompleted operation adopted');
      if (row.result !== null) {
        const result = record(JSON.parse(row.result));
        const receipt = validateExtensionComputationReceipt(
          { api: EXTENSION_PROGRAM_API, ...result },
          behaviorPayloadHash(action!.program)
        );
        validateVariables(receipt.variables);
        validateConversation(receipt.conversation);
      }
    }
  }
  return owners;
}
