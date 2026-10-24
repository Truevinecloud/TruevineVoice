import type { KeyObject } from 'node:crypto';

export function ownerAuthorizationPayload(approval: Record<string, unknown>): Buffer;
export function ownerAuthorizationKeyId(publicKey: KeyObject): string;
export function signOwnerAuthorization(
  approval: Record<string, any>,
  privateKey: KeyObject | Buffer | string,
  options?: { allowTest?: boolean },
): Record<string, any>;
export function readPinnedOwnerPublicKey(): Buffer;
export function verifyOwnerAuthorization(
  approval: Record<string, any>,
  environment: NodeJS.ProcessEnv,
  now?: number,
  pinnedPublicKeyDer?: Buffer,
): { keyId: string; digest: string } | undefined;
export function signOwnerApprovalFile(argv: string[]): Promise<{
  action: string;
  keyId: string;
  publicKeyDer: string;
  outputPath: string;
}>;
