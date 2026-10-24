import { request } from './api';
import type { ContactPage } from './contacts';

export interface ContactGroup {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly memberCount: number;
}
export function groupsPath(organizationId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/contact-groups`;
}
export function groupPath(organizationId: string, groupId: string): string {
  return `${groupsPath(organizationId)}/${encodeURIComponent(groupId)}`;
}
export function groupMembers(
  organizationId: string,
  groupId: string,
  cursor?: string,
): Promise<ContactPage> {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  return request(`${groupPath(organizationId, groupId)}/contacts?${query}`);
}
