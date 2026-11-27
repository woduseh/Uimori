import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { USAGE_KINDS } from './usage-kinds.js';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((date) => {
    const time = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
  }, 'Invalid calendar date');
const usageRange = { from: calendarDate, to: calendarDate };
const ordered = (range: { from: string; to: string }) => range.from <= range.to;
const orderMessage = { message: 'Usage start date is after the end date', path: ['to'] };

export const usagePeriod = z.strictObject(usageRange).refine(ordered, orderMessage);
export type UsagePeriod = z.infer<typeof usagePeriod>;
export const usageExportQuery = z
  .strictObject({ ...usageRange, group: z.enum(['day', 'model', 'kind']).default('day') })
  .refine(ordered, orderMessage);

const count = z.int().nonnegative();
const usd = z.number().nonnegative();
export const usageTotals = z.strictObject({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  unknownInputCalls: count,
  unknownOutputCalls: count,
  reportedUsd: usd,
  estimatedUsd: usd,
  partialUsd: usd,
  partialCalls: count,
  unknownCostCalls: count,
  runningCalls: count,
});
export type UsageTotals = z.infer<typeof usageTotals>;
export const usageReport = z.strictObject({
  from: z.string(),
  to: z.string(),
  timeZone: z.literal('Asia/Seoul'),
  totals: usageTotals,
  days: z.array(usageTotals.extend({ day: z.string() })),
  models: z.array(usageTotals.extend({ modelId: z.string(), connectionId: z.string() })),
  kinds: z.array(usageTotals.extend({ kind: z.enum(USAGE_KINDS) })),
  undated: usageTotals,
  coverageSince: z.string(),
});
export type UsageReport = z.infer<typeof usageReport>;

export const backupSettings = z.strictObject({
  revision,
  enabled: z.boolean(),
  hour: z.int(),
  minute: z.int(),
  retain: z.int(),
  nextRunAt: z.string().nullable(),
});
export type BackupSettings = z.infer<typeof backupSettings>;
export const backupManifest = z.strictObject({
  format: z.literal('uimori-snapshot-v1'),
  id: z.string(),
  createdAt: z.string(),
  appVersion: z.string(),
  buildId: z.string(),
  schema: z.int(),
  bytes: z.int().nonnegative(),
  sha256: z.string(),
});
export type BackupManifest = z.infer<typeof backupManifest>;
export const backupStatus = z.strictObject({
  settings: backupSettings,
  status: z.enum(['idle', 'running', 'failed']),
  lastSuccess: backupManifest.nullable(),
  error: z.string().nullable(),
  warning: z.string().nullable(),
  backups: z.array(backupManifest),
});
export type BackupStatus = z.infer<typeof backupStatus>;
export const updateBackupSettingsInput = z.strictObject({
  expectedRevision: revision,
  enabled: z.boolean(),
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
  retain: z.int().min(1).max(30),
});
export type UpdateBackupSettings = z.infer<typeof updateBackupSettingsInput>;

export const personalWorkspaceOperations = {
  readUsage: defineOperation('personal-workspace.readUsage', usagePeriod, usageReport),
  readBackups: defineOperation('personal-workspace.readBackups', z.strictObject({}), backupStatus),
  updateBackupSettings: defineOperation(
    'personal-workspace.updateBackupSettings',
    updateBackupSettingsInput,
    backupSettings
  ),
  startBackup: defineOperation(
    'personal-workspace.startBackup',
    z.strictObject({}),
    z.strictObject({ status: z.literal('running') })
  ),
};
