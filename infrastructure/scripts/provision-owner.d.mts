/**
 * Type declarations for `provision-owner.mjs`.
 *
 * The provisioning script is plain JavaScript on purpose: it is operator tooling
 * run directly by Node, and giving it a build step would mean a compiled artefact
 * an operator might run that is older than the source they read. These
 * declarations exist only so the end-to-end test can import it with types.
 */

export declare const PROVISION_REFUSALS: {
  readonly invalidEmail: 'invalid_email';
  readonly invalidSlug: 'invalid_slug';
  readonly emailAlreadyRegistered: 'email_already_registered';
  readonly organizationAlreadyHasMembers: 'organization_already_has_members';
};

export type ProvisionRefusal =
  | 'invalid_email'
  | 'invalid_slug'
  | 'email_already_registered'
  | 'organization_already_has_members';

export type ProvisionOutcome =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly organizationId: string;
      readonly organizationSlug: string;
      readonly organizationCreated: boolean;
      readonly activationFile: string;
      readonly activationExpiresAt: Date;
    }
  | { readonly ok: false; readonly reason: ProvisionRefusal; readonly detail: string };

export interface ProvisionOptions {
  readonly email: string;
  readonly organizationSlug: string;
  readonly organizationName?: string;
  readonly activationDirectory: string;
  readonly applicationBaseUrl: string;
}

export interface ProvisionDependencies {
  readonly databaseUrl: string;
}

export declare function provisionOwner(
  options: ProvisionOptions,
  dependencies: ProvisionDependencies,
): Promise<ProvisionOutcome>;

export declare function defaultActivationDirectory(baseDirectory?: string): string;
