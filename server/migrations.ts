import type { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function migrate(db: SQL, directory = resolve(import.meta.dir, '../database/migrations')) {
  // A reserved connection holds the session advisory lock across all migrations.
  const connection = await db.reserve();
  try {
    await connection`SELECT pg_advisory_lock(884281)`;
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const names = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    const results: { name: string; applied: boolean }[] = [];
    for (const name of names) {
      const sql = await Bun.file(resolve(directory, name)).text();
      const checksum = new Bun.CryptoHasher('sha256').update(sql).digest('hex');
      const [existing] = await connection`SELECT checksum FROM schema_migrations WHERE name = ${name}`;
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Checksum migrasi ${name} berubah. Buat migrasi baru.`);
        results.push({ name, applied: false });
        continue;
      }
      await connection.begin(async tx => {
        await tx.unsafe(sql);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})`;
      });
      results.push({ name, applied: true });
    }
    return results;
  } finally {
    try { await connection`SELECT pg_advisory_unlock(884281)`; } finally { connection.release(); }
  }
}
