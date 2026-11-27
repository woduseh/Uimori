export const MAINTENANCE_CLOSED = 'MAINTENANCE_CLOSED';

export type MaintenanceStatus = {
  status: 'open' | 'closed';
  epoch: number;
  reason?: string;
  updatedAt: string;
  forcedClosed: boolean;
};
