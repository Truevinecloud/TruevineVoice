/**
 * SMS fallback orchestration service.
 *
 * Coordinates idempotent SMS fallback for eligible failed voice calls.
 *
 * Idempotency guarantees:
 *   - A stable logical fallback identity is derived from (organizationId,
 *     campaignId, recipientId, voiceAttemptId).
 *   - Database uniqueness on that identity prevents duplicate operations.
 *   - Claims are transactional; concurrent workers cannot both initiate the
 *     same fallback.
 *   - Uncertain provider outcomes are persisted and not blindly retried.
 *
 * States:
 *   PENDING    - Operation created, not yet dispatched to provider.
 *   SENT       - Provider accepted the message.
 *   FAILED     - Provider permanently rejected the message.
 *   UNCERTAIN  - Provider outcome unknown; reconciliation required.
 */

import { Inject } from '@nestjs/common';
import { isTerminal, type CallState } from '@truevine/domain';
import { SMS_PORT } from './sms-tokens.js';
import type { SmsPort } from './sms-port.js';
import { DATABASE_CLIENT } from '../tokens.js';

export type Tx = {
  smsFallbackOperation: {
    findUnique(input: unknown): Promise<Record<string, unknown> | null>;
    create(input: unknown): Promise<Record<string, unknown>>;
    update(input: unknown): Promise<Record<string, unknown>>;
  };
  $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
};

export type SmsFallbackOutcome =
  | { readonly status: 'eligible_pending'; readonly fallbackId: string }
  | { readonly status: 'already_pending'; readonly fallbackId: string }
  | { readonly status: 'already_sent'; readonly fallbackId: string; readonly providerReference: string }
  | { readonly status: 'already_failed'; readonly fallbackId: string }
  | { readonly status: 'already_uncertain'; readonly fallbackId: string }
  | { readonly status: 'ineligible'; readonly reason: string }
  | { readonly status: 'retryable_conflict' };

export interface SmsFallbackInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly voiceAttemptId: string;
}

/**
 * All values resolved from trusted server-side database records.
 * Caller-supplied values are never used for eligibility or dispatch.
 */
interface SmsFallbackExecutionInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly voiceAttemptId: string;
  readonly recipientId: string;
  readonly phoneE164: string;
  readonly message: string;
  readonly voiceOutcome: string;
  readonly voiceTerminal: boolean;
  readonly recipientContactFound: boolean;
  readonly recipientSuppressed: boolean;
  readonly recipientSmsConsent: boolean;
  readonly organizationSmsEntitled: boolean;
  readonly campaignSmsEnabled: boolean;
  readonly campaignEmergencyStopped: boolean;
  readonly providerReady: boolean;
  readonly billingAuthorized: boolean;
  readonly operationalStop: boolean;
}

import { SmsFallbackEligibilityService } from './sms-fallback-eligibility.service.js';

export class SmsFallbackOrchestrationService {
  constructor(
    @Inject(SmsFallbackEligibilityService) private readonly eligibility: SmsFallbackEligibilityService,
    @Inject(SMS_PORT) private readonly sms: SmsPort,
    @Inject(DATABASE_CLIENT) private readonly prisma: Tx,
  ) {}

  async evaluateAndDispatch(input: SmsFallbackInput): Promise<SmsFallbackOutcome> {
    // Load all execution inputs from trusted server-side database records.
    // Never trust caller-supplied values for entitlement, consent, outcome, phone, or message.
    const executionInput = await this.loadEligibilityInputs(input);

    const eligibility = this.eligibility.evaluate({
      organizationId: executionInput.organizationId,
      campaignId: executionInput.campaignId,
      voiceAttemptId: executionInput.voiceAttemptId,
      voiceOutcome: executionInput.voiceOutcome,
      voiceTerminal: executionInput.voiceTerminal,
      recipientId: executionInput.recipientId,
      recipientPhone: executionInput.phoneE164,
      recipientSuppressed: executionInput.recipientSuppressed,
      recipientSmsConsent: executionInput.recipientSmsConsent,
      campaignSmsEnabled: executionInput.campaignSmsEnabled,
      organizationSmsEntitled: executionInput.organizationSmsEntitled,
      providerReady: executionInput.providerReady,
      billingAuthorized: executionInput.billingAuthorized,
      operationalStop: executionInput.operationalStop,
      approvedMessage: executionInput.message,
    });
    if (eligibility.status !== 'eligible') {
      return { status: 'ineligible', reason: eligibility.reason ?? 'SMS fallback is not eligible.' };
    }

    return await this.executeTransaction(executionInput);
  }

