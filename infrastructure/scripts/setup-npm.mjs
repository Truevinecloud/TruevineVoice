import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const expectedNode = readFileSync('.nvmrc', 'utf8').trim();
if (process.version !== `v${expectedNode}`) throw new Error('Node must match .nvmrc exactly');
const expectedNpm = JSON.parse(readFileSync('package.json', 'utf8')).packageManager.split('@')[1];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command through npm run ci:setup-npm');
const options = { encoding: 'utf8' };
const npm = (...args) => execFileSync(process.execPath, [npmCli, ...args], options);
if (npm('--version').trim() !== expectedNpm) {
  execFileSync(process.execPath, [npmCli, 'install', '--global', `npm@${expectedNpm}`], {
    ...options,
    stdio: 'inherit',
  });
}
if (npm('--version').trim() !== expectedNpm) throw new Error('npm version setup failed');
process.stdout.write(`Runtime verified: ${process.version}, npm ${expectedNpm}\n`);
