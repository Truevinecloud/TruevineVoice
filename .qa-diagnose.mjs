import { loadEnvFiles } from '@truevine/shared';
import { grantLocalPlatformOwner } from './infrastructure/scripts/grant-local-platform-owner.mjs';

loadEnvFiles();

try {
  const result = await grantLocalPlatformOwner({
    approval: {
      approved: true,
      approvalReference: 'LOCAL-OWNER-AUTHORIZED-20261119',
      operatorReference: 'OPENCODE-LOCAL-OPERATOR',
    },
  });
  process.stdout.write(
    `platform owner: ${result.status}; login: ${result.loginVerified ? 'verified' : 'failed'}; ` +
      `settings access: ${result.settingsVerified ? 'verified' : 'failed'}\n`,
  );
} catch (error) {
  const safeMessage = typeof error?.message === 'string' ? error.message : 'unknown error';
  process.stderr.write(`diagnostic: ${error?.name ?? 'Error'}: ${safeMessage}\n`);
  process.exitCode = 1;
}
