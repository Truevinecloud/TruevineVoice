export interface BootstrapOptions {
  environment: string;
  email: string;
  operationId: string;
  approvalFile: string;
  activationDirectory: string;
  confirmProduction?: boolean;
}
export interface ActivationArtifact {
  operationId: string;
  email: string;
  expiresAt: string;
  activationUrl: string;
}
export interface ArtifactHandle {
  path: string;
  discard(): void;
}
export interface BootstrapTransaction {
  $queryRaw(strings: TemplateStringsArray): Promise<Array<{ name: string }>>;
  platformOwnerBootstrap: {
    findUnique(args: { where: { slot: string } }): Promise<unknown>;
    create(args: {
      data: { slot: string; operationId: string; userId: string; auditEventId: string };
    }): Promise<unknown>;
  };
  platformRoleAssignment: {
    findFirst(args: { where: { role: string } }): Promise<unknown>;
    create(args: { data: { userId: string; role: string } }): Promise<unknown>;
  };
  user: {
    findUnique(args: { where: { email: string }; select: { id: boolean } }): Promise<unknown>;
    create(args: { data: { id: string; email: string; passwordHash: string } }): Promise<unknown>;
  };
  passwordResetToken: {
    create(args: {
      data: { userId: string; tokenHash: string; expiresAt: Date };
    }): Promise<unknown>;
  };
  identityAuditEvent: {
    create(args: {
      data: {
        id: string;
        actorUserId: string;
        action: string;
        outcome: string;
        metadata: Record<string, string>;
      };
    }): Promise<unknown>;
  };
}
export interface BootstrapClient {
  $transaction(
    work: (tx: BootstrapTransaction) => Promise<void>,
    options: { isolationLevel: 'Serializable' },
  ): Promise<void>;
  $disconnect(): Promise<void>;
}
export interface BootstrapDependencies {
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  readApproval?: (path: string) => unknown;
  prepareArtifact?: (
    directory: string,
    operationId: string,
    payload: ActivationArtifact,
  ) => ArtifactHandle;
  createClient?: (url: string, options: { log: Array<'warn' | 'error'> }) => BootstrapClient;
  hashPassword?: (material: string) => Promise<string>;
}
export const BOOTSTRAP_SLOT: 'first_platform_owner';
export const BOOTSTRAP_ACTION: 'platform.owner.bootstrapped';
export class BootstrapRefusal extends Error {
  code: string;
  constructor(code: string);
}
export function bootstrapPlatformOwner(
  options: BootstrapOptions,
  dependencies?: BootstrapDependencies,
): Promise<{
  operationId: string;
  userId: string;
  activationFile: string;
  activationExpiresAt: string;
}>;
export function validateBootstrapApproval(
  options: BootstrapOptions,
  environment: Record<string, string | undefined>,
  approval: unknown,
  now?: Date,
): { email: string; databaseName: string; applicationOrigin: string; systemIdentifier?: string };
export function assertPrivateStat(
  stat: { uid: number; mode: number; nlink: number; isDirectory(): boolean; isFile(): boolean },
  uid: number,
  directory: boolean,
): void;
export function readBootstrapApproval(path: string): unknown;
export function prepareBootstrapArtifact(
  directory: string,
  operationId: string,
  payload: ActivationArtifact,
): ArtifactHandle;
export function main(
  argv?: string[],
  environment?: Record<string, string | undefined>,
  dependencies?: BootstrapDependencies,
): Promise<void>;
