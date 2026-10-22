import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { canActAsPlatform } from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import { PRINCIPAL, type AuthenticatedRequest } from '../auth/principal.js';
import { SupportAccessService } from './support-access.service.js';

@Injectable()
export class SupportAccessGuard implements CanActivate {
  constructor(
    @Inject(SupportAccessService) private readonly access: SupportAccessService,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL];
    if (!principal) throw new ForbiddenException();
    const raw = request.headers?.['x-support-access-token'];
    const token = typeof raw === 'string' ? raw : undefined;
    const accessContext = await this.access.resolve(principal, token);
    if (
      principal.platformRole !== 'SUPPORT_ADMIN' ||
      !canActAsPlatform(principal.platformRole, 'platform:support:access') ||
      !canActAsPlatform(principal.platformRole, 'platform:support:diagnostics')
    ) {
      await this.deny(principal.userId, 'diagnostics_permission_missing');
      throw new ForbiddenException();
    }
    const requestedOrganizationId = request.params?.['organizationId'];
    if (requestedOrganizationId !== accessContext.organizationId) {
      await this.deny(principal.userId, 'organization_scope_mismatch');
      throw new ForbiddenException();
    }
    request.supportAccessContext = accessContext;
    return true;
  }

  private async deny(actorUserId: string, reason: string) {
    try {
      await this.audit.recordIdentity({
        actorUserId,
        action: 'platform.support.access_denied',
        outcome: 'DENIED',
        metadata: { reason },
      });
    } catch {
      process.stderr.write('[support-access] Denial audit unavailable.\n');
    }
  }
}
