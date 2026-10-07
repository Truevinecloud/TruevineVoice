/**
 * Static description of this application.
 *
 * `apps/admin` is a deliberately separate frontend for Truevine Voice's own
 * internal operators. It is NOT the in-app dashboard of a customer
 * organization: it is not tenant-scoped and has no end-user login yet.
 */
export const ADMIN_APP_INFO = {
  product: 'Truevine Voice',
  surface: 'Platform admin application',
  audience: 'Truevine Voice internal operators',
} as const;
