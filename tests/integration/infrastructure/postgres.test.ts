import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDoctor } from "../../../scripts/doctor";
import { loadConfig } from "../../../scripts/lib/development";
import { onSignalCleanup, type SignalCleanupCallback } from "../../orchestration/signal-cleanup";

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
// Signal cleanup of spec 0010 (row *Pembersihan sinyal suite nyata*): bun test runs neither afterAll nor finally on
// SIGINT or SIGTERM, so every folder, project, and verification container is registered before it is created and
// released once the normal path removed it.
const releases = new Map<string, () => void>();
const verifierPrefix = "foundation-infra-verify-";

const docker = await detectDocker();
const cliTest = test.skipIf(!docker.cli);
const daemonTest = test.skipIf(!docker.daemon);
const label = (name: string, available: boolean) => available ? name : `${name} (dilewati: ${docker.reason})`;
// Run bersarang tanpa daemon (INFRA-005) menandai dirinya agar tidak memanggil dirinya sendiri lagi.
const nested = process.env.FOUNDATION_INFRA_NESTED === "1";
const nestedLabel = " (dilewati: sudah di dalam run bersarang)";

beforeAll(async () => {
  workspace = await mkdtemp(resolve(tmpdir(), testPrefix));
  releases.set(workspace, onSignalCleanup(folderCleanup(workspace)));
  if (docker.daemon) foundationBefore = await foundationState();
});

