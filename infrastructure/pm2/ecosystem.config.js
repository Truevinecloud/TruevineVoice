const path = require('node:path');
const fs = require('node:fs');
const { buildApps } = require('./ecosystem.apps.js');

const release = path.resolve(__dirname, '../..');
const sha = fs.readFileSync(path.join(release, 'REVISION'), 'utf8').trim();
const config = JSON.parse(fs.readFileSync('/var/www/TruevineVoice/deployment.json', 'utf8'));

module.exports = { apps: buildApps(release, sha, config) };
