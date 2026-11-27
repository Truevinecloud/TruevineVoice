import { describe, expect, it } from 'vitest';

/**
 * Replicates the workflow-level host validation from deploy.yml:
 *   test "$SSH_HOST" = '77.216.129.196'
 */
function validateSshHost(host: string): void {
  if (host !== '77.216.129.196') {
    throw new Error(`Unauthorized VPS host: ${host}`);
  }
}

/**
 * Replicates the workflow-level user validation from deploy.yml:
 *   [[ "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] && test "$SSH_USER" != root
 */
function validateSshUser(user: string): void {
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
    throw new Error(`Invalid SSH user: ${user}`);
  }
  if (user === 'root') {
    throw new Error('Root deployment is prohibited');
  }
}

/**
 * Replicates the workflow-level SHA validation from deploy.yml:
 *   [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
 */
function validateReleaseSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error(`Invalid release SHA: ${sha}`);
  }
}

/**
 * Replicates the workflow-level port validation from deploy.yml:
 *   [[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]]
 */
function validateSshPort(port: string): void {
  if (!/^[0-9]{1,5}$/.test(port)) {
    throw new Error(`Invalid SSH port: ${port}`);
  }
}

/**
 * Replicates the workflow-level credential presence check from deploy.yml:
 *   test -n "$SSH_KEY" && test -n "$SSH_KNOWN_HOSTS"
 */
function validateCredentials(key: string, knownHosts: string): void {
  if (!key || key.length === 0) {
    throw new Error('Missing SSH key');
  }
  if (!knownHosts || knownHosts.length === 0) {
    throw new Error('Missing SSH known_hosts');
  }
}

/**
 * Replicates the workflow-level DEPLOYMENT_READY gate from deploy.yml:
 *   vars.DEPLOYMENT_READY == 'true'
 */
function checkDeploymentReady(value: string): void {
  if (value !== 'true') {
    throw new Error('DEPLOYMENT_READY is not true; deployment blocked');
  }
}

/**
 * Replicates the workflow-level manual authorization from deploy.yml:
 *   inputs.authorize_production == true
 */
function checkProductionAuthorization(authorized: boolean): void {
  if (authorized !== true) {
    throw new Error('Production deployment not explicitly authorized');
  }
}

describe('deployment security — behavioral host validation', () => {
  it('accepts the new Contabo VPS IP 77.216.129.196', () => {
    expect(() => validateSshHost('77.216.129.196')).not.toThrow();
  });

  it('rejects the previous VPS IP 169.58.162.143', () => {
    expect(() => validateSshHost('169.58.162.143')).toThrow(/Unauthorized VPS host/);
  });

  it('rejects an arbitrary incorrect IP', () => {
    expect(() => validateSshHost('192.0.2.1')).toThrow(/Unauthorized VPS host/);
    expect(() => validateSshHost('10.0.0.1')).toThrow(/Unauthorized VPS host/);
    expect(() => validateSshHost('8.8.8.8')).toThrow(/Unauthorized VPS host/);
  });

  it('rejects an empty host', () => {
    expect(() => validateSshHost('')).toThrow(/Unauthorized VPS host/);
  });

  it('rejects a non-IP host value', () => {
    expect(() => validateSshHost('voice.truevinecloud.online')).toThrow(/Unauthorized VPS host/);
    expect(() => validateSshHost('localhost')).toThrow(/Unauthorized VPS host/);
  });
});

describe('deployment security — behavioral user validation', () => {
  it('accepts a valid non-root deploy user', () => {
    expect(() => validateSshUser('truevine-deploy')).not.toThrow();
  });

  it('rejects root as deployment user', () => {
    expect(() => validateSshUser('root')).toThrow(/Root deployment is prohibited/);
  });

  it('rejects invalid usernames', () => {
    expect(() => validateSshUser('Root')).toThrow(/Invalid SSH user/);
    expect(() => validateSshUser('123user')).toThrow(/Invalid SSH user/);
    expect(() => validateSshUser('user@host')).toThrow(/Invalid SSH user/);
    expect(() => validateSshUser('')).toThrow(/Invalid SSH user/);
  });
});

