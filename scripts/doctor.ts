import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { insideRoot, loadConfig, projectRoot, selectWorkers, servicePorts, withTimeout, type DevelopmentConfig } from "./lib/development";
import { listeners } from "./lib/ports";

export interface Check { name: string; status: "ok" | "warning" | "error"; message: string }

export async function runDoctor(config: DevelopmentConfig, workers: string[], root = projectRoot): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], message: string) => checks.push({ name, status, message });
  add("Environment", process.env.NODE_ENV === "production" ? "error" : "ok", "Perintah ini khusus development.");
  add("Runtime Bun", "ok", Bun.version);
  add("Platform", ["darwin", "linux"].includes(process.platform) ? "ok" : "error", "Cleanup port mendukung macOS/Linux.");
  add("lsof", Bun.which("lsof") ? "ok" : "error", "Diperlukan untuk memeriksa listener TCP.");
  const node = Bun.which("node");
  add("Node.js", node ? "ok" : "error", "Angular CLI memakai runtime Node.js yang kompatibel.");
  const files = [
    ["Workspace Angular", resolve(root, config.frontend.workspace, "angular.json")],
    ["Entry backend", insideRoot(root, config.backend.entry)],
    ["Angular CLI lokal", resolve(root, "node_modules/@angular/cli/bin/ng.js")],
    ["Konfigurasi SDK", resolve(root, config.frontend.workspace, "sdk.config.json")],
    ["OpenAPI backend", resolve(root, "openapi.json")],
    ["SDK Angular", resolve(root, config.frontend.workspace, "sdk/public-api.ts")],
    ["Proxy development", resolve(root, config.frontend.workspace, config.frontend.proxyConfig)],
    ...workers.map((name) => [`Entry worker ${name}`, insideRoot(root, config.workers[name].entry)]),
  ];
  for (const [name, path] of files) {
    add(name, await Bun.file(path).exists() ? "ok" : "error", relativeLabel(root, path));
  }
  for (const name of workers) {
    for (const key of config.workers[name].env ?? []) {
      add(`Environment worker ${name}`, process.env[key] ? "ok" : "error", `${key} harus disediakan; nilainya tidak dicetak.`);
    }
  }
  const cli = resolve(root, "node_modules/@angular/cli/bin/ng.js");
  if (node && await Bun.file(cli).exists() && await Bun.file(resolve(root, config.frontend.workspace, "angular.json")).exists()) {
    const child = Bun.spawn([node, cli, "version"], {
      cwd: resolve(root, config.frontend.workspace), stdout: "ignore", stderr: "ignore",
      env: { ...process.env, NG_CLI_ANALYTICS: "false" },
    });
    try { add("Kompatibilitas Angular CLI", await withTimeout(child.exited, 10000) === 0 ? "ok" : "error", "Angular CLI lokal harus dapat dijalankan."); }
    catch { child.kill(); await child.exited; add("Kompatibilitas Angular CLI", "error", "Pemeriksaan CLI melewati batas waktu."); }
  }
  if (Bun.which("lsof") && ["darwin", "linux"].includes(process.platform)) {
    for (const port of servicePorts(config, workers)) {
      try {
        const found = await listeners(port);
        add(`Port ${port}`, found.length ? "warning" : "ok", found.length ? "Sedang dipakai; serve akan membersihkannya setelah preflight lulus." : "Tersedia.");
      } catch { add(`Port ${port}`, "error", "Listener tidak dapat diperiksa."); }
    }
  }
  const databases = [
    { label: "Database backend", env: "DATABASE_URL", schemas: config.database.schemas, migrations: true },
    ...workers.filter((name) => config.workers[name].databaseUrlEnv).map((name) => ({
      label: `Database worker ${name}`, env: config.workers[name].databaseUrlEnv!, schemas: config.workers[name].schemas!, migrations: false,
    })),
  ];
  for (const database of databases) {
    const url = process.env[database.env];
    if (!url) { add(database.label, "error", `${database.env} belum disediakan melalui environment lokal.`); continue; }
    let sql: SQL | undefined;
    try {
      const parsed = new URL(url);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid database adapter");
      sql = new SQL({ url, max: 1, connectionTimeout: 3 });
      const pool = sql;
      const findings = await withTimeout(checkDatabase(pool, config, root, database.schemas, database.migrations), 5000);
      checks.push(...findings.map((finding) => ({ ...finding, name: `${database.label}: ${finding.name}` })));
    } catch {
      add(database.label, "error", "PostgreSQL tidak dapat diverifikasi. Periksa koneksi, role, schema, dan metadata migration; kredensial tidak dicetak.");
    } finally { await sql?.close({ timeout: 0 }); }
  }
  return checks;
}

async function checkDatabase(sql: SQL, config: DevelopmentConfig, root: string, expectedSchemas: string[], migrations: boolean): Promise<Check[]> {
  const result: Check[] = [];
  const [version] = await sql`SELECT pg_catalog.current_setting('server_version_num') AS version`;
  result.push({ name: "PostgreSQL", status: Number(version.version) >= 180000 ? "ok" : "error", message: "Minimum versi 18." });
  const namespaces = await sql`SELECT nspname, pg_catalog.has_schema_privilege(current_user, oid, 'USAGE') AS usable,
    pg_catalog.has_schema_privilege(current_user, oid, 'CREATE') AS creatable FROM pg_catalog.pg_namespace`;
  for (const name of expectedSchemas) {
    const schema = namespaces.find((item: { nspname: string }) => item.nspname === name);
    result.push({ name: `Schema ${name}`, status: schema?.usable ? "ok" : "error", message: "Schema harus tersedia dan role backend mempunyai USAGE." });
    result.push({ name: `Privilege schema ${name}`, status: schema && !schema.creatable ? "ok" : "error", message: "Role runtime tidak boleh mempunyai CREATE pada schema aplikasi." });
  }
  const [role] = await sql`SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user`;
  result.push({ name: "Role database", status: role.rolsuper || role.rolcreatedb || role.rolcreaterole ? "error" : "ok", message: "Role runtime tidak boleh menjadi superuser atau dapat membuat database/role." });
  if (!migrations) return result;
  const applied = await sql`SELECT name, checksum FROM ${sql(config.database.migrationSchema)}.${sql("schema_migrations")}`;
  const path = resolve(root, "database/migrations");
  const files = (await readdir(path)).filter((name) => name.endsWith(".sql")).sort();
  const local = new Set(files);
  let matched = files.length > 0 && !applied.some((item: { name: string }) => !local.has(item.name));
  for (const name of files) {
    const checksum = new Bun.CryptoHasher("sha256").update(await Bun.file(resolve(path, name)).arrayBuffer()).digest("hex");
    if (!applied.some((item: { name: string; checksum: string }) => item.name === name && item.checksum === checksum)) matched = false;
  }
  result.push({ name: "Migration", status: matched ? "ok" : "error", message: "File SQL dan checksum harus sesuai metadata migration; doctor tidak menerapkan perubahan." });
  return result;
}

function relativeLabel(root: string, path: string): string { return path.slice(root.length + 1); }

export function printChecks(checks: Check[]): boolean {
  for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  const passed = checks.every((item) => item.status !== "error");
  console.log(passed ? "Doctor lulus." : "Doctor belum lulus; lengkapi prasyarat sebelum serve.");
  return passed;
}

if (import.meta.main) {
  try {
    const config = await loadConfig();
    const workers = selectWorkers(process.argv.slice(2), config);
    process.exitCode = printChecks(await runDoctor(config, workers)) ? 0 : 1;
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
