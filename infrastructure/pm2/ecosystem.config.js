const path = require('node:path');
const fs = require('node:fs');

const release = path.resolve(__dirname, '../..');
const sha = fs.readFileSync(path.join(release, 'REVISION'), 'utf8').trim();
const config = JSON.parse(fs.readFileSync('/var/www/TruevineVoice/deployment.json', 'utf8'));
const common = {
  interpreter: process.execPath,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  min_uptime: '10s',
  max_restarts: 5,
  restart_delay: 2000,
  kill_timeout: 10000,
  time: true,
  env: {
    NODE_ENV: 'production',
    APP_VERSION: sha,
    API_HOST: '127.0.0.1',
    API_PORT: String(config.apiPort),
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'truevine-web',
      cwd: path.join(release, 'apps/web'),
      script: path.join(release, 'node_modules/next/dist/bin/next'),
      args: 'start --hostname 127.0.0.1 --port 3000',
    },
    {
      ...common,
      name: 'truevine-admin',
      cwd: path.join(release, 'apps/admin'),
      script: path.join(release, 'node_modules/next/dist/bin/next'),
      args: 'start --hostname 127.0.0.1 --port 3002',
    },
    {
      ...common,
      name: 'truevine-api',
      cwd: path.join(release, 'apps/api'),
      script: 'dist/main.js',
    },
    {
      ...common,
      name: 'truevine-worker',
      cwd: path.join(release, 'apps/worker'),
      script: 'dist/main.js',
    },
  ],
};
