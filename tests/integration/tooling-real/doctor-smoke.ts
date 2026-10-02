import { randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SQL } from "bun";
import { runDoctor } from "../../../scripts/doctor";
import { loadConfig } from "../../../scripts/lib/development";
import { listeners } from "../../../scripts/lib/ports";

const name = `foundation-tooling-probe-${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const root = await mkdtemp(resolve(tmpdir(), "foundation-tooling-db-"));
const projectRoot = resolve(import.meta.dir, "../../..");
const projectMigrationDirectory = resolve(projectRoot, "database/migrations");
let createdProjectMigration = false;
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Docker step failed: ${args[0]} ${err.split("\n")[0]}`);
  return out.trim();
}

try {
  const temporaryListener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = temporaryListener.port;
  temporaryListener.stop();
  await docker(["run", "-d", "--rm", "--name", name,
    "-e", "PGDATA=/var/lib/pgsql/18/data", "-e", "POSTGRES_USER=foundation_admin",
    "-e", "POSTGRES_DB=foundation", "-e", `POSTGRES_PASSWORD=${password}`,
    "-p", `127.0.0.1:${port}:5432`, "foundation-postgres:18-pinned"]);
  const adminUrl = `postgres://foundation_admin:${password}@127.0.0.1:${port}/foundation`;
  let admin: SQL | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { admin = new SQL({ url: adminUrl, max: 1, connectionTimeout: 1 }); await admin`SELECT 1`; break; }
    catch { await admin?.close({ timeout: 0 }).catch(() => {}); admin = undefined; await Bun.sleep(250); }
  }
  if (!admin) throw new Error("PostgreSQL did not start");
  try {
    await admin`CREATE SCHEMA common`;
    await admin`CREATE SCHEMA users`;
    await admin`CREATE SCHEMA auth`;
    await admin`CREATE TABLE common.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)`;
    await admin.unsafe(`CREATE ROLE foundation_backend LOGIN PASSWORD '${password}'`);
    await admin`GRANT USAGE ON SCHEMA common, users, auth TO foundation_backend`;
    await admin`GRANT SELECT ON common.schema_migrations TO foundation_backend`;
    await admin`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    const migrations = resolve(root, "database/migrations");
    await mkdir(migrations, { recursive: true });
    const filename = "0001-test.sql";
    const sql = "SELECT 1;\n";
    await Bun.write(resolve(migrations, filename), sql);
    const checksum = new Bun.CryptoHasher("sha256").update(sql).digest("hex");
    await admin`INSERT INTO common.schema_migrations (name, checksum) VALUES (${filename}, ${checksum})`;
    const config = await loadConfig();
    process.env.DATABASE_URL = `postgres://foundation_backend:${password}@127.0.0.1:${port}/foundation`;
    const checks = await runDoctor(config, [], root);
    const db = checks.filter((item) => item.name.startsWith("Database backend"));
    if (db.some((item) => item.status === "error")) {
      for (const item of db) console.log(`${item.name}: ${item.status}`);
      throw new Error("Doctor rejected the expected runtime role");
    }
    console.log(`PostgreSQL 18 runtime role: ${db.length} checks passed`);
    if ((await listeners(8888)).length === 0 && (await listeners(8889)).length === 0) {
      let migrationDirectoryExists = true;
      try { await access(projectMigrationDirectory); } catch { migrationDirectoryExists = false; }
      if (migrationDirectoryExists) throw new Error("Project migration directory already exists; refusing temporary smoke setup");
      await mkdir(projectMigrationDirectory, { recursive: true });
      createdProjectMigration = true;
      await Bun.write(resolve(projectMigrationDirectory, filename), sql);
      const child = Bun.spawn([process.execPath, "scripts/serve.ts"], {
        cwd: projectRoot, env: { ...process.env, NODE_ENV: "development", DATABASE_URL: process.env.DATABASE_URL },
        stdout: "pipe", stderr: "pipe",
      });
      let output = "";
      const readOutput = (async () => {
        const reader = child.stdout.getReader();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) return false;
            output += new TextDecoder().decode(part.value);
            if (output.includes("Layanan development siap.")) return true;
          }
        } finally { reader.releaseLock(); }
      })();
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 65000); });
        const ready = await Promise.race([readOutput, deadline]);
        clearTimeout(timeout);
        if (!ready) throw new Error(`Serve did not become ready: ${output.replaceAll(password, "[redacted]")}`);
        const backend = await fetch("http://127.0.0.1:8888/api/status").then((response) => response.json());
        const frontend = await fetch("http://127.0.0.1:8889/");
        if (backend.status !== "ok" || frontend.status !== 200) throw new Error("Real application HTTP smoke failed");
        console.log("Real frontend and backend: ready through serve");
      } finally {
        child.kill("SIGTERM");
        await child.exited;
        if ((await listeners(8888)).length || (await listeners(8889)).length) {
          throw new Error("Serve shutdown left application listeners alive");
        }
        console.log("Serve shutdown: application ports free");
      }
    }
    const wrongTarget = structuredClone(config);
    wrongTarget.database.expectedName = "other_database";
    if (!((await runDoctor(wrongTarget, [], root)).some((item) => item.name.includes("Target database") && item.status === "error"))) {
      throw new Error("Doctor accepted the wrong target database");
    }
    await admin`GRANT INSERT ON common.schema_migrations TO foundation_backend`;
    if (!((await runDoctor(config, [], root)).some((item) => item.name.includes("Privilege metadata") && item.status === "error"))) {
      throw new Error("Doctor accepted metadata write privilege");
    }
    await admin`REVOKE INSERT ON common.schema_migrations FROM foundation_backend`;
    await admin`CREATE ROLE metadata_writer NOLOGIN`;
    await admin`GRANT INSERT ON common.schema_migrations TO metadata_writer`;
    await admin`GRANT metadata_writer TO foundation_backend`;
    if (!((await runDoctor(config, [], root)).some((item) => item.name.includes("Privilege metadata") && item.status === "error"))) {
      throw new Error("Doctor accepted writer role membership");
    }
    await admin`REVOKE metadata_writer FROM foundation_backend`;
    await Bun.write(resolve(migrations, filename), "SELECT 2;\n");
    if (!((await runDoctor(config, [], root)).some((item) => item.name.includes("Migration") && item.status === "error"))) {
      throw new Error("Doctor accepted altered migration");
    }
    console.log("Wrong target, metadata writes, role membership, and changed migration: rejected");
    process.env.DATABASE_URL = adminUrl;
    const denied = await runDoctor(config, [], root);
    if (!denied.some((item) => item.name.includes("Role database") && item.status === "error")) {
      throw new Error("Doctor accepted administrator role");
    }
    console.log("Administrator role: rejected");
  } finally { await admin.close({ timeout: 0 }); }
} finally {
  await docker(["rm", "-f", name]).catch(() => {});
  if (createdProjectMigration) {
    await unlink(resolve(projectMigrationDirectory, "0001-test.sql"));
    await rmdir(projectMigrationDirectory);
    await rmdir(resolve(projectRoot, "database"));
  }
  await rm(root, { recursive: true, force: true });
}
