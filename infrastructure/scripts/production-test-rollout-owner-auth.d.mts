import type { KeyObject } from 'node:crypto';

export interface OwnerAuthorization {
  algorithm: 'Ed25519';
  keyId: string;
  signature: string;
}
export type OwnerApproval = Record<string, unknown> & { ownerAuthorization?: OwnerAuthorization };
export type SignedOwnerApproval = Record<string, unknown> & { ownerAuthorization: OwnerAuthorization };

export function ownerAuthorizationPayload(approval: Record<string, unknown>): Buffer;
export function ownerAuthorizationKeyId(publicKey: KeyObject): string;
export function signOwnerAuthorization(
  approval: OwnerApproval,
  privateKey: KeyObject | Buffer | string,
  options?: { allowTest?: boolean },
): SignedOwnerApproval;
export function readPinnedOwnerPublicKey(): Buffer;
export function verifyOwnerAuthorization(
  approval: OwnerApproval,
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
