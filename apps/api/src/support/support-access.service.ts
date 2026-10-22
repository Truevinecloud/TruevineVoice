import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashToken } from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import type { Principal } from '../auth/principal.js';
import { SUPPORT_ACCESS_STORE } from './support-access.store.js';
import type { SupportAccessStore } from './support-access.store.js';

export const SUPPORT_ACCESS_TTL_MS = 15 * 60 * 1_000;
export const SUPPORT_ACCESS_REASON_CODES = [
  'CUSTOMER_REQUEST',
  'INCIDENT_RESPONSE',
  'SERVICE_DIAGNOSTIC',
  'SECURITY_REVIEW',
] as const;
export type SupportAccessReasonCode = (typeof SUPPORT_ACCESS_REASON_CODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{40,60}$/;

@Injectable()
export class SupportAccessService {
  constructor(
    @Inject(SUPPORT_ACCESS_STORE) private readonly store: SupportAccessStore,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  async start(
    principal: Principal,
    input: { readonly organizationId?: unknown; readonly reasonCode?: unknown },
    hasExistingContext: boolean,
  ) {
    const organizationId = input.organizationId;
    const reasonCode = input.reasonCode;
    if (principal.platformRole !== 'SUPPORT_ADMIN') {
      await this.denied(principal.userId, 'support_administrator_required');
      throw new ForbiddenException();
    }
    if (
      hasExistingContext ||
      typeof organizationId !== 'string' ||
      !UUID.test(organizationId) ||
      typeof reasonCode !== 'string' ||
      !SUPPORT_ACCESS_REASON_CODES.includes(reasonCode as SupportAccessReasonCode)
    ) {
      await this.denied(
        principal.userId,
        'invalid_request',
        typeof organizationId === 'string' && UUID.test(organizationId)
          ? organizationId
          : undefined,
      );
      throw new BadRequestException({
        error: {
          code: 'invalid_support_access_request',
          message: 'A valid organization and support reason are required.',
        },
      });
    }

    const now = new Date();
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const result = await this.store.create({
      id,
      organizationId,
      actorUserId: principal.userId,
      authSessionId: principal.sessionId,
      tokenHash: hashToken(token),
      reasonCode,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SUPPORT_ACCESS_TTL_MS),
    });
    if (result === 'not_found') {
      await this.denied(principal.userId, 'organization_not_found', organizationId);
      throw new NotFoundException();
    }
    if (result !== 'created') {
      await this.denied(principal.userId, 'operator_authorization_changed', organizationId);
      throw new ForbiddenException();
    }

    return {
      supportSessionId: id,
      organizationId,
      reasonCode,
      expiresAt: new Date(now.getTime() + SUPPORT_ACCESS_TTL_MS).toISOString(),
      supportAccessToken: token,
    };
  }

  async resolve(principal: Principal, token: unknown) {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      await this.denied(principal.userId, 'missing_or_malformed_context');
      throw new ForbiddenException();
    }
    const result = await this.store.resolve({
      tokenHash: hashToken(token),
      actorUserId: principal.userId,
      authSessionId: principal.sessionId,
      now: new Date(),
    });
    if (result.kind !== 'active') {
      await this.denied(
        principal.userId,
        result.kind === 'expired' ? 'expired_context' : 'invalid_or_revoked_context',
      );
      throw new ForbiddenException();
    }
    return result.context;
  }

  async end(principal: Principal, token: unknown) {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      await this.denied(principal.userId, 'missing_or_malformed_context');
      throw new ForbiddenException();
    }
    const result = await this.store.revoke({
      tokenHash: hashToken(token),
      actorUserId: principal.userId,
      authSessionId: principal.sessionId,
      now: new Date(),
    });
    if (result === 'invalid') {
      await this.denied(principal.userId, 'invalid_or_revoked_context');
      throw new NotFoundException();
    }
    return { ended: result === 'revoked' };
  }

  private async denied(actorUserId: string, reason: string, organizationId?: string) {
    try {
      await this.audit.recordIdentity({
        actorUserId,
        action: 'platform.support.access_denied',
        outcome: 'DENIED',
        metadata: { reason, ...(organizationId ? { organizationId } : {}) },
      });
    } catch {
      process.stderr.write('[support-access] Denial audit unavailable.\n');
    }
  }
}
