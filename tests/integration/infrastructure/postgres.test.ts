import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDoctor } from "../../../scripts/doctor";
import { loadConfig } from "../../../scripts/lib/development";

// Suite infrastruktur spec 0002. Setiap project Compose memakai nama unik berawalan foundation-infra-test-,
// port bebas, dan password acak; project foundation milik pengembang tidak pernah disentuh.

interface Stack { project: string; port: number; password: string; envFile: string }
interface Result { code: number; stdout: string; stderr: string }
interface ComposeFile {
  name: string;
  services: Record<string, { ports: string[]; volumes: string[]; environment: Record<string, string> }>;
}

const root = resolve(import.meta.dir, "../../..");
const pins: { baseImage: string; postgresPackageVersion: string } = await Bun.file(resolve(root, "infrastructure/postgres/pins.json")).json();
const pinnedImage = "foundation-postgres:18-pinned";
const testPrefix = "foundation-infra-test-";
const overrideFile = "tests/integration/infrastructure/compose.test.yml";
const secrets: string[] = [];
const stacks: Stack[] = [];
const identity: Record<string, unknown> = {};
let workspace = "";
let foundationBefore = "";
let main: Stack;

const docker = await detectDocker();
const cliTest = test.skipIf(!docker.cli);
const daemonTest = test.skipIf(!docker.daemon);
const label = (name: string, available: boolean) => available ? name : `${name} (dilewati: ${docker.reason})`;

beforeAll(async () => {
  workspace = await mkdtemp(resolve(tmpdir(), testPrefix));
  if (docker.daemon) foundationBefore = await foundationState();
});

afterAll(async () => {
  const failures: string[] = [];
  if (docker.daemon) {
    for (const stack of stacks) {
      try { await removeStack(stack); } catch (error) { failures.push(mask(String(error))); }
    }
  }
  if (workspace) await rm(workspace, { recursive: true, force: true });
  if (failures.length) throw new Error(failures.join("\n"));
});

function mask(text: string): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "***"), text);
}

function cleanEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("FOUNDATION_POSTGRES_") || key.startsWith("COMPOSE_")) continue;
    environment[key] = value;
  }
  return environment;
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): Promise<Result> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? root, env: options.env ?? cleanEnvironment(), stdout: "pipe", stderr: "pipe", timeout: options.timeout ?? 60000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

async function dockerCommand(args: string[], timeout?: number): Promise<Result> {
  const result = await run(["docker", ...args], { timeout });
  if (result.code !== 0) throw new Error(mask(`docker ${args.join(" ")} gagal (${result.code}):\n${result.stdout}\n${result.stderr}`));
  return result;
}

async function detectDocker(): Promise<{ cli: boolean; daemon: boolean; wait: boolean; reason: string }> {
  if (!Bun.which("docker")) return { cli: false, daemon: false, wait: false, reason: "docker CLI tidak ditemukan" };
  if ((await run(["docker", "compose", "version"])).code !== 0) return { cli: false, daemon: false, wait: false, reason: "Docker Compose v2 tidak tersedia" };
  const wait = (await run(["docker", "compose", "up", "--help"])).stdout.includes("--wait");
  if ((await run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeout: 20000 })).code !== 0) {
    return { cli: true, daemon: false, wait, reason: "Docker daemon tidak dapat dihubungi" };
  }
  return { cli: true, daemon: true, wait, reason: "" };
}

