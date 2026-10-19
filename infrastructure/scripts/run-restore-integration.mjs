import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  process.stderr.write(
    'Restore integration requires a GitHub-hosted Ubuntu runner; Docker is not installed or contacted locally.\n',
  );
  process.exit(1);
}

const result = spawnSync(
  'bash',
  [fileURLToPath(new URL('./restore-integration.sh', import.meta.url)), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
