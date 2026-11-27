export type BackupSettings = {
  revision: number;
  enabled: boolean;
  hour: number;
  minute: number;
  retain: number;
  nextRunAt: string | null;
};
export type BackupManifest = {
  format: 'uimori-snapshot-v1';
  id: string;
  createdAt: string;
  appVersion: string;
  buildId: string;
  schema: number;
  bytes: number;
  sha256: string;
};
export type BackupStatusCode =
  | 'BACKUP_DISK_FULL'
  | 'BACKUP_PERMISSION_DENIED'
  | 'BACKUP_FAILED'
  | 'BACKUP_INTERRUPTED'
  | 'BACKUP_STATE_UNRECORDED'
  | 'BACKUP_SCHEDULE_FAILED'
  | 'BACKUP_PRUNE_INCOMPLETE';
export type BackupStatus = {
  settings: BackupSettings;
  status: 'idle' | 'running' | 'failed';
  lastSuccess: BackupManifest | null;
  error: BackupStatusCode | string | null;
  warning: BackupStatusCode | string | null;
  backups: BackupManifest[];
};