  /**
   * Loads eligibility inputs exclusively from server-side database records.
   * Missing columns (not yet migrated) default to deny — fail closed.
   * Caller-supplied values are never used for eligibility decisions.
   */
  private async loadEligibilityInputs(input: SmsFallbackInput): Promise<SmsFallbackExecutionInput> {
    // 1. Voice attempt state: terminal outcome and recipient from the call attempt record.
    let voiceOutcome = '';
    let voiceTerminal = false;
    let recipientId = '';
    try {
      const attempts = await this.prisma.$queryRaw<{ state: string; recipient_id: string }[]>`
        SELECT state, recipient_id FROM call_attempts
        WHERE organization_id = ${input.organizationId}::uuid
          AND id = ${input.voiceAttemptId}::uuid`;
      if (attempts[0]) {
        voiceOutcome = attempts[0].state as unknown as CallState;
        voiceTerminal = isTerminal(voiceOutcome as CallState);
        recipientId = attempts[0].recipient_id;
      }
    } catch {
      // Query failed: voice attempt not found or table unavailable. Fail closed.
    }

    // 2. Organization SMS entitlement and suspension status.
    let organizationSmsEntitled = false;
    let operationalStop = false;
    try {
      const orgs = await this.prisma.$queryRaw<{ sms_entitled: boolean | null; suspended_at: Date | null }[]>`
        SELECT sms_entitled, suspended_at FROM organizations
        WHERE id = ${input.organizationId}::uuid`;
      if (orgs[0]) {
        organizationSmsEntitled = orgs[0].sms_entitled === true;
        operationalStop = orgs[0].suspended_at !== null;
      }
    } catch {
      // sms_entitled column not yet migrated: fail closed (remains false).
    }

    // 3. Campaign SMS fallback enablement, approved message, and emergency stop.
    let campaignSmsEnabled = false;
    let approvedMessage: string | null = null;
    let campaignEmergencyStopped = false;
    try {
      const campaigns = await this.prisma.$queryRaw<{ sms_fallback_enabled: boolean | null; sms_fallback_message: string | null; emergency_stopped_at: Date | null }[]>`
        SELECT sms_fallback_enabled, sms_fallback_message, emergency_stopped_at FROM campaigns
        WHERE organization_id = ${input.organizationId}::uuid AND id = ${input.campaignId}::uuid`;
      if (campaigns[0]) {
        campaignSmsEnabled = campaigns[0].sms_fallback_enabled === true;
        approvedMessage = campaigns[0].sms_fallback_message;
        campaignEmergencyStopped = campaigns[0].emergency_stopped_at != null;
      }
    } catch {
      // Campaign SMS columns not yet migrated: fail closed (remains disabled).
    }

    // 4. Recipient contact, phone number, suppression, and consent from the contact record.
    // The voice attempt's recipient links to campaign_recipients -> contacts.
    let recipientContactFound = false;
    let recipientPhone: string | null = null;
    let recipientSuppressed = false;
    let recipientSmsConsent = false; // Unknown consent denies dispatch.
    try {
      const contacts = await this.prisma.$queryRaw<{ phone_e164: string | null; suppressed_at: Date | null; sms_consent: boolean | null }[]>`
        SELECT c.phone_e164, c.suppressed_at, c.sms_consent
        FROM contacts c
        JOIN campaign_recipients cr ON cr.organization_id = c.organization_id AND cr.contact_id = c.id
        JOIN call_attempts ca ON ca.organization_id = cr.organization_id AND ca.recipient_id = cr.id
        WHERE ca.organization_id = ${input.organizationId}::uuid
          AND ca.id = ${input.voiceAttemptId}::uuid`;
      if (contacts[0]) {
        recipientContactFound = true;
        recipientPhone = contacts[0].phone_e164;
        recipientSuppressed = contacts[0].suppressed_at !== null;
        recipientSmsConsent = contacts[0].sms_consent === true;
      }
    } catch {
      // Query failed: fail closed (contact not found, suppressed stays false, consent stays false).
    }

    // 5. Provider readiness from the SMS port adapter.
    let providerReady = false;
    try {
      providerReady = (await this.sms.isReady()).ready;
    } catch {
      // Provider check failed: fail closed.
    }

    // 6. Billing authorization: SMS billing is not approved until pricing and
    // reservation mechanisms are established. Wallet balance alone is not
    // sufficient billing authorization for SMS dispatch. Enable only for
    // synthetic test environments via W504_SMS_BILLING_AUTHORIZED=true.
    let billingAuthorized = process.env['W504_SMS_BILLING_AUTHORIZED'] === 'true';

    return {
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      voiceAttemptId: input.voiceAttemptId,
      recipientId,
      phoneE164: recipientPhone ?? '',
      message: approvedMessage ?? '',
      voiceOutcome,
      voiceTerminal,
      recipientContactFound,
      recipientSuppressed,
      recipientSmsConsent,
      organizationSmsEntitled,
      campaignSmsEnabled,
      campaignEmergencyStopped,
      providerReady,
      billingAuthorized,
      operationalStop: operationalStop || campaignEmergencyStopped,
    };
  }