function assertTestProject(name: string): void {
  if (!/^foundation-infra-test-[0-9a-f]{8}$/.test(name)) {
    throw new Error(`Cleanup ditolak untuk project ${name}; hanya project berawalan ${testPrefix} yang boleh dihapus.`);
  }
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function createStack(): Promise<Stack> {
  const project = `${testPrefix}${randomBytes(4).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  const port = freePort();
  const envFile = resolve(workspace, `${project}.env`);
  secrets.push(password);
  await writeFile(envFile, [
    `FOUNDATION_POSTGRES_PASSWORD=${password}`,
    `FOUNDATION_POSTGRES_PORT=${port}`,
    `FOUNDATION_POSTGRES_IMAGE=${pinnedImage}`,
    `FOUNDATION_POSTGRES_BASE_IMAGE=${pins.baseImage}`,
    `FOUNDATION_POSTGRES_PACKAGE_VERSION=${pins.postgresPackageVersion}`,
  ].join("\n") + "\n", { mode: 0o600 });
  const stack = { project, port, password, envFile };
  stacks.push(stack);
  return stack;
}

async function compose(stack: Stack, args: string[], options: { allowFailure?: boolean; timeout?: number } = {}): Promise<Result> {
  assertTestProject(stack.project);
  const result = await run(["docker", "compose", "-p", stack.project, "--env-file", stack.envFile, "-f", "docker-compose.yml", "-f", overrideFile, ...args], { timeout: options.timeout });
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(mask(`docker compose ${args.join(" ")} gagal (${result.code}):\n${result.stdout}\n${result.stderr}`));
  }
  return result;
}

async function removeStack(stack: Stack): Promise<void> {
  assertTestProject(stack.project);
  await compose(stack, ["down", "--volumes", "--remove-orphans"], { timeout: 120000 });
}

async function up(stack: Stack): Promise<void> {
  await compose(stack, ["up", "-d", "--wait", "--wait-timeout", "120", "postgres"], { timeout: 300000 });
}

async function exec(stack: Stack, ...command: string[]): Promise<string> {
  return (await compose(stack, ["exec", "-T", "postgres", ...command])).stdout.trim();
}

async function oneOff(stack: Stack, script: string): Promise<string> {
  return (await compose(stack, ["run", "--rm", "-T", "--no-deps", "--entrypoint", "bash", "postgres", "-c", script], { timeout: 120000 })).stdout;
}

async function containerId(stack: Stack): Promise<string> {
  return (await compose(stack, ["ps", "-aq", "postgres"])).stdout.trim();
}

function connect(stack: Stack, password = stack.password): SQL {
  return new SQL({ hostname: "127.0.0.1", port: stack.port, username: "foundation_admin", password, database: "foundation", max: 1, connectionTimeout: 5 });
}

async function systemIdentifier(stack: Stack): Promise<string> {
  const sql = connect(stack);
  try {
    const [row] = await sql`SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()`;
    return row.id;
  } finally { await sql.close(); }
}

async function lastStartLog(stack: Stack): Promise<string> {
  const result = await compose(stack, ["logs", "--no-color", "--no-log-prefix", "postgres"]);
  const logs = result.stdout + result.stderr;
  const start = logs.lastIndexOf("starting PostgreSQL");
  expect(start).toBeGreaterThanOrEqual(0);
  return logs.slice(start);
}

function expectCleanStart(log: string): void {
  expect(log).toContain("database system was shut down at");
  expect(log).not.toMatch(/not properly shut down|automatic recovery in progress|redo starts|was interrupted/);
}

async function timed<T>(action: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await action();
  return performance.now() - started;
}

async function owned(project: string): Promise<string> {
  const filter = `label=com.docker.compose.project=${project}`;
  const found = await Promise.all([["ps", "-aq"], ["network", "ls", "-q"], ["volume", "ls", "-q"]].map((args) => dockerCommand([...args, "--filter", filter])));
  return found.map((result) => result.stdout.trim()).filter(Boolean).join("\n");
}

async function foundationState(): Promise<string> {
  const filter = "label=com.docker.compose.project=foundation";
  const containers = await dockerCommand(["ps", "-a", "--filter", filter, "--format", "{{.ID}} {{.Names}} {{.CreatedAt}} {{.State}}"]);
  const networks = await dockerCommand(["network", "ls", "--filter", filter, "--format", "{{.ID}} {{.Name}}"]);
  const labelled = (await dockerCommand(["volume", "ls", "-q", "--filter", filter])).stdout.split("\n").filter(Boolean);
  const volumes: string[] = [];
  for (const name of new Set(["foundation_pgsql_data", "foundation_postgres_data", ...labelled])) {
    const found = await run(["docker", "volume", "inspect", "--format", "{{.Name}} {{.CreatedAt}}", name]);
    volumes.push(found.code === 0 ? found.stdout.trim() : `${name} tidak ada`);
  }
  return [containers.stdout.trim(), networks.stdout.trim(), ...volumes.sort()].join("\n");
}

test("INFRA-001 Compose root hanya berisi postgres dan secret admin tidak masuk Git atau Bun", async () => {
  const file = Bun.YAML.parse(await Bun.file(resolve(root, "docker-compose.yml")).text()) as ComposeFile;
  expect(file.name).toBe("foundation");
  expect(Object.keys(file.services)).toEqual(["postgres"]);
  const service = file.services.postgres;
  expect(JSON.stringify(file)).not.toContain("docker-entrypoint-initdb.d");
  expect(service.volumes).toEqual(["pgsql_data:/var/lib/pgsql"]);
  expect(service.ports.length).toBeGreaterThan(0);
  expect(service.ports.every((port) => port.startsWith("127.0.0.1:"))).toBe(true);
  expect(service.environment.POSTGRES_HOST_AUTH_METHOD).toBeUndefined();

  const ignored = await run(["git", "check-ignore", "--no-index", "-v", ".env.infrastructure"]);
  expect(ignored.code).toBe(0);
  expect(ignored.stdout).toContain(":.env.*\t.env.infrastructure");
  for (const example of [".env.example", ".env.infrastructure.example"]) {
    expect((await run(["git", "check-ignore", "--no-index", "-q", example])).code).toBe(1);
  }

  const example = await Bun.file(resolve(root, ".env.infrastructure.example")).text();
  expect(example.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))).toEqual(["FOUNDATION_POSTGRES_PASSWORD="]);

  const probe = await mkdtemp(resolve(tmpdir(), "foundation-infra-bun-"));
  try {
    await writeFile(resolve(probe, ".env.infrastructure"), "FOUNDATION_POSTGRES_PASSWORD=sentinel-bun-autoload\n");
    for (const nodeEnvironment of [undefined, "development", "test"]) {
      const env = cleanEnvironment();
      delete env.NODE_ENV;
      if (nodeEnvironment) env.NODE_ENV = nodeEnvironment;
      const loaded = await run([process.execPath, "-e", "process.stdout.write(process.env.FOUNDATION_POSTGRES_PASSWORD ?? '')"], { cwd: probe, env });
      expect(loaded.code).toBe(0);
      expect(loaded.stdout).toBe("");
    }
  } finally { await rm(probe, { recursive: true, force: true }); }

  for (const name of await readdir(resolve(root, "scripts"), { recursive: true })) {
    if (name.endsWith(".ts")) expect(await Bun.file(resolve(root, "scripts", name)).text()).not.toMatch(/\bdocker\b/i);
  }
});

cliTest(label("INFRA-001 config --quiet menolak password kosong dan tidak mencetak secret", docker.cli), async () => {
  const project = `${testPrefix}${randomBytes(4).toString("hex")}`;
  const sentinel = `sentinel${randomBytes(8).toString("hex")}`;
  const envFile = resolve(workspace, "config.env");
  secrets.push(sentinel);
  const config = () => run(["docker", "compose", "-p", project, "--env-file", envFile, "-f", "docker-compose.yml", "config", "--quiet"]);

  await writeFile(envFile, `FOUNDATION_POSTGRES_PASSWORD=\nFOUNDATION_POSTGRES_IMAGE=foundation-postgres:${sentinel}\n`, { mode: 0o600 });
  const empty = await config();
  expect(empty.code).not.toBe(0);
  expect(empty.stderr).toContain("FOUNDATION_POSTGRES_PASSWORD");
  expect((empty.stdout + empty.stderr).includes(sentinel)).toBe(false);

  await writeFile(envFile, `FOUNDATION_POSTGRES_PASSWORD=${sentinel}\n`, { mode: 0o600 });
  const valid = await config();
  expect(valid.code).toBe(0);
  expect(mask(valid.stdout + valid.stderr)).toBe("");
});

test("INFRA-005 cleanup menolak nama project tanpa awalan uji", () => {
  for (const name of ["foundation", "foundation-infra", testPrefix, `other-${testPrefix}0a1b2c3d`, `${testPrefix}../x`]) {
    expect(() => assertTestProject(name)).toThrow("Cleanup ditolak");
  }
  expect(() => assertTestProject(`${testPrefix}0a1b2c3d`)).not.toThrow();
});

daemonTest(label("INFRA-002 build terkunci dari pins.json tanpa secret pada metadata image", docker.daemon), async () => {
  expect(docker.wait).toBe(true);
  expect(pins.baseImage).toMatch(/^oraclelinux:10-slim@sha256:[0-9a-f]{64}$/);
  expect(pins.postgresPackageVersion).toMatch(/^18\.\d+-\d+PGDG\.rhel10(\.\d+)?$/);
  main = await createStack();
  await compose(main, ["build", "postgres"], { timeout: 900000 });

  const [image] = JSON.parse((await dockerCommand(["image", "inspect", pinnedImage])).stdout);
  expect(image.Config.Labels["org.opencontainers.image.base.name"]).toBe(pins.baseImage);
  expect(image.Config.User).toBe("postgres");
  expect(image.Config.Env).toContain("TZ=UTC");
  await dockerCommand(["pull", "--quiet", pins.baseImage], 300000);
  const [base] = JSON.parse((await dockerCommand(["image", "inspect", pins.baseImage])).stdout);
  expect(image.RootFS.Layers.slice(0, base.RootFS.Layers.length)).toEqual(base.RootFS.Layers);

  const history = (await dockerCommand(["history", "--no-trunc", "--format", "{{.CreatedBy}}", pinnedImage])).stdout;
  const metadata = JSON.stringify(image) + history;
  expect(metadata.includes("POSTGRES_PASSWORD")).toBe(false);
  expect(metadata.includes(main.password)).toBe(false);
  Object.assign(identity, {
    image: pinnedImage, imageId: image.Id, architecture: image.Architecture, os: image.Os,
    baseImage: image.Config.Labels["org.opencontainers.image.base.name"], baseIndexDigest: pins.baseImage.split("@")[1],
    basePlatformLayers: base.RootFS.Layers,
  });
}, 900000);

daemonTest(label("INFRA-003 up --wait sampai healthy dan admin terhubung lewat scram dengan konfigurasi cluster sesuai", docker.daemon), async () => {
  await up(main);
  const [status] = (await compose(main, ["ps", "--format", "json", "postgres"])).stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(status.Health).toBe("healthy");

  const sql = connect(main);
  try {
    const [server] = await sql`SELECT pg_catalog.current_setting('server_version_num')::int AS num, pg_catalog.current_setting('server_version') AS version,
      current_user AS "user", pg_catalog.current_setting('TimeZone') AS timezone, pg_catalog.current_setting('log_timezone') AS "logTimezone",
      pg_catalog.current_setting('data_checksums') AS checksums, pg_catalog.current_setting('logging_collector') AS collector`;
    expect(server.num).toBeGreaterThanOrEqual(180000);
    expect(server.version).toBe(pins.postgresPackageVersion.split("-")[0]);
    expect(server.user).toBe("foundation_admin");
    expect([server.timezone, server.logTimezone, server.checksums, server.collector]).toEqual(["UTC", "UTC", "on", "off"]);
    const [database] = await sql`SELECT datlocprovider::text AS provider, datlocale AS locale, pg_catalog.pg_encoding_to_char(encoding) AS encoding
      FROM pg_catalog.pg_database WHERE datname = 'foundation'`;
    expect({ ...database }).toEqual({ provider: "b", locale: "C.UTF-8", encoding: "UTF8" });
    const [role] = await sql`SELECT rolsuper AS superuser, rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_catalog.pg_authid WHERE rolname = current_user`;
    expect({ ...role }).toEqual({ superuser: true, scram: true });
    const rules = await sql`SELECT type, auth_method AS method, error FROM pg_catalog.pg_hba_file_rules ORDER BY rule_number`;
    expect(rules.map((rule: { type: string; method: string; error: string | null }) => [rule.type, rule.method, rule.error])).toEqual([
      ["local", "scram-sha-256", null], ["host", "scram-sha-256", null], ["host", "scram-sha-256", null],
    ]);
    Object.assign(identity, { serverVersion: server.version, serverVersionNum: server.num });
  } finally { await sql.close(); }

  const intruder = connect(main, randomBytes(32).toString("hex"));
  let rejection = "";
  try { await intruder`SELECT 1`; } catch (error) { rejection = String((error as Error).message); } finally { await intruder.close(); }
  expect(rejection).toMatch(/password authentication failed/i);

  expect((await compose(main, ["port", "postgres", "5432"])).stdout.trim()).toBe(`127.0.0.1:${main.port}`);
  const bindings = JSON.parse((await dockerCommand(["inspect", "--format", "{{json .NetworkSettings.Ports}}", await containerId(main)])).stdout);
  expect(bindings["5432/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: String(main.port) }]);
  const environ = await exec(main, "cat", "/proc/1/environ");
  expect(environ.includes("POSTGRES_PASSWORD=") || environ.includes(main.password)).toBe(false);
}, 300000);

daemonTest(label("INFRA-003 doctor menolak DATABASE_URL superuser tanpa mencetak password", docker.daemon), async () => {
  const url = `postgres://foundation_admin:${main.password}@127.0.0.1:${main.port}/foundation`;
  const saved = { DATABASE_URL: process.env.DATABASE_URL, PROBE_DATABASE_URL: process.env.PROBE_DATABASE_URL };
  process.env.DATABASE_URL = url;
  process.env.PROBE_DATABASE_URL = url;
  try {
    const config = await loadConfig(root);
    config.workers.probe = { entry: "scripts/doctor.ts", databaseUrlEnv: "PROBE_DATABASE_URL", schemas: [] };
    const checks = await runDoctor(config, ["probe"], root);
    expect(checks.find((check) => check.name === "Database worker probe: Role database")?.status).toBe("error");
    expect(checks.some((check) => check.name.startsWith("Database backend") && check.status === "error")).toBe(true);
    expect(JSON.stringify(checks).includes(main.password)).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 60000);

daemonTest(label("INFRA-002 identitas image tercatat dan proses server bukan root", docker.daemon), async () => {
  const packageVersion = await exec(main, "rpm", "-q", "--qf", "%{VERSION}-%{RELEASE}", "postgresql18-server");
  expect(packageVersion).toBe(pins.postgresPackageVersion);
  const packages = (await exec(main, "rpm", "-qa", "--qf", "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\\n")).split("\n").filter(Boolean).sort();
  const postgres = packages.filter((name) => name.startsWith("postgresql18"));
  expect(postgres.map((name) => name.replace(/-\d.*$/, ""))).toEqual(["postgresql18", "postgresql18-libs", "postgresql18-server"]);
  expect(postgres.every((name) => name.includes(`-${pins.postgresPackageVersion}.`))).toBe(true);
  const uid = (await exec(main, "cat", "/proc/1/status")).match(/^Uid:\s+(\d+)/m)?.[1];
  expect(uid).toBeDefined();
  expect(uid).not.toBe("0");
  expect(await exec(main, "id", "-u")).toBe(uid!);
  expect(await exec(main, "id", "-un")).toBe("postgres");

  await mkdir(resolve(root, ".local/feature-3"), { recursive: true });
  await Bun.write(resolve(root, ".local/feature-3/image.json"), JSON.stringify({
    recordedAt: new Date().toISOString(), pins, ...identity, packageVersion, processUid: Number(uid), packages,
  }, null, 2) + "\n");
}, 120000);

daemonTest(label("INFRA-004 data bertahan setelah down tanpa -v dan shutdown tertib tanpa recovery", docker.daemon), async () => {
  const before = await systemIdentifier(main);
  expect(await timed(() => compose(main, ["down"], { timeout: 120000 }))).toBeLessThan(30000);
  await dockerCommand(["volume", "inspect", `${main.project}_pgsql_data`]);
  await up(main);
  expect(await systemIdentifier(main)).toBe(before);
  expectCleanStart(await lastStartLog(main));

  const holder = connect(main);
  await holder`SELECT 1`;
  try {
    expect(await timed(() => compose(main, ["stop", "postgres"], { timeout: 120000 }))).toBeLessThan(30000);
  } finally { await holder.close().catch(() => {}); }
  expect((await dockerCommand(["inspect", "--format", "{{.State.ExitCode}}", await containerId(main)])).stdout.trim()).toBe("0");
  await up(main);
  expectCleanStart(await lastStartLog(main));
  expect(await systemIdentifier(main)).toBe(before);
}, 600000);

daemonTest(label("INFRA-006 staging sisa inisialisasi terputus diganti cluster sehat", docker.daemon), async () => {
  const stack = await createStack();
  await oneOff(stack, "mkdir -p /var/lib/pgsql/18/data.init/base && echo 18 > /var/lib/pgsql/18/data.init/PG_VERSION");
  await up(stack);
  const sql = connect(stack);
  try {
    const [row] = await sql`SELECT current_database() AS database`;
    expect(row.database).toBe("foundation");
  } finally { await sql.close(); }
  expect((await exec(stack, "ls", "-A", "/var/lib/pgsql/18")).split(/\s+/).sort()).toEqual(["backups", "data"]);
  const logs = await compose(stack, ["logs", "--no-color", "postgres"]);
  expect(logs.stdout + logs.stderr).toContain("Menghapus staging sisa inisialisasi");
  await removeStack(stack);
}, 600000);

daemonTest(label("INFRA-006 PGDATA tanpa PG_VERSION menghentikan container tanpa mengubah isinya", docker.daemon), async () => {
  const stack = await createStack();
  const snapshot = "cd /var/lib/pgsql/18/data && ls -la --time-style=full-iso && sha256sum penanda";
  await oneOff(stack, "mkdir -p /var/lib/pgsql/18/data && echo jangan-diubah > /var/lib/pgsql/18/data/penanda");
  const before = await oneOff(stack, snapshot);
  const started = await compose(stack, ["up", "-d", "--wait", "--wait-timeout", "60", "postgres"], { allowFailure: true, timeout: 180000 });
  expect(started.code).not.toBe(0);
  const state = JSON.parse((await dockerCommand(["inspect", "--format", "{{json .State}}", await containerId(stack)])).stdout);
  expect(state.Status).toBe("exited");
  expect(state.ExitCode).not.toBe(0);
  const logs = await compose(stack, ["logs", "--no-color", "postgres"]);
  expect(logs.stdout + logs.stderr).toContain("tanpa PG_VERSION");
  expect(await oneOff(stack, snapshot)).toBe(before);
  await removeStack(stack);
}, 600000);

daemonTest(label("INFRA-005 suite hanya menghapus resource project uji dan project foundation tidak berubah", docker.daemon), async () => {
  for (const stack of stacks) await removeStack(stack);
  for (const stack of stacks) expect(await owned(stack.project)).toBe("");
  expect(await foundationState()).toBe(foundationBefore);
}, 300000);
