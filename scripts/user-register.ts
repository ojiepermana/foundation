import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config';
import { createDb } from '../server/db';
import { AuthService } from '../server/auth';
import { AppError } from '../server/errors';
const { values } = parseArgs({ args: process.argv.slice(2), options: { name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, resend: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
if (values.help) {
  console.log('bun run user:register --name "Nama" --email "nama@example.com" --role admin|user\nbun run user:resend-activation --email "nama@example.com"');
  process.exit(0);
}
if (!values.email || (!values.resend && (!values.name || !values.role))) {
  console.error('Parameter wajib: --name, --email, --role. Untuk kirim ulang: --resend --email.'); process.exit(1);
}
const config = loadConfig(); const db = createDb(config.databaseUrl);
try {
  const auth = new AuthService(db, config);
  if (values.resend) { await auth.resendActivation(values.email); console.log('Email aktivasi dijadwalkan ulang.'); }
  else { const user = await auth.register({ name: values.name!, email: values.email, role: values.role! }); console.log(`Akun ${user.id} dibuat. Email aktivasi dijadwalkan.`); }
} catch (error) {
  console.error(error instanceof AppError ? error.message : 'Operasi gagal. Periksa konfigurasi dan koneksi database.'); process.exitCode = 1;
} finally { await db.close(); }
