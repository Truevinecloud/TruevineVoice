import { assertW502DatabaseUrl } from './w5-02-test-database.js';

assertW502DatabaseUrl(process.env['DATABASE_URL'], process.env['NODE_ENV']);
