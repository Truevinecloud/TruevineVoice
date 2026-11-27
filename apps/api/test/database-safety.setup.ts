import { loadEnvFiles } from '@truevine/shared';
import { assertApiE2EDatabase } from './disposable-database.js';

loadEnvFiles();

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl) {
  assertApiE2EDatabase(
    databaseUrl,
    process.env['NODE_ENV'],
    process.env['TRUEVINE_E2E_DISPOSABLE_DATABASE'],
  );
}