  private async executeTransaction(input: SmsFallbackExecutionInput): Promise<SmsFallbackOutcome> {
    try {
      // Phase 1: Create the durable PENDING operation inside a short transaction.
      // No provider call happens inside the database transaction.
      const operation = await this.prisma.$transaction(async (tx) => {
        // Identity is per campaign recipient (max one fallback per recipient).
        // voiceAttemptId is retained for traceability only.
        const idempotencyKey = `${input.organizationId}:${input.campaignId}:${input.recipientId}`;

        // Serialize concurrent requests with the same idempotency key.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))::text`;

        // Check for an existing fallback operation (idempotency).
        // Use $queryRaw to avoid dependency on Prisma-generated compound where names.
        const existing = await tx.$queryRaw<{ id: string; status: string; provider_reference: string | null }[]>`
          SELECT id, status, provider_reference FROM sms_fallback_operations
          WHERE organization_id = ${input.organizationId}::uuid
            AND campaign_id = ${input.campaignId}::uuid
            AND recipient_id = ${input.recipientId}::uuid`;

        if (existing[0]) {
          const status = existing[0].status as string;
          if (status === 'PENDING') return { id: String(existing[0].id), status: 'already_pending', providerReference: null } as { id: string; status: string; providerReference: string | null };
          if (status === 'SENT') return { id: String(existing[0].id), status: 'already_sent', providerReference: String(existing[0].provider_reference) } as { id: string; status: string; providerReference: string | null };
          if (status === 'FAILED') return { id: String(existing[0].id), status: 'already_failed', providerReference: null } as { id: string; status: string; providerReference: string | null };
          if (status === 'UNCERTAIN') return { id: String(existing[0].id), status: 'already_uncertain', providerReference: null } as { id: string; status: string; providerReference: string | null };
          return { id: String(existing[0].id), status: 'already_pending', providerReference: null } as { id: string; status: string; providerReference: string | null };
        }

        // Create the fallback operation (claim).
        const created = await tx.smsFallbackOperation.create({
          data: {
            organizationId: input.organizationId,
            campaignId: input.campaignId,
            recipientId: input.recipientId,
            voiceAttemptId: input.voiceAttemptId,
            phoneE164: input.phoneE164,
            message: input.message,
            idempotencyKey,
            status: 'PENDING',
          },
        });

        // The created operation is PENDING by construction.
        return { id: String(created.id), status: 'PENDING', providerReference: null } as { id: string; status: string; providerReference: string | null };
      }) as { id: string; status: string; providerReference: string | null };

      // If an existing operation was found, return its status without calling the provider.
      if (operation.status !== 'PENDING') {
        return {
          status: operation.status as SmsFallbackOutcome['status'],
          fallbackId: operation.id,
          ...(operation.status === 'already_sent' && operation.providerReference
            ? { providerReference: operation.providerReference }
            : {}),
        } as SmsFallbackOutcome;
      }

      // Phase 2: Submit to the SMS provider OUTSIDE the database transaction.
      // This keeps the database transaction short and prevents holding locks
      // during network I/O. The PENDING row is durable evidence of the attempt.
      let providerReference: string | undefined;
      let accepted = false;
      let rejected = false;
      let uncertain: boolean;

      try {
        const result = await this.sms.send({
          to: input.phoneE164,
          body: input.message,
          idempotencyKey: `${input.organizationId}:${input.campaignId}:${input.recipientId}`,
          organizationId: input.organizationId,
          campaignId: input.campaignId,
          recipientId: input.recipientId,
        });
        providerReference = result.providerReference;
        accepted = result.accepted;
        rejected = result.rejected;
        uncertain = result.uncertain;
      } catch {
        // Provider timeout or exception: outcome is uncertain.
        uncertain = true;
      }

      // Phase 3: Update the operation status in a separate short transaction.
      return await this.prisma.$transaction(async (tx) => {
        if (uncertain) {
          await tx.smsFallbackOperation.update({
            where: { id: operation.id },
            data: { status: 'UNCERTAIN', providerReference: null, reconciled: false },
          });
          return { status: 'already_uncertain', fallbackId: operation.id };
        }

        if (rejected) {
          await tx.smsFallbackOperation.update({
            where: { id: operation.id },
            data: { status: 'FAILED', providerReference, reconciled: true },
          });
          return { status: 'already_failed', fallbackId: operation.id };
        }

        if (!accepted) {
          await tx.smsFallbackOperation.update({
            where: { id: operation.id },
            data: { status: 'UNCERTAIN', providerReference: null, reconciled: false },
          });
          return { status: 'already_uncertain', fallbackId: operation.id };
        }

        await tx.smsFallbackOperation.update({
          where: { id: operation.id },
          data: { status: 'SENT', providerReference, reconciled: true },
        });

        return { status: 'eligible_pending', fallbackId: operation.id };
      });
    } catch {
      return { status: 'retryable_conflict' };
    }
  }

  async getFallbackStatus(
    organizationId: string,
    campaignId: string,
    recipientId: string,
    voiceAttemptId: string,
  ): Promise<{ status: string; fallbackId: string | null } | null> {
    // Identity is per campaign recipient; voiceAttemptId retained for traceability.
    const existing = await this.prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM sms_fallback_operations
      WHERE organization_id = ${organizationId}::uuid
        AND campaign_id = ${campaignId}::uuid
        AND recipient_id = ${recipientId}::uuid`;
    if (!existing[0]) return null;
    return { status: String(existing[0].status), fallbackId: String(existing[0].id) };
  }
}
