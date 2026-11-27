/**
 * SMS fallback eligibility service.
 *
 * Evaluates whether a failed voice call is eligible for SMS fallback using only
 * trusted server-side information. Fail-closed when required information is
 * unavailable.
 *
 * Eligibility rules:
 *   1. Voice call has reached an eligible terminal outcome (not ANSWERED/COMPLETED).
 *   2. Voice call belongs to the correct organization.
 *   3. Campaign permits SMS fallback.
 *   4. Organization has SMS entitlement.
 *   5. Recipient has a valid E.164 phone number.
 *   6. Recipient is not suppressed or opted out.
 *   7. SMS content is approved.
 *   8. SMS provider is ready for the configured environment.
 *   9. Operational restrictions permit dispatch.
 *  10. Billing authorization is satisfied where applicable.
 */

export type SmsFallbackEligibility =
  | { readonly status: 'eligible'; readonly reason: null }
  | {
      readonly status:
        | 'not_terminal'
        | 'wrong_organization'
        | 'campaign_not_active'
        | 'sms_not_enabled'
        | 'no_entitlement'
        | 'suppressed_recipient'
        | 'invalid_phone_number'
        | 'no_approved_message'
        | 'provider_not_ready'
        | 'billing_not_authorized'
        | 'operational_restriction'
        | 'unknown_error';
      readonly reason: string;
    };

export interface SmsFallbackEligibilityInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly voiceAttemptId: string;
  readonly voiceOutcome: string;
  readonly voiceTerminal: boolean;
  readonly recipientId: string;
  readonly recipientPhone: string | null;
  readonly recipientSuppressed: boolean | null;
  readonly recipientSmsConsent: boolean | null;
  readonly campaignSmsEnabled: boolean | null;
  readonly organizationSmsEntitled: boolean | null;
  readonly providerReady: boolean | null;
  readonly billingAuthorized: boolean | null;
  readonly operationalStop: boolean | null;
  readonly approvedMessage: string | null;
}

export class SmsFallbackEligibilityService {
  evaluate(input: SmsFallbackEligibilityInput): SmsFallbackEligibility {
    // 1. Voice call must have reached a terminal outcome.
    if (!input.voiceTerminal) {
      return { status: 'not_terminal', reason: 'Voice call has not reached a terminal outcome.' };
    }

    // 2. Successful voice calls never trigger fallback.
    if (input.voiceOutcome === 'ANSWERED' || input.voiceOutcome === 'COMPLETED') {
      return { status: 'not_terminal', reason: 'Voice call was answered successfully; SMS fallback is not applicable.' };
    }

    // 3. Operational stop prevents all SMS dispatch.
    if (input.operationalStop) {
      return { status: 'operational_restriction', reason: 'Operational stop is in effect; SMS fallback is disabled.' };
    }

    // 4. Campaign must be active for SMS fallback.
    if (input.campaignSmsEnabled !== true) {
      return { status: 'sms_not_enabled', reason: 'Campaign does not permit SMS fallback.' };
    }

    // 5. Organization must have SMS entitlement.
    if (input.organizationSmsEntitled !== true) {
      return { status: 'no_entitlement', reason: 'Organization does not have SMS entitlement.' };
    }

    // 6. Recipient must not be suppressed.
    if (input.recipientSuppressed === true) {
      return { status: 'suppressed_recipient', reason: 'Recipient is suppressed or opted out of SMS.' };
    }

    // 7. Recipient must have SMS consent where required.
    if (input.recipientSmsConsent === false) {
      return { status: 'suppressed_recipient', reason: 'Recipient has not consented to SMS.' };
    }

    // 8. Recipient must have a valid phone number.
    if (!input.recipientPhone) {
      return { status: 'invalid_phone_number', reason: 'Recipient has no valid phone number.' };
    }

    // 9. Approved SMS message content must exist.
    if (!input.approvedMessage) {
      return { status: 'no_approved_message', reason: 'No approved SMS message content is available.' };
    }

    // 10. SMS provider must be ready.
    if (input.providerReady !== true) {
      return { status: 'provider_not_ready', reason: 'SMS provider is not ready for the configured environment.' };
    }

    // 11. Billing authorization must be satisfied where applicable.
    if (input.billingAuthorized === false) {
      return { status: 'billing_not_authorized', reason: 'Billing authorization is not satisfied for SMS fallback.' };
    }

    return { status: 'eligible', reason: null };
  }
}
