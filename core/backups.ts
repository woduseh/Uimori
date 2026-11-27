export type { BackupManifest, BackupSettings, BackupStatus } from '#contracts';
export type BackupStatusCode =
  | 'BACKUP_DISK_FULL'
  | 'BACKUP_PERMISSION_DENIED'
  | 'BACKUP_FAILED'
  | 'BACKUP_INTERRUPTED'
  | 'BACKUP_STATE_UNRECORDED'
  | 'BACKUP_SCHEDULE_FAILED'
  | 'BACKUP_PRUNE_INCOMPLETE';
