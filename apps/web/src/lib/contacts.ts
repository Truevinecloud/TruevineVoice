import { request } from './api';

/** Public fields returned by the existing Contacts API. Phone is server-normalized. */
export interface Contact {
  readonly id: string;
  readonly phone: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly voiceConsent: 'RECORDED' | 'NOT_RECORDED';
  readonly voiceConsentAt: string | null;
  readonly suppressed: boolean;
  readonly suppressedAt: string | null;
  readonly groups?: readonly { readonly id: string; readonly name: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContactPage {
  readonly items: readonly Contact[];
  readonly nextCursor: string | null;
}

export function contactsPath(organizationId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/contacts`;
}

export function contactPath(organizationId: string, contactId: string): string {
  return `${contactsPath(organizationId)}/${encodeURIComponent(contactId)}`;
}

export function listContacts(organizationId: string, cursor?: string): Promise<ContactPage> {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  return request(`${contactsPath(organizationId)}?${query}`);
}

/** The API has no search parameter. Search all pages rather than just the visible page. */
export async function searchContacts(organizationId: string, query: string): Promise<ContactPage> {
  const items: Contact[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listContacts(organizationId, cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error('Repeated contact cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  const text = query.trim().toLocaleLowerCase();
  return {
    items: items.filter((item) =>
      [item.name, item.email, item.phone].some((value) =>
        value?.toLocaleLowerCase().includes(text),
      ),
    ),
    nextCursor: null,
  };
}

/** The reasons the API accepts when a contact is suppressed. */
export const SUPPRESSION_REASONS = [
  'user_opt_out',
  'operator_request',
  'invalid_number',
  'other',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_REASON_LABELS: Readonly<Record<SuppressionReason, string>> = {
  user_opt_out: 'The contact asked not to be called',
  operator_request: 'An operator decided to stop calling this contact',
  invalid_number: 'The number is invalid or unreachable',
  other: 'Another documented reason',
};

/**
 * The exact body `POST /contacts/:id/voice-consent` accepts.
 *
 * Every field is evidence the operator must supply. Nothing here is derived,
 * defaulted or inferred, and the API rejects extra or missing keys - consent is
 * never recorded on the application's behalf.
 */
export interface VoiceConsentEvidence {
  readonly consentedAt: string;
  readonly source: string;
  readonly purpose: 'voice_calling';
  readonly evidenceReference: string;
  readonly sourceVerified: true;
}

export function recordVoiceConsent(
  organizationId: string,
  contactId: string,
  evidence: VoiceConsentEvidence,
): Promise<Contact> {
  return request(`${contactPath(organizationId, contactId)}/voice-consent`, {
    method: 'POST',
    body: evidence,
  });
}

/** Suppression is recorded with a reason and cannot be reversed from this app. */
export function suppressContact(
  organizationId: string,
  contactId: string,
  reason: SuppressionReason,
): Promise<Contact> {
  return request(`${contactPath(organizationId, contactId)}/suppress`, {
    method: 'POST',
    body: { reason },
  });
}

/**
 * The API's source/evidence format: 3-128 characters beginning with an
 * alphanumeric, then alphanumerics or `._:-`. Mirrored here so the form can
 * explain the rule before a round trip, not to replace the server check.
 */
export const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export function isSafeReference(value: string): boolean {
  return SAFE_REFERENCE_PATTERN.test(value.trim());
}
