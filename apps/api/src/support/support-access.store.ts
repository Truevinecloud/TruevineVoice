import type { SupportAccessContext } from '../auth/principal.js';

export type { SupportAccessContext } from '../auth/principal.js';

export interface NewSupportAccessSession {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly authSessionId: string;
  readonly tokenHash: string;
  readonly reasonCode: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type SupportAccessResolution =
  | { readonly kind: 'active'; readonly context: SupportAccessContext }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' };

export interface SupportAccessStore {
  create(input: NewSupportAccessSession): Promise<'created' | 'not_found' | 'unauthorized'>;
  resolve(input: {
    readonly tokenHash: string;
    readonly actorUserId: string;
    readonly authSessionId: string;
    readonly now: Date;
  }): Promise<SupportAccessResolution>;
  revoke(input: {
    readonly tokenHash: string;
    readonly actorUserId: string;
    readonly authSessionId: string;
    readonly now: Date;
  }): Promise<'revoked' | 'expired' | 'invalid'>;
}

export const SUPPORT_ACCESS_STORE = Symbol('SUPPORT_ACCESS_STORE');
