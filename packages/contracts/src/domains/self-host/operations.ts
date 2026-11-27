import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { nonBlank } from '../text.js';

const maintenanceStatus = z.enum(['open', 'closed']);
export const maintenanceReport = z.strictObject({
  status: maintenanceStatus,
  epoch: z.int().nonnegative(),
  reason: z.string().optional(),
  updatedAt: z.string(),
  forcedClosed: z.boolean(),
  activeWork: z.int().nonnegative(),
});
export const setMaintenanceInput = z.strictObject({
  status: maintenanceStatus,
  reason: nonBlank(200).optional(),
});

export const selfHostOperations = {
  readMaintenance: defineOperation(
    'self-host.readMaintenance',
    z.strictObject({}),
    maintenanceReport
  ),
  setMaintenance: defineOperation(
    'self-host.setMaintenance',
    setMaintenanceInput,
    maintenanceReport
  ),
};