afterAll(async () => {
  const failures: string[] = [];
  if (docker.daemon) {
    for (const stack of stacks) {
      try { await removeStack(stack); } catch (error) { failures.push(mask(String(error))); }
    }
  }
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    release(workspace);
  }
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

async function runVerifierInContainer(script: string, timeout = 300000): Promise<Result> {
  const verifier = resolve(root, "infrastructure/postgres/verify-pgdg-repo-rpm.sh");
  // Named, so the signal cleanup can remove it: without a name it keeps running after a signal, because bash as PID 1
  // ignores SIGTERM, and --rm only removes it once the script ends.
  const name = `${verifierPrefix}${randomBytes(4).toString("hex")}`;
  const releaseVerifier = onSignalCleanup(verifierCleanup(name));
  try {
    return await run([
      "docker", "run", "--rm", "--name", name, "--user", "0",
      "--mount", `type=bind,source=${verifier},target=/tmp/verify-pgdg-repo-rpm.sh,readonly`,
      "--entrypoint", "/bin/bash", pins.baseImage, "-c", script,
    ], { timeout });
  } finally {
    releaseVerifier();
  }
}

function release(key: string): void {
  releases.get(key)?.();
  releases.delete(key);
}

/**
 * Synchronous Docker call of the signal cleanup: an argument array, never a shell, the same environment as every other
 * Docker call in this file, output captured and never printed. `undefined` when no time is left, the call timed out, or
 * it could not start.
 */
function dockerSync(args: string[], timeout: number): { code: number; stdout: string } | undefined {
  if (timeout <= 0) return undefined;
  try {
    const result = Bun.spawnSync(["docker", ...args], { cwd: root, env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
    return result.exitedDueToTimeout ? undefined : { code: result.exitCode, stdout: result.stdout.toString() };
  } catch {
    return undefined;
  }
}

/** A temporary folder: removed on pass 2, after the Compose actions that still need its env files. */
function folderCleanup(path: string): SignalCleanupCallback {
  return ({ pass }) => {
    if (pass !== 2) return [];
    try {
      rmSync(path, { recursive: true, force: true });
      return [];
    } catch {
      return [path];
    }
  };
}

/** A verification container: `docker rm -f` on every pass, only for a name this process made. */
function verifierCleanup(name: string): SignalCleanupCallback {
  return ({ timeout }) => {
    if (!/^foundation-infra-verify-[0-9a-f]{8}$/.test(name)) return [name];
    return dockerSync(["rm", "-f", name], timeout(30000))?.code === 0 ? [] : [name];
  };
}

/**
 * A Compose project: `down` with the same arguments as `removeStack` on every pass. Exit code 0 of `down` is no proof
 * that the project is gone (a volume still used by a `run --rm` container is skipped), so pass 2 also lists the
 * containers, networks, and volumes that carry the label of this project and reports the project when one is left.
 * Nothing is ever removed by label.
 */
function stackCleanup(stack: Stack): SignalCleanupCallback {
  return ({ pass, timeout }) => {
    try {
      assertTestProject(stack.project);
    } catch {
      return [stack.project];
    }
    const down = dockerSync(["compose", "-p", stack.project, "--env-file", stack.envFile, "-f", "docker-compose.yml", "-f", overrideFile,
      "down", "--volumes", "--remove-orphans"], timeout(45000));
    if (down?.code !== 0) return [stack.project];
    if (pass === 1) return [];
    const filter = `label=com.docker.compose.project=${stack.project}`;
    for (const args of [["ps", "-aq"], ["network", "ls", "-q"], ["volume", "ls", "-q"]]) {
      const listed = dockerSync([...args, "--filter", filter], timeout(30000));
      if (listed?.code !== 0 || listed.stdout.trim() !== "") return [stack.project];
    }
    return [];
  };
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
  // After the env file exists and before the first Compose command of this project.
  releases.set(project, onSignalCleanup(stackCleanup(stack)));
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
  release(stack.project);
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

async function rejection(stack: Stack, password: string): Promise<string> {
  const intruder = connect(stack, password);
  try { await intruder`SELECT 1`; return ""; } catch (error) { return String((error as Error).message); } finally { await intruder.close(); }
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
  const devImage = await run(["docker", "image", "inspect", "--format", "{{.Id}}", "foundation-postgres:18-dev"]);
  const image = devImage.code === 0 ? `foundation-postgres:18-dev ${devImage.stdout.trim()}` : "foundation-postgres:18-dev tidak ada";
  return [containers.stdout.trim(), networks.stdout.trim(), ...volumes.sort(), image].join("\n");
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
  releases.set(probe, onSignalCleanup(folderCleanup(probe)));
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
  } finally { await rm(probe, { recursive: true, force: true }); release(probe); }

  for (const name of await readdir(resolve(root, "scripts"), { recursive: true })) {
    if (name.endsWith(".ts")) expect(await Bun.file(resolve(root, "scripts", name)).text()).not.toMatch(/\bdocker\b/i);
  }

  const updateCommand = "docker compose --env-file .env.infrastructure build --pull --no-cache postgres";
  for (const path of ["README.md", "docs/rules/infrastructure.md", "docs/specs/0002-infrastruktur-postgresql-development/index.md", "docs/specs/0002-infrastruktur-postgresql-development/verify.md"]) {
    expect(await Bun.file(resolve(root, path)).text()).toContain(updateCommand);
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

test("INFRA-002 key PGDG dan signature repo diverifikasi sebelum RPM diinstall", async () => {
  const dockerfile = await Bun.file(resolve(root, "infrastructure/postgres/Dockerfile")).text();
  const verifier = await Bun.file(resolve(root, "infrastructure/postgres/verify-pgdg-repo-rpm.sh")).text();
  const keyDownload = dockerfile.indexOf("/pub/repos/yum/keys/");
  const helperCopy = dockerfile.indexOf("COPY --chmod=0755 verify-pgdg-repo-rpm.sh /tmp/verify-pgdg-repo-rpm.sh");
  const gpgInstall = dockerfile.indexOf("microdnf -y --nodocs install gnupg2");
  const gpgRemoval = dockerfile.indexOf('microdnf -y remove "${gpg_packages_added[@]}"');
  const verifierCall = dockerfile.indexOf('/tmp/verify-pgdg-repo-rpm.sh "$keyfile" /tmp/pgdg-repo.rpm "$expected"');
  const postgresInstall = dockerfile.indexOf('install "$package" tzdata');
  const fingerprintListing = verifier.indexOf("--with-colons --import-options show-only --dry-run --import");
  const fingerprintCheck = verifier.indexOf('[ "$primary_fingerprints" != "$expected" ]');
  const isolatedImport = verifier.indexOf('rpmkeys --dbpath "$keydb" --import "$keyfile"');
  const isolatedKeyCheck = verifier.indexOf('[ "$imported_key_ids" = "$expected_key_id" ]');
  const keyImport = verifier.indexOf('rpmkeys --import "$keyfile"');
  const signatureCheck = verifier.indexOf("rpmkeys --define '_pkgverify_level all' --checksig --verbose");
  const trustedKeyCheck = verifier.indexOf('grep -Eiq "key ID $expected_key_id: OK"');
  const install = verifier.indexOf("rpm --define '_pkgverify_level all' -i");

  expect([keyDownload, helperCopy, gpgInstall, gpgRemoval, verifierCall, postgresInstall, fingerprintListing, fingerprintCheck, isolatedImport, isolatedKeyCheck, keyImport, signatureCheck, trustedKeyCheck, install].every((position) => position >= 0)).toBe(true);
  expect(helperCopy).toBeLessThan(keyDownload);
  expect(gpgInstall).toBeLessThan(keyDownload);
  expect(helperCopy).toBeLessThan(verifierCall);
  expect(gpgInstall).toBeLessThan(verifierCall);
  expect(verifierCall).toBeLessThan(gpgRemoval);
  expect(gpgRemoval).toBeLessThan(postgresInstall);
  expect(fingerprintListing).toBeLessThan(fingerprintCheck);
  expect(fingerprintCheck).toBeLessThan(isolatedImport);
  expect(isolatedImport).toBeLessThan(isolatedKeyCheck);
  expect(dockerfile).toContain("grep -Ev '^(gpg-pubkey|pgdg-redhat-repo)$'");
  expect(verifier).not.toContain("sort -u");
  expect(isolatedKeyCheck).toBeLessThan(keyImport);
  expect(keyImport).toBeLessThan(signatureCheck);
  expect(signatureCheck).toBeLessThan(trustedKeyCheck);
  expect(trustedKeyCheck).toBeLessThan(install);
  expect(signatureCheck).toBeLessThan(install);
  expect(dockerfile).not.toContain("--nosignature");
});

daemonTest(label("INFRA-002 key bundle dan signature unsigned, rusak, atau dari signer lain ditolak sebelum instalasi", docker.daemon), async () => {
  const script = `set -euo pipefail
microdnf -y --nodocs install rpm-build rpm-sign gnupg2 >/dev/null
arch="$(uname -m)"
case "$arch" in
  x86_64) key=PGDG-RPM-GPG-KEY-RHEL; expected=D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20 ;;
  aarch64) key=PGDG-RPM-GPG-KEY-AARCH64-RHEL; expected=B031F89FC983E98262906B6E177B343BB9738825 ;;
  *) echo "arsitektur tidak didukung: $arch" >&2; exit 2 ;;
esac
curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/repo.rpm "https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-$arch/pgdg-redhat-repo-latest.noarch.rpm"
cp /tmp/repo.rpm /tmp/signed-repo.rpm
curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/key "https://download.postgresql.org/pub/repos/yum/keys/$key"
rpmsign --delsign /tmp/repo.rpm
default_check="$(rpmkeys --checksig /tmp/repo.rpm)"
if [[ "$default_check" != *"digests OK"* || "$default_check" == *"signatures OK"* ]]; then
  printf 'Unexpected default RPM verification output: %s\n' "$default_check" >&2
  exit 12
fi
if /tmp/verify-pgdg-repo-rpm.sh /tmp/key /tmp/repo.rpm "$expected" >/tmp/unsigned.out 2>&1; then
  echo "CANDIDATE_ACCEPTED_UNSIGNED_RPM" >&2
  exit 3
fi
if rpm -q pgdg-redhat-repo; then
  echo "UNSIGNED_PACKAGE_INSTALLED" >&2
  exit 4
fi
echo "UNSIGNED_RPM_REJECTED"

# Buat RPM dengan payload dan %post penanda, lalu tandatangani dengan key uji yang berbeda.
mkdir -p /tmp/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS} /tmp/gnupg
chmod 700 /tmp/gnupg
cat >/tmp/rpmbuild/SPECS/fixture.spec <<'SPEC'
Name: pgdg-verification-fixture
Version: 1
Release: 1
Summary: Temporary signature verification fixture
License: MIT
BuildArch: noarch
%description
Temporary signature verification fixture.
%install
mkdir -p %{buildroot}/usr/share/pgdg-verification-fixture
echo payload > %{buildroot}/usr/share/pgdg-verification-fixture/payload
%post
/bin/sh -c 'echo executed > /tmp/pgdg-verification-scriptlet'
%files
/usr/share/pgdg-verification-fixture/payload
SPEC
rpmbuild --define '_topdir /tmp/rpmbuild' -bb /tmp/rpmbuild/SPECS/fixture.spec >/dev/null 2>&1
gpg --homedir /tmp/gnupg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Foundation Fixture Signer <fixture@example.invalid>' rsa2048 sign 0 >/dev/null 2>&1
gpg --homedir /tmp/gnupg --batch --armor --export >/tmp/fixture-public.key
other_key_id="$(gpg --homedir /tmp/gnupg --batch --with-colons --list-keys | awk -F: '$1 == "pub" { print substr($5, length($5) - 7); exit }' | tr A-F a-f)"
fixture=/tmp/rpmbuild/RPMS/noarch/pgdg-verification-fixture-1-1.noarch.rpm
rpmsign --addsign --define '_gpg_name Foundation Fixture Signer <fixture@example.invalid>' --define '_gpg_path /tmp/gnupg' --define '_gpgbin /usr/bin/gpg' --define '_gpg_digest_algo sha256' "$fixture" >/dev/null 2>&1

# Key file dengan fingerprint PGDG yang benar tetap ditolak bila mengandung key kedua.
cat /tmp/key /tmp/fixture-public.key >/tmp/key-bundle
if /tmp/verify-pgdg-repo-rpm.sh /tmp/key-bundle /tmp/signed-repo.rpm "$expected" >/tmp/key-bundle.out 2>&1; then
  echo "CANDIDATE_ACCEPTED_EXTRA_KEY_BUNDLE" >&2
  exit 5
fi
grep -Fq "File key PGDG harus berisi tepat satu public key dengan fingerprint yang diharapkan." /tmp/key-bundle.out
if rpmkeys --define '_pkgverify_level all' --checksig --verbose "$fixture" >/tmp/untrusted-check.out 2>&1; then
  echo "BUNDLED_EXTRA_KEY_ENTERED_GLOBAL_TRUST_STORE" >&2
  exit 6
fi
echo "KEY_BUNDLE_REJECTED_WITHOUT_TRUSTING_EXTRA_KEY"

rpmkeys --import /tmp/fixture-public.key
signed="$(rpmkeys --define '_pkgverify_level all' --checksig --verbose "$fixture")"
[[ "$signed" == *"key ID $other_key_id: OK"* ]]
if /tmp/verify-pgdg-repo-rpm.sh /tmp/key "$fixture" "$expected" >/tmp/other-signer.out 2>&1; then
  echo "CANDIDATE_ACCEPTED_UNAUTHORIZED_SIGNER" >&2
  exit 7
fi
if ! grep -Eiq "key ID $other_key_id: OK" /tmp/other-signer.out; then
  cat /tmp/other-signer.out >&2
  exit 11
fi
grep -Fq "Signature repo RPM bukan dari key PGDG yang diharapkan." /tmp/other-signer.out
if rpm -q pgdg-verification-fixture; then
  echo "OTHER_SIGNER_PACKAGE_INSTALLED" >&2
  exit 8
fi
if test -e /usr/share/pgdg-verification-fixture/payload || test -e /tmp/pgdg-verification-scriptlet; then
  echo "OTHER_SIGNER_PAYLOAD_OR_SCRIPTLET_EXECUTED" >&2
  exit 9
fi

# Perubahan payload setelah signing merusak digest/signature dan harus berhenti sebelum instalasi.
cp "$fixture" /tmp/corrupt.rpm
size="$(stat -c '%s' /tmp/corrupt.rpm)"
printf '\\000' | dd of=/tmp/corrupt.rpm bs=1 seek="$((size - 32))" count=1 conv=notrunc status=none
if rpmkeys --define '_pkgverify_level all' --checksig --verbose /tmp/corrupt.rpm >/tmp/corrupt-check.out 2>&1; then
  echo "DAMAGED_RPM_PASSED_STRICT_CHECKSIG" >&2
  exit 10
fi
if /tmp/verify-pgdg-repo-rpm.sh /tmp/key /tmp/corrupt.rpm "$expected" >/tmp/corrupt.out 2>&1; then
  echo "CANDIDATE_ACCEPTED_DAMAGED_SIGNATURE" >&2
  exit 11
fi
if rpm -q pgdg-verification-fixture; then
  echo "CORRUPT_PACKAGE_INSTALLED" >&2
  exit 12
fi
if test -e /usr/share/pgdg-verification-fixture/payload || test -e /tmp/pgdg-verification-scriptlet; then
  echo "CORRUPT_PAYLOAD_OR_SCRIPTLET_EXECUTED" >&2
  exit 13
fi
echo "UNAUTHORIZED_SIGNER_REJECTED"
echo "CORRUPT_RPM_REJECTED"
echo "REJECTED_PACKAGE_PAYLOAD_AND_SCRIPTLET_ABSENT"`;
  const result = await runVerifierInContainer(script);
  if (result.code !== 0) throw new Error(mask(`Probe RPM negatif gagal (${result.code}):\n${result.stdout}\n${result.stderr}`));
  expect(result.stdout).toContain("UNSIGNED_RPM_REJECTED");
  expect(result.stdout).toContain("KEY_BUNDLE_REJECTED_WITHOUT_TRUSTING_EXTRA_KEY");
  expect(result.stdout).toContain("UNAUTHORIZED_SIGNER_REJECTED");
  expect(result.stdout).toContain("CORRUPT_RPM_REJECTED");
  expect(result.stdout).toContain("REJECTED_PACKAGE_PAYLOAD_AND_SCRIPTLET_ABSENT");
}, 300000);

const nestedName = "INFRA-005 tanpa daemon skenario Docker dilaporkan dilewati dengan alasan, bukan lulus";
test.skipIf(nested)(nested ? nestedName + nestedLabel : nestedName, async () => {
  const report = resolve(workspace, "tanpa-daemon.xml");
  const env = cleanEnvironment();
  delete env.DOCKER_CONTEXT;
  Object.assign(env, { DOCKER_HOST: "unix:///nonexistent/docker.sock", FOUNDATION_INFRA_NESTED: "1" });
  const result = await run([process.execPath, "test", import.meta.path, "--reporter=junit", `--reporter-outfile=${report}`], { env, timeout: 120000 });
  expect(result.code).toBe(0);

  const cases = [...(await Bun.file(report).text()).matchAll(/<testcase name="([^"]*)"[^>]*?(\/)?>(\s*<(skipped|failure|error)\b)?/g)]
    .map(([, name, selfClosing, , state]) => ({ name, state: selfClosing ? "pass" : state ?? "pass" }))
    .filter((testCase) => !testCase.name.endsWith(nestedLabel));
  const source = await Bun.file(import.meta.path).text();
  const requiresDocker = (source.match(/^daemonTest\(/gm)?.length ?? 0) + (docker.cli ? 0 : source.match(/^cliTest\(/gm)?.length ?? 0);
  const reason = docker.cli ? "Docker daemon tidak dapat dihubungi" : docker.reason;
  expect(cases.filter((testCase) => testCase.state === "failure" || testCase.state === "error")).toEqual([]);
  expect(cases.filter((testCase) => testCase.state === "skipped").length).toBe(requiresDocker);
  for (const testCase of cases) expect(testCase.name.endsWith(`(dilewati: ${reason})`)).toBe(testCase.state === "skipped");
  expect(cases.some((testCase) => testCase.state === "pass")).toBe(true);
}, 120000);

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
  expect(image.Config.Env.map((entry: string) => entry.split("=")[0]).sort()).toEqual(["PATH", "PGDATA", "TZ"]);
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

  expect(await rejection(main, randomBytes(32).toString("hex"))).toMatch(/password authentication failed/i);

  expect((await compose(main, ["port", "postgres", "5432"])).stdout.trim()).toBe(`127.0.0.1:${main.port}`);
  const bindings = JSON.parse((await dockerCommand(["inspect", "--format", "{{json .NetworkSettings.Ports}}", await containerId(main)])).stdout);
  expect(bindings["5432/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: String(main.port) }]);
  const environ = await exec(main, "cat", "/proc/1/environ");
  expect(environ.includes("POSTGRES_PASSWORD=") || environ.includes(main.password)).toBe(false);
}, 300000);

// Harus berjalan sebelum INFRA-004: down lalu up membuat container baru dan membuang log serta /tmp inisialisasi.
daemonTest(label("INFRA-003 password admin tidak muncul di log inisialisasi dan file password sementara sudah dihapus", docker.daemon), async () => {
  const result = await compose(main, ["logs", "--no-color", "postgres"]);
  const logs = result.stdout + result.stderr;
  expect(logs).toContain("Cluster baru siap");
  expect(logs.includes(main.password)).toBe(false);
  // Socket Unix server dan lock-nya memang tinggal di /tmp; selain itu tidak boleh ada sisa file.
  expect(await exec(main, "find", "/tmp", "-mindepth", "1", "!", "-name", ".s.PGSQL.5432*")).toBe("");
}, 60000);

daemonTest(label("INFRA-003 zona waktu bernama seperti Asia/Jakarta diterima karena tzdata terpasang", docker.daemon), async () => {
  const sql = connect(main);
  try {
    const [row] = await sql`SELECT (TIMESTAMPTZ '2026-01-01 00:00:00+00' AT TIME ZONE 'Asia/Jakarta')::text AS local`;
    expect(row.local).toBe("2026-01-01 07:00:00");
  } finally { await sql.close(); }
}, 60000);

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

daemonTest(label("INFRA-006 cluster yang ada tidak diinisialisasi ulang saat password di env berubah", docker.daemon), async () => {
  const before = await systemIdentifier(main);
  const original = await Bun.file(main.envFile).text();
  const replacement = randomBytes(32).toString("hex");
  secrets.push(replacement);
  await writeFile(main.envFile, original.replace(`FOUNDATION_POSTGRES_PASSWORD=${main.password}\n`, `FOUNDATION_POSTGRES_PASSWORD=${replacement}\n`), { mode: 0o600 });
  try {
    await up(main);
    const env: string[] = JSON.parse((await dockerCommand(["inspect", "--format", "{{json .Config.Env}}", await containerId(main)])).stdout);
    expect(env.includes(`POSTGRES_PASSWORD=${replacement}`)).toBe(true);
    expect(await systemIdentifier(main)).toBe(before);
    expect(await rejection(main, replacement)).toMatch(/password authentication failed/i);
    const originalConnection = connect(main);
    try {
      const [row] = await originalConnection`SELECT current_user AS "user"`;
      expect(row.user).toBe("foundation_admin");
    } finally { await originalConnection.close(); }
  } finally { await writeFile(main.envFile, original, { mode: 0o600 }); }
}, 300000);

daemonTest(label("INFRA-006 volume baru menolak password pendek dan identifier tidak valid tanpa membuat cluster", docker.daemon), async () => {
  const stack = await createStack();
  const short = randomBytes(8).toString("hex").slice(0, 15);
  secrets.push(short);
  const attempts: [variable: string, value: string, message: string][] = [
    ["POSTGRES_PASSWORD", short, "minimal 16 karakter"],
    ["POSTGRES_PASSWORD", "", "minimal 16 karakter"],
    ["POSTGRES_PASSWORD", `${stack.password}\nbaris-kedua`, "tidak boleh memuat baris baru"],
    ["POSTGRES_USER", "Admin", "POSTGRES_USER harus identifier"],
    ["POSTGRES_DB", 'foundation"; DROP DATABASE postgres; --', "POSTGRES_DB harus identifier"],
  ];
  for (const [variable, value, message] of attempts) {
    const attempt = await compose(stack, ["run", "--rm", "-T", "--no-deps", "-e", `${variable}=${value}`, "postgres"], { allowFailure: true, timeout: 120000 });
    const output = attempt.stdout + attempt.stderr;
    expect(attempt.code).not.toBe(0);
    expect(output).toContain(message);
    if (variable === "POSTGRES_PASSWORD" && value) expect(output.includes(value.split("\n")[0])).toBe(false);
  }
  expect((await oneOff(stack, "ls -A /var/lib/pgsql/18")).split(/\s+/).filter(Boolean)).toEqual(["backups"]);
  await removeStack(stack);
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
