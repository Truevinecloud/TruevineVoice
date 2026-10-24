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
