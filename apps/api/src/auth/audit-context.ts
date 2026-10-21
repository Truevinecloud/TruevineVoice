import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

const context = new AsyncLocalStorage<string>();
export function auditRequestId(): string | null {
  return context.getStore() ?? null;
}
export function withAuditRequest<T>(id: string, work: () => T): T {
  return context.run(id, work);
}
/** Server-generated identity; an unverified incoming header cannot forge correlation. */
@Injectable()
export class AuditContextMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    const id = randomUUID();
    response.setHeader('x-request-id', id);
    withAuditRequest(id, next);
  }
}
