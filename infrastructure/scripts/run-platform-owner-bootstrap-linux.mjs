// Explicit Linux evidence gate; never silently substitutes Windows refusal tests.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform !== 'linux' || !process.env.npm_execpath) {
  process.stderr.write('Bootstrap Linux validation requires Linux and the root npm command.\n');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '../..');
const commands = [
  [process.env.npm_execpath, 'run', 'test:platform-owner-bootstrap:unit'],
  [process.env.npm_execpath, 'run', 'test:platform-owner-bootstrap:e2e'],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
