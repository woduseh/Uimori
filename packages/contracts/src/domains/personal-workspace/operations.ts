import { z } from 'zod';
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

export const usagePeriod = z.object(usageRange).refine(ordered, orderMessage);
export type UsagePeriod = z.infer<typeof usagePeriod>;
export const usageExportQuery = z
  .object({ ...usageRange, group: z.enum(['day', 'model', 'kind']).default('day') })
  .refine(ordered, orderMessage);

const count = z.number().int().nonnegative();
const usd = z.number().nonnegative();
export const usageTotals = z.object({
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
export const usageReport = z.object({
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

export const backupSettings = z.object({
  revision,
  enabled: z.boolean(),
  hour: z.number().int(),
  minute: z.number().int(),
  retain: z.number().int(),
  nextRunAt: z.string().nullable(),
});
export type BackupSettings = z.infer<typeof backupSettings>;
export const backupManifest = z.object({
  format: z.literal('uimori-snapshot-v1'),
  id: z.string(),
  createdAt: z.string(),
  appVersion: z.string(),
  buildId: z.string(),
  schema: z.number().int(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type BackupManifest = z.infer<typeof backupManifest>;
export const backupStatus = z.object({
  settings: backupSettings,
  status: z.enum(['idle', 'running', 'failed']),
  lastSuccess: backupManifest.nullable(),
  error: z.string().nullable(),
  warning: z.string().nullable(),
  backups: z.array(backupManifest),
});
export type BackupStatus = z.infer<typeof backupStatus>;
export const updateBackupSettingsInput = z.object({
  expectedRevision: revision,
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  retain: z.number().int().min(1).max(30),
});
export type UpdateBackupSettings = z.infer<typeof updateBackupSettingsInput>;

export const personalWorkspaceOperations = {
  readUsage: defineOperation('personal-workspace.readUsage', usagePeriod, usageReport),
  readBackups: defineOperation('personal-workspace.readBackups', z.object({}), backupStatus),
  updateBackupSettings: defineOperation(
    'personal-workspace.updateBackupSettings',
    updateBackupSettingsInput,
    backupSettings
  ),
  startBackup: defineOperation(
    'personal-workspace.startBackup',
    z.object({}),
    z.object({ status: z.literal('running') })
  ),
};
