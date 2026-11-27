import { assertW503DatabaseUrl } from './w5-03-test-database.js';

assertW503DatabaseUrl(process.env['DATABASE_URL'], process.env['NODE_ENV']);
