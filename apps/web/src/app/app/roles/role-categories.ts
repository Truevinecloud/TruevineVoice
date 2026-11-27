/** Shared role-permission categories for the custom-role screens. */
export const ROLE_CATEGORIES = [
  { key: 'organization', label: 'Organization', permissions: ['organization:read', 'organization:update', 'ownership:transfer'] },
  { key: 'membership', label: 'Members & Invitations', permissions: ['member:read', 'member:invite', 'member:update', 'member:remove', 'invitation:read', 'invitation:revoke'] },
  { key: 'campaigns', label: 'Campaigns', permissions: ['campaign:read', 'campaign:create', 'campaign:update', 'campaign:delete'] },
  { key: 'audio', label: 'Audio', permissions: ['audio:read', 'audio:create'] },
  { key: 'contacts', label: 'Contacts', permissions: ['contact:read', 'contact:create', 'contact:update', 'contact:import'] },
  { key: 'billing', label: 'Billing & Wallet', permissions: ['billing:read', 'billing:update', 'wallet:read'] },
  { key: 'reporting', label: 'Reporting', permissions: ['reporting:read'] },
] as const;
