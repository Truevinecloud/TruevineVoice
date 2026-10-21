import { describe, expect, it } from 'vitest';
import { auditRequestId, withAuditRequest, AuditContextMiddleware } from './audit-context.js';
describe('audit correlation context', () => {
  it('isolates concurrent requests and discards context outside the operation', async () => {
    const values = await Promise.all(
      ['a', 'b'].map((id) =>
        withAuditRequest(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 10 : 1));
          return auditRequestId();
        }),
      ),
    );
    expect(values).toEqual(['a', 'b']);
    expect(auditRequestId()).toBeNull();
  });
  it('generates its own ID rather than trusting a client header', () => {
    let responseId = '';
    new AuditContextMiddleware().use(
      { headers: { 'x-request-id': 'forged' } } as never,
      {
        setHeader: (_name: string, value: string) => {
          responseId = value;
        },
      } as never,
      () => {
        expect(auditRequestId()).toBe(responseId);
      },
    );
    expect(responseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(responseId).not.toBe('forged');
  });
});
