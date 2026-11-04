import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { assertKnownAuditAction, isSafeAuditMetadata, type PlatformRole, PLATFORM_ROLES } from '@truevine/auth';

import { AUDIT_STORE } from '../auth/tokens.js';
import type { AuditStore } from '../auth/auth.store.js';
import { PLATFORM_ADMIN_STORE } from './tokens.js';
import type { PlatformAdminStore } from './platform-admin.store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

@Injectable()
export class PlatformAdminService {
  constructor(
    @Inject(PLATFORM_ADMIN_STORE) private readonly store: PlatformAdminStore,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  operatorContext(platformRole: PlatformRole | null) {
    return { platformRole };
  }

  async listAssignments(actorUserId: string) {
    const assignments = await this.store.listAssignments();
    await this.recordIdentity(actorUserId, 'platform.admin.roles_viewed', {});
    return assignments.map((assignment) => ({
      userId: assignment.userId,
      email: assignment.email,
      status: assignment.status,
      role: assignment.role,
      grantedByUserId: assignment.grantedByUserId,
      grantedAt: assignment.grantedAt.toISOString(),
      revokedAt: assignment.revokedAt?.toISOString() ?? null,
    }));
  }

  async searchUsers(actorUserId: string, rawQuery: unknown) {
    if (typeof rawQuery !== 'string') invalid('invalid_query', 'A search query is required.');
    const query = rawQuery.trim();
    if (query.length < 3 || query.length > 200) {
      invalid('invalid_query', 'Enter between 3 and 200 characters to search users.');
    }
    if (/[\\%_]/.test(query)) {
      invalid('invalid_query', 'Wildcards are not supported.');
    }
    const users = await this.store.searchEligibleUsers(query);
    await this.recordIdentity(actorUserId, 'platform.admin.users_searched', { count: users.length });
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      status: user.status,
      platformRole: user.platformRole,
    }));
  }

  async grantRole(actorUserId: string, rawUserId: unknown, rawRole: unknown) {
    if (typeof rawUserId !== 'string' || !UUID.test(rawUserId)) {
      invalid('invalid_user_id', 'A valid user id is required.');
    }
    if (typeof rawRole !== 'string' || !(PLATFORM_ROLES as readonly string[]).includes(rawRole)) {
      invalid('invalid_role', 'A valid platform role is required.');
    }
    const user = await this.store.findUser(rawUserId);
    if (!user) throw new NotFoundException();
    if (user.status !== 'ACTIVE') {
      invalid('user_not_active', 'Platform roles can only be granted to active users.');
    }
    const assignment = await this.store.grantRole({
      userId: rawUserId,
      role: rawRole as PlatformRole,
      grantedByUserId: actorUserId,
    });
    await this.recordIdentity(actorUserId, 'platform.admin.role_granted', {
      targetUserId: rawUserId,
      role: rawRole,
    });
    return {
      userId: assignment.userId,
      email: assignment.email,
      status: assignment.status,
      role: assignment.role,
      grantedByUserId: assignment.grantedByUserId,
      grantedAt: assignment.grantedAt.toISOString(),
      revokedAt: assignment.revokedAt?.toISOString() ?? null,
    };
  }

  async revokeRole(actorUserId: string, rawUserId: unknown) {
    if (typeof rawUserId !== 'string' || !UUID.test(rawUserId)) {
      invalid('invalid_user_id', 'A valid user id is required.');
    }
    const result = await this.store.revokeRole(rawUserId);
    if (result === 'not_found') throw new NotFoundException();
    if (result === 'last_owner') {
      throw new ConflictException({
        error: { code: 'last_platform_owner', message: 'The last active platform owner cannot be removed.' },
      });
    }
    await this.recordIdentity(actorUserId, 'platform.admin.role_revoked', {
      targetUserId: rawUserId,
    });
    return { userId: rawUserId, revoked: true };
  }

  private async recordIdentity(
    actorUserId: string,
    action: 'platform.admin.roles_viewed' | 'platform.admin.role_granted' | 'platform.admin.role_revoked' | 'platform.admin.users_searched',
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }
    await this.audit.recordIdentity({ actorUserId, action, outcome: 'SUCCESS', metadata });
  }
}