describe('deployment security — behavioral release SHA validation', () => {
  const validSha = '630c97eb91d6daf3411e12637e15edcebcfdc088';

  it('accepts a valid 40-character lowercase hex SHA', () => {
    expect(() => validateReleaseSha(validSha)).not.toThrow();
  });

  it('rejects a short SHA', () => {
    expect(() => validateReleaseSha('630c97eb')).toThrow(/Invalid release SHA/);
  });

  it('rejects an uppercase SHA', () => {
    expect(() => validateReleaseSha(validSha.toUpperCase())).toThrow(/Invalid release SHA/);
  });

  it('rejects a SHA with non-hex characters', () => {
    expect(() => validateReleaseSha('g'.repeat(40))).toThrow(/Invalid release SHA/);
  });

  it('rejects an empty SHA', () => {
    expect(() => validateReleaseSha('')).toThrow(/Invalid release SHA/);
  });

  it('rejects a SHA that is too long', () => {
    expect(() => validateReleaseSha('a'.repeat(41))).toThrow(/Invalid release SHA/);
  });
});

describe('deployment security — behavioral port validation', () => {
  it('accepts port 22', () => {
    expect(() => validateSshPort('22')).not.toThrow();
  });

  it('accepts valid port range', () => {
    expect(() => validateSshPort('1')).not.toThrow();
    expect(() => validateSshPort('65535')).not.toThrow();
  });

  it('rejects invalid ports', () => {
    expect(() => validateSshPort('')).toThrow(/Invalid SSH port/);
    expect(() => validateSshPort('abc')).toThrow(/Invalid SSH port/);
    expect(() => validateSshPort('999999')).toThrow(/Invalid SSH port/);
    expect(() => validateSshPort('-1')).toThrow(/Invalid SSH port/);
  });
});

describe('deployment security — behavioral credential validation', () => {
  it('accepts non-empty key and known_hosts', () => {
    expect(() => validateCredentials('some-key-data', 'some-known-hosts-data')).not.toThrow();
  });

  it('rejects missing SSH key', () => {
    expect(() => validateCredentials('', 'some-known-hosts-data')).toThrow(/Missing SSH key/);
  });

  it('rejects missing known_hosts', () => {
    expect(() => validateCredentials('some-key-data', '')).toThrow(/Missing SSH known_hosts/);
  });

  it('rejects both missing', () => {
    expect(() => validateCredentials('', '')).toThrow(/Missing SSH key/);
  });
});

describe('deployment security — behavioral DEPLOYMENT_READY gate', () => {
  it('passes when DEPLOYMENT_READY is true', () => {
    expect(() => checkDeploymentReady('true')).not.toThrow();
  });

  it('blocks when DEPLOYMENT_READY is false', () => {
    expect(() => checkDeploymentReady('false')).toThrow(/DEPLOYMENT_READY is not true/);
  });

  it('blocks when DEPLOYMENT_READY is unset', () => {
    expect(() => checkDeploymentReady('')).toThrow(/DEPLOYMENT_READY is not true/);
  });

  it('blocks when DEPLOYMENT_READY is not the literal string true', () => {
    expect(() => checkDeploymentReady('True')).toThrow(/DEPLOYMENT_READY is not true/);
    expect(() => checkDeploymentReady('TRUE')).toThrow(/DEPLOYMENT_READY is not true/);
    expect(() => checkDeploymentReady('1')).toThrow(/DEPLOYMENT_READY is not true/);
  });
});

describe('deployment security — behavioral production authorization', () => {
  it('passes when production is explicitly authorized', () => {
    expect(() => checkProductionAuthorization(true)).not.toThrow();
  });

  it('blocks when production is not authorized', () => {
    expect(() => checkProductionAuthorization(false)).toThrow(/Production deployment not explicitly authorized/);
  });
});
