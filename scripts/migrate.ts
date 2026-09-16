import { createDb } from '../server/db';
import { migrate } from '../server/migrations';
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL wajib diisi.');
const db = createDb(url);
try {
  if (process.argv.includes('--status')) {
    console.table(await db`SELECT name, applied_at FROM schema_migrations ORDER BY name`);
  } else {
    for (const result of await migrate(db)) console.log(`${result.applied ? 'Diterapkan' : 'Sudah diterapkan'}: ${result.name}`);
  }
} finally { await db.close(); }
