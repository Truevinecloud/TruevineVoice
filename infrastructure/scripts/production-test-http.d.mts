export interface PrivateHttpClient {
  call(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }>;
  hasCsrf(): boolean;
  hasSecureSession(): boolean;
  snapshot(): () => Promise<void>;
}
export function privateHttpClient(origin: string, transport?: typeof fetch, controls?: { expiresAt?: string; intervalMs?: number }): PrivateHttpClient;
export function executePrivateHttp(approval: unknown, credentials: unknown, options?: unknown, dependencies?: unknown): Promise<{
  operationId: string;
  ownerInitialized?: boolean;
  accounts?: readonly { email: string; role: string; httpSignIn: string }[];
  mutationCoverage?: string;
  limitations?: readonly string[];
}>;
