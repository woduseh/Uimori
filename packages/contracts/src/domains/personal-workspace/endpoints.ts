import { defineEndpoint } from '../../endpoint.js';
import type { personalWorkspaceOperations as operations } from './operations.js';

export const personalWorkspaceEndpoints = {
  readUsage: defineEndpoint<typeof operations.readUsage>({
    operation: 'personal-workspace.readUsage',
    method: 'GET',
    path: '/usage',
  }),
  readBackups: defineEndpoint<typeof operations.readBackups>({
    operation: 'personal-workspace.readBackups',
    method: 'GET',
    path: '/backups',
  }),
  updateBackupSettings: defineEndpoint<typeof operations.updateBackupSettings>({
    operation: 'personal-workspace.updateBackupSettings',
    method: 'PUT',
    path: '/backups/settings',
  }),
  startBackup: defineEndpoint<typeof operations.startBackup>({
    operation: 'personal-workspace.startBackup',
    method: 'POST',
    path: '/backups',
    status: 202,
  }),
};
