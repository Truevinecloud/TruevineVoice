import type { OrganizationRole, PlatformRole } from '@truevine/auth';
export type RolloutAccount =
  | { scope: 'organization'; role: OrganizationRole; email: string }
  | { scope: 'platform'; role: PlatformRole; email: string };
export const ROLLOUT_ACCOUNTS: readonly RolloutAccount[];
export const INVENTORY_DIGEST: string;
export interface RolloutState {
  operationId?: string;
  organizationId?: string;
  isolationOrganizationId?: string;
  preservedAdminId: string;
  ownerId: string;
  accountCount?: number;
  state?: string;
  initialized?: boolean;
}
export function validateRollout(approval: unknown, credentials: unknown, environment: NodeJS.ProcessEnv, confirmProduction?: boolean, now?: number): { origin: string };
export function executeRollout(approval: unknown, credentials: unknown, options?: unknown, dependencies?: unknown): Promise<RolloutState>;
export function rolloutMain(argv?: string[]): Promise<void>;
