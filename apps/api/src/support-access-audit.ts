import { Logger } from '@nestjs/common';

/** Emit a structured server-side alert while keeping the attempted action denied. */
export function reportSupportAccessAuditFailure(actorUserId: string, reasonCode: string): void {
  const event = JSON.stringify({
    event: 'support_access_denial_audit_failed',
    actorUserId,
    reasonCode,
    occurredAt: new Date().toISOString(),
  });
  try {
    new Logger('SupportAccess').error(event);
  } catch {
    // Keep a last-resort runtime signal if the configured Nest logger itself fails.
    process.stderr.write(`${event}\n`);
  }
}
