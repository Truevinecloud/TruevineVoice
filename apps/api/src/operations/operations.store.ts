import type { CampaignStatus } from '../campaigns/campaign.store.js';

export interface OrganizationOperationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly createdAt: Date;
  readonly campaignCount: number;
}

export interface CampaignOperationRecord {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus | 'PAUSED';
  readonly emergencyStoppedAt: Date | null;
  readonly updatedAt: Date;
}

export type EmergencyStopResult =
  | { readonly kind: 'stopped'; readonly campaign: CampaignOperationRecord }
  | { readonly kind: 'already_stopped'; readonly campaign: CampaignOperationRecord }
  | { readonly kind: 'not_active' }
  | { readonly kind: 'not_found' };

export interface EmergencyStopInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly actorUserId: string;
  readonly reasonCode: EmergencyStopReasonCode;
  readonly stoppedAt: Date;
}

export const EMERGENCY_STOP_REASON_CODES = [
  'security_incident',
  'provider_incident',
  'abuse_suspected',
  'customer_request',
  'other',
] as const;
export type EmergencyStopReasonCode = (typeof EMERGENCY_STOP_REASON_CODES)[number];

export interface OperationsStore {
  listOrganizations(): Promise<readonly OrganizationOperationRecord[]>;
  listCampaigns(): Promise<readonly CampaignOperationRecord[]>;
  emergencyStop(input: EmergencyStopInput): Promise<EmergencyStopResult>;
}
