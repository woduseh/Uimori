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
export type BackupStatus = {
  settings: BackupSettings;
  status: 'idle' | 'running' | 'failed';
  lastSuccess: BackupManifest | null;
  error: string | null;
  warning: string | null;
  backups: BackupManifest[];
};
