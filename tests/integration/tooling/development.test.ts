import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDoctor } from "../../../scripts/doctor";
import { readyTargets, services, supervise } from "../../../scripts/serve";
import { insideRoot, loadConfig, selectWorkers, type DevelopmentConfig } from "../../../scripts/lib/development";
import { clearPorts, listeners, type PortOwnerState } from "../../../scripts/lib/ports";
import { captureProcess, groupAlive, processIdentity, signalVerifiedGroup, type ProcessIdentity } from "../../../scripts/lib/process-identity";
import { Invocation } from "../../../scripts/lib/invocation";
import { STARTUP_TIMEOUT_MS, waitForReadiness, type ReadyTarget } from "../../../scripts/lib/readiness";

const temporaryDirectories: string[] = [];
const fixtureProcesses: ReturnType<typeof Bun.spawn>[] = [];
const descendantPids: number[] = [];
const environment = { ...process.env };

afterEach(async () => {
  for (const child of fixtureProcesses.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
  for (const key of ["DATABASE_URL", "NOTIFICATION_DATABASE_URL", "NODE_ENV", "SESSION_SECRET", "MAIL_API_KEY"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "foundation-tooling-"));
  temporaryDirectories.push(root);
  return root;
}

function config(): DevelopmentConfig {
  return {
    host: "127.0.0.1", frontend: { port: 8889, workspace: "apps/frontend", proxyConfig: "proxy.conf.json" },
    backend: { port: 8888, entry: "apps/backend/src/index.ts" },
    database: { expectedName: "foundation", schemas: ["common", "users", "auth"], migrationSchema: "common" }, workers: {},
  };
}

async function fixtureListener(ignoreTerm = false, body = "fixture", contentType = "text/plain"):
  Promise<{ port: number; child: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn([process.execPath, "-e", `
    ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''}
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(${JSON.stringify(body)}, { headers: { "content-type": ${JSON.stringify(contentType)} } }) });
    console.log(server.port);
  `], { stdout: "pipe", stderr: "ignore", detached: true });
  fixtureProcesses.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(first.value).trim());
  if (!port) throw new Error("Fixture listener tidak siap.");
  return { port, child };
}

async function fixturePathListener(path: string): Promise<{ port: number; child: ReturnType<typeof Bun.spawn> }> {
  const child = Bun.spawn([process.execPath, "-e", `
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: (request) => new URL(request.url).pathname === ${JSON.stringify(path)}
        ? new Response("ready") : new Response("not found", { status: 404 }) });
    console.log(server.port);
  `], { stdout: "pipe", stderr: "ignore", detached: true });
  fixtureProcesses.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(first.value).trim());
  if (!port) throw new Error("Fixture listener tidak siap.");
  return { port, child };
}

test("TOOL-001 doctor reports missing prerequisites without stopping a listener or leaking credentials", async () => {
  const root = await temporaryRoot();
  const listener = await fixtureListener();
  const selected = config();
  selected.backend.port = listener.port;
  process.env.DATABASE_URL = "invalid-url-with-private-secret";
  process.env.NODE_ENV = "development";
  const checks = await runDoctor(selected, [], root);
  expect(checks.some((item) => item.name === "Entry backend" && item.status === "error")).toBe(true);
  expect(checks.find((item) => item.name === `Port ${listener.port}`)).toEqual({ name: `Port ${listener.port}`, status: "warning",
    message: "Sedang dipakai; serve hanya menggantikan proses Foundation lama dari checkout ini dan gagal bila pemiliknya lain." });
  expect(JSON.stringify(checks)).not.toContain("private-secret");
  expect((await listeners(listener.port)).some((item) => item.pid === listener.child.pid)).toBe(true);
});

test("TOOL-002 cleanup only stops the configured fixture listener", async () => {
  const target = await fixtureListener();
  const other = await fixtureListener();
  await clearPorts([target.port], [await captureProcess(target.child.pid)], () => {});
  expect(await listeners(target.port)).toEqual([]);
  expect((await listeners(other.port)).some((item) => item.pid === other.child.pid)).toBe(true);
  expect(await fetch(`http://127.0.0.1:${other.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-002 cleanup escalates when the fixture ignores SIGTERM", async () => {
  const target = await fixtureListener(true);
  const messages: string[] = [];
  await clearPorts([target.port], [await captureProcess(target.child.pid)], (message) => { messages.push(message); }, 50);
  expect(messages.some((message) => message.includes("SIGKILL"))).toBe(true);
  expect(await listeners(target.port)).toEqual([]);
});

test("TOOL-002 cleanup refuses an unrecorded listener", async () => {
  const target = await fixtureListener();
  await expect(clearPorts([target.port], [])).rejects.toThrow("bukan proses Foundation lama");
  expect((await listeners(target.port)).some((item) => item.pid === target.child.pid)).toBe(true);
});

test("TOOL-002 cleanup rejects a reused PID identity without signaling it", async () => {
  const target = await fixtureListener();
  const captured = await captureProcess(target.child.pid);
  const stale = { ...captured, started: `${captured.started} changed` };
  await expect(clearPorts([target.port], [stale], () => {})).rejects.toThrow("bukan proses Foundation lama");
  expect(await fetch(`http://127.0.0.1:${target.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-002 cleanup rechecks port ownership immediately before SIGTERM", async () => {
  const target = await fixtureListener();
  const foreign = await fixtureListener();
  const [foreignOwner] = await listeners(foreign.port);
  if (!foreignOwner) throw new Error("Listener fixture asing tidak ditemukan.");
  const group = await captureProcess(target.child.pid);
  let ownerChanged = false;
  let signals = 0;
  const readListeners = async (port: number) => {
    if (port !== target.port || !ownerChanged) return listeners(port);
    return [foreignOwner];
  };
  const signal = async (identity: typeof group, requested: NodeJS.Signals,
    verifyTarget?: () => Promise<boolean>) => {
    ownerChanged = true;
    signals++;
    return signalVerifiedGroup(identity, requested, verifyTarget);
  };

  await expect(clearPorts([target.port], [group], () => {}, 0, {
    listeners: readListeners,
    signal,
  })).rejects.toThrow("listener port berubah sebelum SIGTERM");
  expect(signals).toBe(1);
  expect(await fetch(`http://127.0.0.1:${target.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-002 cleanup rechecks port ownership immediately before SIGKILL", async () => {
  const target = await fixtureListener(true);
  const foreign = await fixtureListener();
  const [foreignOwner] = await listeners(foreign.port);
  if (!foreignOwner) throw new Error("Listener fixture asing tidak ditemukan.");
  const group = await captureProcess(target.child.pid);
  let ownerChanged = false;
  const sent: NodeJS.Signals[] = [];
  const readListeners = async (port: number) => {
    if (port !== target.port || !ownerChanged) return listeners(port);
    return [foreignOwner];
  };
  const signal = async (identity: typeof group, requested: NodeJS.Signals,
    verifyTarget?: () => Promise<boolean>) => {
    if (requested === "SIGKILL") ownerChanged = true;
    const result = await signalVerifiedGroup(identity, requested, verifyTarget);
    if (result) sent.push(requested);
    return result;
  };

  await expect(clearPorts([target.port], [group], () => {}, 0, {
    listeners: readListeners,
    signal,
  })).rejects.toThrow("listener port berubah sebelum SIGKILL");
  expect(sent).toEqual(["SIGTERM"]);
  expect(await fetch(`http://127.0.0.1:${target.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-003 worker selection is explicit, deduplicated, and rejects unknown workers", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts" };
  expect(selectWorkers([], selected)).toEqual([]);
  expect(selectWorkers(["--worker", "notification", "--worker=notification"], selected)).toEqual(["notification"]);
  expect(() => selectWorkers(["--worker", "missing"], selected)).toThrow("belum terdaftar");
  expect(() => selectWorkers(["--worker", "__proto__"], selected)).toThrow("belum terdaftar");
});

test("TOOL-003 service configuration isolates database credentials and uses the requested ports", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", databaseUrlEnv: "NOTIFICATION_DATABASE_URL", schemas: ["users"] };
  selected.workers.report = { entry: "apps/worker/report/src/index.ts" };
  process.env.DATABASE_URL = "backend-private-url";
  process.env.NOTIFICATION_DATABASE_URL = "notification-private-url";
  process.env.SESSION_SECRET = "private-session-key";
  process.env.FOUNDATION_ADMIN_DATABASE_URL = "admin-private-url";
  process.env.FOUNDATION_MIGRATOR_DATABASE_URL = "migrator-private-url";
  process.env.FOUNDATION_MIGRATOR_PASSWORD = "migrator-private-password";
  process.env.FOUNDATION_BACKEND_PASSWORD = "backend-private-password";
  const definitions = services(selected, ["notification", "report"]);
  expect(definitions[0].env.PORT).toBe("8888");
  expect(definitions[0].env.DATABASE_URL).toBe("backend-private-url");
  expect(definitions[0].command).toContain("--no-env-file");
  expect(definitions[1].command).toContain("8889");
  expect(definitions[1].env.DATABASE_URL).toBeUndefined();
  expect(definitions[1].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[2].env.DATABASE_URL).toBe("notification-private-url");
  expect(definitions[2].command).toContain("--no-env-file");
  expect(definitions[3].env.DATABASE_URL).toBeUndefined();
  expect(definitions[2].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[3].env.SESSION_SECRET).toBeUndefined();
  expect(definitions.every((item) => item.env.NOTIFICATION_DATABASE_URL === undefined)).toBe(true);
  for (const key of ["FOUNDATION_ADMIN_DATABASE_URL", "FOUNDATION_MIGRATOR_DATABASE_URL", "FOUNDATION_MIGRATOR_PASSWORD", "FOUNDATION_BACKEND_PASSWORD"]) {
    expect(definitions.every((item) => item.env[key] === undefined)).toBe(true);
    delete process.env[key];
  }
});

test("BKP-008 serve does not pass FOUNDATION_BACKUP_PASSWORD and FOUNDATION_BACKUP_DATABASE_URL to any child process", () => {
  // Spec 0013 AC-4: the backup credentials are removed like the provisioning ones, for the backend, the frontend, and
  // every selected worker, including a worker that names one of them in its own `env` list.
  const keys = ["FOUNDATION_BACKUP_PASSWORD", "FOUNDATION_BACKUP_DATABASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.FOUNDATION_BACKUP_PASSWORD = "backup-private-password";
    process.env.FOUNDATION_BACKUP_DATABASE_URL = "postgres://foundation_backup:backup-private-password@postgres:5432/foundation";
    const selected = config();
    selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", databaseUrlEnv: "NOTIFICATION_DATABASE_URL", schemas: ["users"] };
    selected.workers.report = { entry: "apps/worker/report/src/index.ts", env: ["MAIL_API_KEY"] };
    const definitions = services(selected, ["notification", "report"]);
    expect(definitions.map((item) => item.name)).toEqual(["backend", "frontend", "worker:notification", "worker:report"]);
    for (const definition of definitions) {
      for (const key of keys) expect(definition.env[key], `${definition.name} ${key}`).toBeUndefined();
      expect(JSON.stringify(definition.env)).not.toContain("backup-private-password");
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("TOOL-003 configuration rejects overlapping worker ports and paths outside the repository", async () => {
  const root = await temporaryRoot();
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", port: 8888 };
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  await expect(loadConfig(root)).rejects.toThrow("tumpang tindih");
  expect(() => insideRoot(root, "../outside.ts")).toThrow("di dalam root");
});

test("TOOL-003 worker HTTP readiness path is required and local", async () => {
  const root = await temporaryRoot();
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", port: 9001 };
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  await expect(loadConfig(root)).rejects.toThrow("readinessPath");
  selected.workers.notification.readinessPath = "//other-host/status";
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  await expect(loadConfig(root)).rejects.toThrow("readinessPath");
  selected.workers.notification.readinessPath = "/ready";
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  expect((await loadConfig(root)).workers.notification.readinessPath).toBe("/ready");
});

test("TOOL-003 selected HTTP worker must answer on its configured readiness path", async () => {
  const worker = await fixturePathListener("/ready");
  const group = await captureProcess(worker.child.pid);
  const target = { name: "worker:notification", port: worker.port, path: "/ready", kind: "worker" as const };
  await waitForReadiness([target], [group], new AbortController().signal, 2000);
  await expect(waitForReadiness([{ ...target, path: "/wrong" }], [group],
    new AbortController().signal, 350)).rejects.toThrow("batas waktu");
});

test("TOOL-004 service failure stops the other service and its stubborn descendant", async () => {
  const root = await temporaryRoot();
  const identityFile = resolve(root, "listener.json");
  const descendant = `
    process.on("SIGTERM", () => {});
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
    console.log(JSON.stringify({ port: server.port, pid: process.pid }));
  `;
  const parent = `
    process.on("SIGTERM", () => {});
    const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendant)}], { stdout: "pipe", stderr: "ignore" });
    const first = await child.stdout.getReader().read();
    await Bun.write(${JSON.stringify(identityFile)}, first.value);
    await child.exited;
  `;
  const failing = `
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(${JSON.stringify(identityFile)}).exists())) {
      if (Date.now() > deadline) process.exit(8);
      await Bun.sleep(20);
    }
    process.exit(7);
  `;
  const result = await supervise([
    { name: "fixture-parent", command: [process.execPath, "-e", parent], cwd: root, env: {} },
    { name: "fixture-failure", command: [process.execPath, "-e", failing], cwd: root, env: {} },
  ]);
  const identity = await Bun.file(identityFile).json();
  descendantPids.push(identity.pid);
  expect(result).toBe(7);
  expect(await listeners(identity.port)).toEqual([]);
}, 10000);

test("TOOL-004 termination stops the supervised listener", async () => {
  const root = await temporaryRoot();
  const identityFile = resolve(root, "service.json");
  const service = `
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    await Bun.write(${JSON.stringify(identityFile)}, JSON.stringify({ port: server.port, pid: process.pid }));
  `;
  const servePath = resolve(import.meta.dir, "../../../scripts/serve.ts");
  const runner = Bun.spawn([process.execPath, "-e", `
    const { supervise } = await import(${JSON.stringify(servePath)});
    process.exitCode = await supervise([{ name: "fixture", command: [process.execPath, "-e", ${JSON.stringify(service)}], cwd: ${JSON.stringify(root)}, env: {} }]);
  `], { stdout: "ignore", stderr: "ignore" });
  fixtureProcesses.push(runner);
  const deadline = Date.now() + 3000;
  while (!(await Bun.file(identityFile).exists())) {
    if (Date.now() >= deadline) throw new Error("Fixture supervisor tidak siap.");
    await Bun.sleep(20);
  }
  const identity = await Bun.file(identityFile).json();
  const port = Number(identity.port);
  const pid = Number(identity.pid);
  if (!Number.isInteger(port) || !Number.isInteger(pid)) throw new Error("Identitas fixture tidak lengkap.");
  descendantPids.push(pid);
  runner.kill("SIGTERM");
  expect(await runner.exited).toBe(143);
  expect(await listeners(port)).toEqual([]);
}, 8000);

test("TOOL-004 Ctrl+C stops the supervised listener", async () => {
  const root = await temporaryRoot();
  const identityFile = resolve(root, "service.json");
  const service = `
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    await Bun.write(${JSON.stringify(identityFile)}, JSON.stringify({ port: server.port, pid: process.pid }));
  `;
  const servePath = resolve(import.meta.dir, "../../../scripts/serve.ts");
  const runner = Bun.spawn([process.execPath, "-e", `
    const { supervise } = await import(${JSON.stringify(servePath)});
    process.exitCode = await supervise([{ name: "fixture", command: [process.execPath, "-e", ${JSON.stringify(service)}], cwd: ${JSON.stringify(root)}, env: {} }]);
  `], { stdout: "ignore", stderr: "ignore" });
  fixtureProcesses.push(runner);
  const deadline = Date.now() + 3000;
  while (!(await Bun.file(identityFile).exists())) {
    if (Date.now() >= deadline) throw new Error("Fixture supervisor tidak siap.");
    await Bun.sleep(20);
  }
  const identity = await Bun.file(identityFile).json();
  const port = Number(identity.port);
  const pid = Number(identity.pid);
  if (!Number.isInteger(port) || !Number.isInteger(pid)) throw new Error("Identitas fixture tidak lengkap.");
  descendantPids.push(pid);
  runner.kill("SIGINT");
  expect(await runner.exited).toBe(130);
  expect(await listeners(port)).toEqual([]);
}, 8000);

test("TOOL-005 a second invocation cannot take the active lock", async () => {
  const root = await temporaryRoot();
  const first = await Invocation.acquire(root);
  try { await expect(Invocation.acquire(root)).rejects.toThrow("masih aktif"); }
  finally { await first.release(); }
  const next = await Invocation.acquire(root);
  await next.release();
});

test("TOOL-005 an incomplete invocation lock fails safely within five seconds", async () => {
  const root = await temporaryRoot();
  await mkdir(resolve(root, ".local/serve.lock"), { recursive: true });
  const started = performance.now();
  await expect(Invocation.acquire(root)).rejects.toThrow("Catatan serve belum lengkap");
  expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
  expect(performance.now() - started).toBeLessThan(6500);
}, 7000);

test("TOOL-005 recovery rejects groups whose recorded checkout differs", async () => {
  const root = await temporaryRoot();
  const checkout = await realpath(root);
  const target = await fixtureListener();
  const group = await captureProcess(target.child.pid);
  const supervisor = await captureProcess(process.pid);
  await mkdir(resolve(root, ".local/serve.lock"), { recursive: true });
  await writeFile(resolve(root, ".local/serve.lock/owner.json"), JSON.stringify({
    token: "stale", checkout, uid: process.getuid?.() ?? -1,
    supervisor: { ...supervisor, started: `${supervisor.started} stale` }, groups: [group],
  }), { mode: 0o600 });
  await expect(Invocation.acquire(root)).rejects.toThrow("Grup invocation lama bukan milik checkout ini");
  expect(await fetch(`http://127.0.0.1:${target.port}`).then((response) => response.text())).toBe("fixture");
});

test("TOOL-005 one recovery can take a stale invocation lock", async () => {
  const root = await temporaryRoot();
  const modulePath = resolve(import.meta.dir, "../../../scripts/lib/invocation.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    const { Invocation } = await import(${JSON.stringify(modulePath)});
    await Invocation.acquire(${JSON.stringify(root)});
  `], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const recovered = await Invocation.acquire(root);
  expect(recovered.staleGroups).toEqual([]);
  await recovered.release();
  const afterFailedPreflight = await Invocation.acquire(root);
  expect(afterFailedPreflight.staleGroups).toEqual([]);
  await afterFailedPreflight.clearStale();
  await afterFailedPreflight.release();
});

test("TOOL-005 concurrent invocations allow one owner", async () => {
  const root = await temporaryRoot();
  const modulePath = resolve(import.meta.dir, "../../../scripts/lib/invocation.ts");
  const gate = resolve(root, "start");
  const code = `
    const { Invocation } = await import(${JSON.stringify(modulePath)});
    while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(10);
    try {
      const owner = await Invocation.acquire(${JSON.stringify(root)});
      console.log("acquired");
      await Bun.sleep(600);
      await owner.release();
    } catch { console.log("rejected"); }
  `;
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, "-e", code],
    { stdout: "pipe", stderr: "ignore" }));
  await Bun.write(gate, "go");
  const outcomes = await Promise.all(children.map(async (child) => {
    const [out, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(0);
    return out.trim();
  }));
  expect(outcomes.sort()).toEqual(["acquired", "rejected"]);
});

test("TOOL-005 stale invocation can clear its recorded listener", async () => {
  const root = await temporaryRoot();
  const identityFile = resolve(root, "old-service.json");
  const invocationPath = resolve(import.meta.dir, "../../../scripts/lib/invocation.ts");
  const identityPath = resolve(import.meta.dir, "../../../scripts/lib/process-identity.ts");
  const old = Bun.spawn([process.execPath, "-e", `
    const { Invocation } = await import(${JSON.stringify(invocationPath)});
    const { captureProcess } = await import(${JSON.stringify(identityPath)});
    const owner = await Invocation.acquire(${JSON.stringify(root)});
    const child = Bun.spawn([process.execPath, "-e", 'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("old") }); console.log(server.port);'],
      { cwd: ${JSON.stringify(root)}, detached: true, stdout: "pipe", stderr: "ignore" });
    const first = await child.stdout.getReader().read();
    const port = Number(new TextDecoder().decode(first.value).trim());
    await owner.recordGroup(await captureProcess(child.pid));
    await Bun.write(${JSON.stringify(identityFile)}, JSON.stringify({ port, pid: child.pid }));
    process.exit(0);
  `], { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(old.stderr).text(), old.exited]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const identity = await Bun.file(identityFile).json();
  const port = Number(identity.port);
  const pid = Number(identity.pid);
  if (!Number.isInteger(port) || !Number.isInteger(pid)) throw new Error("Identitas fixture tidak lengkap.");
  descendantPids.push(pid);
  expect((await listeners(port)).some((item) => item.pid === pid)).toBe(true);
  const recovered = await Invocation.acquire(root);
  try {
    await clearPorts([port], recovered.staleGroups, () => {});
    await recovered.clearStale();
  } finally { await recovered.release(); }
  expect(await listeners(port)).toEqual([]);
});

test("TOOL-002 cleanup stops a recorded worker group without an HTTP port", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    process.on("SIGTERM", () => {});
    await Bun.sleep(100000);
  `], { stdout: "ignore", stderr: "ignore", detached: true });
  fixtureProcesses.push(child);
  const group = await captureProcess(child.pid);
  await clearPorts([], [group], () => {}, 50);
  expect(await child.exited).not.toBe(0);
});

test("TOOL-006 readiness timeout stops the supervised process", async () => {
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port;
  reserve.stop();
  if (!port) throw new Error("Port fixture tidak tersedia.");
  const result = await supervise([{ name: "wrong-backend", cwd: projectRootForTest(), env: {}, command: [process.execPath, "-e", `
    Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ status: "wrong" }) });
  `] }], { ready: [{ name: "wrong-backend", port, path: "/api/status", kind: "backend" }], timeoutMs: 350 });
  expect(result).toBe(1);
  expect(await listeners(port)).toEqual([]);
});

test("TOOL-006 readiness retries after an empty port snapshot before the owned listener appears", async () => {
  const target = await fixtureListener(false, "ready");
  const observed: string[] = [];
  await waitForReadiness([{ name: "worker:fixture", port: target.port, path: "/", kind: "worker" }], [],
    new AbortController().signal, 3000, {
      inspectOwner: async () => {
        const state = observed.length === 0 ? "absent" : "owned";
        observed.push(state);
        return state;
      },
    });
  expect(observed).toEqual(["absent", "owned", "owned", "owned"]);
});

test("TOOL-006 readiness rejects an HTTP response completed after the startup deadline", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(300);
      return Response.json({ status: "ok" });
    },
  });
  try {
    await expect(waitForReadiness([{ name: "backend:slow", port: server.port!, path: "/", kind: "backend" }], [],
      new AbortController().signal, 80, { inspectOwner: async () => "owned" })).rejects.toThrow("batas waktu");
  } finally {
    server.stop(true);
  }
});

function projectRootForTest(): string {
  return resolve(import.meta.dir, "../../..");
}

test("TOOL-006 readiness accepts owned HTTP responses and rejects a foreign port", async () => {
  const frontend = await fixtureListener(false, "<html></html>", "text/html");
  const backend = await fixtureListener(false, JSON.stringify({ status: "ok" }), "application/json");
  const targets = [
    { name: "frontend", port: frontend.port, path: "/", kind: "frontend" as const },
    { name: "backend", port: backend.port, path: "/api/status", kind: "backend" as const },
  ];
  const groups = [await captureProcess(frontend.child.pid), await captureProcess(backend.child.pid)];
  await waitForReadiness(targets, groups, new AbortController().signal, 2000);
  await expect(waitForReadiness(targets, [groups[0]], new AbortController().signal, 2000))
    .rejects.toThrow("bukan milik invocation");
});

test("TOOL-006 readiness times out on the wrong HTTP body", async () => {
  const backend = await fixtureListener(false, JSON.stringify({ status: "wrong" }), "application/json");
  const group = await captureProcess(backend.child.pid);
  await expect(waitForReadiness([
    { name: "backend", port: backend.port, path: "/api/status", kind: "backend" },
  ], [group], new AbortController().signal, 350)).rejects.toThrow("batas waktu");
});

test("TOOL-006 readiness rejects a non HTML frontend body", async () => {
  const frontend = await fixtureListener(false, "ready", "text/html");
  const group = await captureProcess(frontend.child.pid);
  await expect(waitForReadiness([
    { name: "frontend", port: frontend.port, path: "/", kind: "frontend" },
  ], [group], new AbortController().signal, 350)).rejects.toThrow("batas waktu");
});

test("TOOL-008 production mode and invalid database target fail before cleanup", async () => {
  const root = await temporaryRoot();
  const target = await fixtureListener();
  const selected = config();
  selected.backend.port = target.port;
  process.env.NODE_ENV = "production";
  delete process.env.DATABASE_URL;
  const checks = await runDoctor(selected, [], root);
  expect(checks.some((item) => item.name === "Environment" && item.status === "error")).toBe(true);
  expect((await listeners(target.port)).some((item) => item.pid === target.child.pid)).toBe(true);
  selected.backend.port = 8888;
  selected.database.expectedName = "wrong-name";
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(selected));
  await expect(loadConfig(root)).rejects.toThrow("Daftar schema");
});

// Spec 0003, /test 2026-10-04: CLI level proofs and the remaining AC-1, AC-3, AC-5, AC-6, and AC-7 cases from
// verify.md that were only checked by hand. CLI cases run a copy of scripts/ inside a temporary checkout, so they
// never take the real .local/serve.lock and never signal anything on ports 8888 or 8889.

/** A temporary checkout with a copy of scripts/ and the given config; `projectRoot` of the copy is that checkout. */
async function temporaryCheckout(configuration: unknown = config()): Promise<string> {
  const root = await temporaryRoot();
  await cp(resolve(projectRootForTest(), "scripts"), resolve(root, "scripts"), { recursive: true });
  await Bun.write(resolve(root, "config/development.json"), JSON.stringify(configuration));
  return root;
}

/** Runs doctor or serve of a temporary checkout with an explicit environment (no inherited DATABASE_URL). */
async function runScript(root: string, script: "doctor" | "serve", args: string[] = [], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve(root, `scripts/${script}.ts`), ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "development", ...env },
  });
  fixtureProcesses.push(child);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** A loopback port that was free a moment ago. */
function reservePort(): number {
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port;
  reserve.stop(true);
  if (!port) throw new Error("Port fixture tidak tersedia.");
  return port;
}

/** A long running fixture process; detached makes it the leader of its own process group. */
function idleProcess(cwd: string, detached = true): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(100000)"], { cwd, detached, stdout: "ignore", stderr: "ignore" });
  fixtureProcesses.push(child);
  return child;
}

test("TOOL-001 doctor CLI exits 1 with a safe message when DATABASE_URL is missing", async () => {
  const root = await temporaryCheckout();
  const result = await runScript(root, "doctor");
  expect(result.code).toBe(1);
  expect(result.output).toContain("[ERROR] Database backend: DATABASE_URL belum disediakan melalui environment lokal.");
  expect(result.output).toContain("Doctor belum lulus; lengkapi prasyarat sebelum serve.");
});

test("TOOL-001 doctor CLI exits 1 on an unusable database URL without printing the DSN, password, or raw error", async () => {
  const root = await temporaryCheckout();
  const port = reservePort();
  for (const url of [`postgres://foundation_backend:cli-private-secret@127.0.0.1:${port}/foundation`,
    `mysql://foundation_backend:cli-private-secret@127.0.0.1:${port}/foundation`]) {
    const result = await runScript(root, "doctor", [], { DATABASE_URL: url });
    expect(result.code).toBe(1);
    expect(result.output).toContain("[ERROR] Database backend: PostgreSQL tidak dapat diverifikasi.");
    expect(result.output).not.toContain("cli-private-secret");
    expect(result.output).not.toMatch(/(postgres|postgresql|mysql):\/\//);
    expect(result.output).not.toMatch(/ECONNREFUSED|connection refused|Invalid database adapter|password authentication/i);
  }
});

test("TOOL-001 doctor stops waiting for a database that accepts TCP but never answers", async () => {
  const root = await temporaryRoot();
  const sockets: Socket[] = [];
  const silent = createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((done) => silent.listen(0, "127.0.0.1", () => done()));
  const address = silent.address();
  if (!address || typeof address === "string") throw new Error("Port fixture tidak tersedia.");
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = `postgres://foundation_backend:silent-private-secret@127.0.0.1:${address.port}/foundation`;
  try {
    const started = performance.now();
    const checks = await runDoctor(config(), [], root);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(7000);
    expect(sockets.length).toBeGreaterThan(0);
    expect(checks.filter((item) => item.name.startsWith("Database backend"))).toEqual([{ name: "Database backend", status: "error",
      message: "PostgreSQL tidak dapat diverifikasi. Periksa koneksi, role, schema, dan metadata migration; kredensial tidak dicetak." }]);
    expect(JSON.stringify(checks)).not.toContain("silent-private-secret");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => silent.close(() => done()));
  }
}, 12000);

test("TOOL-008 serve CLI in production mode stops at preflight, starts nothing, and releases its lock", async () => {
  const root = await temporaryCheckout();
  const result = await runScript(root, "serve", [], { NODE_ENV: "production" });
  expect(result.code).toBe(1);
  expect(result.output).toContain("[ERROR] Environment: Perintah ini khusus development.");
  expect(result.output).toContain("Doctor belum lulus");
  expect(result.output).not.toContain("Menjalankan ");
  expect(await exists(resolve(root, ".local/serve.lock"))).toBe(false);
});

test("TOOL-008 serve CLI rejects an invalid config before taking the lock", async () => {
  const selected = config();
  selected.backend.port = 9999;
  const root = await temporaryCheckout(selected);
  const result = await runScript(root, "serve");
  expect(result.code).toBe(1);
  expect(result.output).toContain("Port frontend harus 8889 dan backend harus 8888.");
  expect(result.output).not.toContain("Menjalankan ");
  expect(await exists(resolve(root, ".local/serve.lock"))).toBe(false);
});

test("TOOL-003 serve CLI rejects an unknown worker before taking the lock", async () => {
  const root = await temporaryCheckout();
  const result = await runScript(root, "serve", ["--worker", "tidak-ada"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("Worker belum terdaftar di config/development.json.");
  expect(result.output).not.toContain("Menjalankan ");
  expect(await exists(resolve(root, ".local/serve.lock"))).toBe(false);
});

test("TOOL-005 a second serve CLI from the same checkout fails clearly and leaves the active invocation untouched", async () => {
  const root = await temporaryCheckout();
  const active = await Invocation.acquire(root);
  try {
    const ownerPath = resolve(root, ".local/serve.lock/owner.json");
    const before = await readFile(ownerPath, "utf8");
    const result = await runScript(root, "serve");
    expect(result.code).toBe(1);
    expect(result.output).toContain("Serve lain dari checkout ini masih aktif.");
    expect(result.output).not.toContain("Doctor");
    expect(result.output).not.toContain("Menjalankan ");
    expect(await readFile(ownerPath, "utf8")).toBe(before);
  } finally { await active.release(); }
});

test("TOOL-005 the invocation record holds verifiable identities only and is private to the user", async () => {
  const root = await temporaryRoot();
  const checkout = await realpath(root);
  process.env.DATABASE_URL = "postgres://foundation_backend:record-private-secret@127.0.0.1:5432/foundation";
  const invocation = await Invocation.acquire(root);
  const lock = resolve(root, ".local/serve.lock");
  try {
    const group = await captureProcess(idleProcess(root).pid);
    await invocation.recordGroup(group);
    const raw = await readFile(resolve(lock, "owner.json"), "utf8");
    const record = JSON.parse(raw);
    expect((await stat(lock)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(lock, "owner.json"))).mode & 0o777).toBe(0o600);
    expect(Object.keys(record).sort()).toEqual(["checkout", "groups", "supervisor", "token", "uid"]);
    expect(record.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.checkout).toBe(checkout);
    expect(record.uid).toBe(process.getuid!());
    expect(record.supervisor).toMatchObject({ pid: process.pid, uid: process.getuid!(), pgid: expect.any(Number), started: expect.any(String) });
    expect(record.groups).toEqual([group]);
    expect(group.pgid).toBe(group.pid);
    expect(group.cwd).toBe(checkout);
    expect(raw).not.toContain("record-private-secret");
    expect(raw).not.toContain("DATABASE_URL");
    expect(raw).not.toContain("postgres://");
  } finally { await invocation.release(); }
  expect(await exists(lock)).toBe(false);
});

test("TOOL-005 an invocation refuses to record a group from another checkout or a process that does not lead its group", async () => {
  const root = await temporaryRoot();
  const other = await temporaryRoot();
  const invocation = await Invocation.acquire(root);
  try {
    const foreignCheckout = await captureProcess(idleProcess(other).pid);
    await expect(invocation.recordGroup(foreignCheckout)).rejects.toThrow("bukan milik checkout ini");
    const sharedGroup = await captureProcess(idleProcess(root, false).pid);
    expect(sharedGroup.pgid).not.toBe(sharedGroup.pid);
    await expect(invocation.recordGroup(sharedGroup)).rejects.toThrow("bukan milik checkout ini");
    const record = JSON.parse(await readFile(resolve(root, ".local/serve.lock/owner.json"), "utf8"));
    expect(record.groups).toEqual([]);
  } finally { await invocation.release(); }
});

test("TOOL-003 doctor requires the selected worker's own variables and database URL without printing their values", async () => {
  const root = await temporaryRoot();
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", env: ["MAIL_API_KEY"],
    databaseUrlEnv: "NOTIFICATION_DATABASE_URL", schemas: ["users"] };
  process.env.NODE_ENV = "development";
  for (const key of ["MAIL_API_KEY", "NOTIFICATION_DATABASE_URL", "DATABASE_URL"]) delete process.env[key];
  const find = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => checks.find((item) => item.name === name);

  const missing = await runDoctor(selected, ["notification"], root);
  expect(find(missing, "Entry worker notification")?.status).toBe("error");
  expect(find(missing, "Environment worker notification")).toEqual({ name: "Environment worker notification", status: "error",
    message: "MAIL_API_KEY harus disediakan; nilainya tidak dicetak." });
  expect(find(missing, "Database worker notification")).toEqual({ name: "Database worker notification", status: "error",
    message: "NOTIFICATION_DATABASE_URL belum disediakan melalui environment lokal." });

  process.env.MAIL_API_KEY = "mail-private-key";
  const provided = await runDoctor(selected, ["notification"], root);
  expect(find(provided, "Environment worker notification")?.status).toBe("ok");
  expect(JSON.stringify(provided)).not.toContain("mail-private-key");

  const unselected = await runDoctor(selected, [], root);
  expect(unselected.some((item) => item.name.includes("worker"))).toBe(false);
});

test("TOOL-003 a selected worker without a port that exits during startup fails startup before readiness is announced", async () => {
  const root = await temporaryRoot();
  const port = reservePort();
  const workerPid = resolve(root, "worker.pid");
  const groups: ProcessIdentity[] = [];
  let announced = false;
  // No fixed sleep decides the order: the backend listens only once the worker has exited and was reaped by supervise,
  // so readiness would pass right after the exit if supervise ignored it.
  const backend = `
    while (!(await Bun.file(${JSON.stringify(workerPid)}).exists())) await Bun.sleep(10);
    const pid = Number(await Bun.file(${JSON.stringify(workerPid)}).text());
    while (true) { try { process.kill(pid, 0); await Bun.sleep(10); } catch { break; } }
    Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ status: "ok" }) });
  `;
  const worker = `
    const { renameSync, writeFileSync } = await import("node:fs");
    writeFileSync(${JSON.stringify(`${workerPid}.tmp`)}, String(process.pid));
    renameSync(${JSON.stringify(`${workerPid}.tmp`)}, ${JSON.stringify(workerPid)});
    await Bun.sleep(300);
    process.exit(3);
  `;
  const result = await supervise([
    { name: "backend", cwd: root, env: {}, command: [process.execPath, "-e", backend] },
    { name: "worker:mail", cwd: root, env: {}, command: [process.execPath, "-e", worker] },
  ], {
    ready: [{ name: "backend", port, path: "/api/status", kind: "backend" }],
    onSpawn: async (group) => { groups.push(group); descendantPids.push(group.pid); },
    onReady: () => { announced = true; },
    timeoutMs: 10000,
  });
  expect(result).toBe(3);
  expect(announced).toBe(false);
  expect(groups).toHaveLength(2);
  for (const group of groups) expect(await groupAlive(group.pgid)).toBe(false);
  expect(await listeners(port)).toEqual([]);
}, 12000);

test("TOOL-003 a selected worker without a port counts as ready while it stays alive, and shutdown stops its group", async () => {
  const root = await temporaryRoot();
  const port = reservePort();
  const stateFile = resolve(root, "ready.json");
  const servePath = resolve(import.meta.dir, "../../../scripts/serve.ts");
  const backend = `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ status: "ok" }) });`;
  const runner = Bun.spawn([process.execPath, "-e", `
    const { supervise } = await import(${JSON.stringify(servePath)});
    const { renameSync, writeFileSync } = await import("node:fs");
    const groups = [];
    process.exitCode = await supervise([
      { name: "backend", cwd: ${JSON.stringify(root)}, env: {}, command: [process.execPath, "-e", ${JSON.stringify(backend)}] },
      { name: "worker:mail", cwd: ${JSON.stringify(root)}, env: {}, command: [process.execPath, "-e", "await Bun.sleep(100000)"] },
    ], {
      ready: [{ name: "backend", port: ${port}, path: "/api/status", kind: "backend" }],
      onSpawn: async (group) => { groups.push(group); },
      onReady: () => {
        writeFileSync(${JSON.stringify(`${stateFile}.tmp`)}, JSON.stringify(groups));
        renameSync(${JSON.stringify(`${stateFile}.tmp`)}, ${JSON.stringify(stateFile)});
      },
      timeoutMs: 10000,
    });
  `], { stdout: "pipe", stderr: "pipe" });
  fixtureProcesses.push(runner);
  // Every wait has its own limit, and a failure shows what the supervisor printed instead of a bare test timeout.
  const runnerOutput = Promise.all([new Response(runner.stdout).text(), new Response(runner.stderr).text()])
    .then(([stdout, stderr]) => `${stdout}${stderr}`.trim());
  const fail = async (reason: string): Promise<never> => {
    runner.kill("SIGKILL");
    throw new Error(`${reason} Output supervisor: ${await runnerOutput}`);
  };
  const deadline = Date.now() + 10000;
  while (!(await Bun.file(stateFile).exists())) {
    if (Date.now() >= deadline || runner.exitCode !== null) await fail("Supervisor fixture tidak mengumumkan siap.");
    await Bun.sleep(20);
  }
  const groups: ProcessIdentity[] = await Bun.file(stateFile).json();
  descendantPids.push(...groups.map((group) => group.pid));
  expect(groups).toHaveLength(2);
  for (const group of groups) expect(await groupAlive(group.pgid)).toBe(true);
  runner.kill("SIGTERM");
  const exitCode = await Promise.race([runner.exited, Bun.sleep(8000).then(() => null)]);
  if (exitCode === null) await fail("Supervisor fixture tidak berhenti dalam 8 detik setelah SIGTERM.");
  expect(exitCode).toBe(143);
  for (const group of groups) expect(await groupAlive(group.pgid)).toBe(false);
  expect(await listeners(port)).toEqual([]);
}, 25000);

// Review of 2026-10-04 (docs/reviews/2026-10-04-main-doctor-serve.md): a listener that changes owner during readiness
// (AC-4, invariant 4), the 60 second limit, the readiness targets of selected workers (AC-5), the recovery guard and an
// old record that changes during recovery (AC-7, invariant 2), and a signal before any service runs (AC-8).

/** Readiness of one worker target that answers HTTP 200, with port owner states taken in order from `states`. */
async function readinessWithOwners(states: PortOwnerState[]) {
  const target = await fixtureListener(false, "ready");
  const observed: PortOwnerState[] = [];
  const run = waitForReadiness([{ name: "worker:fixture", port: target.port, path: "/", kind: "worker" }], [],
    new AbortController().signal, 3000, {
      inspectOwner: async () => {
        const state = states[Math.min(observed.length, states.length - 1)]!;
        observed.push(state);
        return state;
      },
    });
  return { run, observed };
}

test("TOOL-006 readiness rejects a listener whose owner changes right after a passed probe", async () => {
  const { run, observed } = await readinessWithOwners(["owned", "foreign"]);
  await expect(run).rejects.toThrow("Listener worker:fixture berubah saat readiness.");
  expect(observed).toEqual(["owned", "foreign"]);
});

test("TOOL-006 readiness rejects a listener whose owner changes right before readiness is announced", async () => {
  const { run, observed } = await readinessWithOwners(["owned", "owned", "foreign"]);
  await expect(run).rejects.toThrow("Listener worker:fixture berubah sebelum siap.");
  expect(observed).toEqual(["owned", "owned", "foreign"]);
});

test("TOOL-006 supervise announces nothing and stops its group when another process takes the port during the probe", async () => {
  const root = await temporaryRoot();
  const port = reservePort();
  const probed = resolve(root, "probed");
  const taken = resolve(root, "taken");
  // The service holds its first answer until a process outside the invocation also listens on [::1] with that port.
  const service = `
    let first = true;
    Bun.serve({ hostname: "127.0.0.1", port: ${port}, async fetch() {
      if (first) {
        first = false;
        await Bun.write(${JSON.stringify(probed)}, "probed");
        while (!(await Bun.file(${JSON.stringify(taken)}).exists())) await Bun.sleep(5);
      }
      return new Response("ready");
    } });
  `;
  const foreign = Bun.spawn([process.execPath, "-e", `
    while (!(await Bun.file(${JSON.stringify(probed)}).exists())) await Bun.sleep(5);
    Bun.serve({ hostname: "::1", port: ${port}, fetch: () => new Response("asing") });
    await Bun.write(${JSON.stringify(taken)}, "taken");
  `], { stdout: "ignore", stderr: "ignore", detached: true });
  fixtureProcesses.push(foreign);
  const groups: ProcessIdentity[] = [];
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.join(" ")); };
  let announced = false;
  let result: number;
  try {
    result = await supervise([{ name: "worker:fixture", cwd: root, env: {}, command: [process.execPath, "-e", service] }], {
      ready: [{ name: "worker:fixture", port, path: "/", kind: "worker" }],
      onSpawn: async (group) => { groups.push(group); descendantPids.push(group.pid); },
      onReady: () => { announced = true; },
      timeoutMs: 10000,
    });
  } finally { console.error = consoleError; }
  expect(result).toBe(1);
  expect(announced).toBe(false);
  expect(errors).toContain("Listener worker:fixture berubah saat readiness.");
  expect(groups).toHaveLength(1);
  for (const group of groups) expect(await groupAlive(group.pgid)).toBe(false);
  expect(foreign.exitCode).toBeNull();
  expect((await listeners(port)).map((item) => item.pid)).toEqual([foreign.pid]);
}, 15000);

test("TOOL-006 the startup limit is 60 seconds and supervise passes it to readiness when no limit is given", async () => {
  expect(STARTUP_TIMEOUT_MS).toBe(60000);
  const root = await temporaryRoot();
  const forwarded: number[] = [];
  let announced = false;
  const result = await supervise([{ name: "fixture", cwd: root, env: {},
    command: [process.execPath, "-e", "await Bun.sleep(300); process.exit(5);"] }], {
    ready: [{ name: "fixture", port: reservePort(), path: "/", kind: "worker" }],
    onSpawn: async (group) => { descendantPids.push(group.pid); },
    onReady: () => { announced = true; },
    waitForReadiness: async (_targets, _groups, _signal, timeoutMs) => { forwarded.push(timeoutMs ?? Number.NaN); },
  });
  expect(result).toBe(5);
  expect(announced).toBe(true);
  expect(forwarded).toHaveLength(1);
  // The limit counts from the first spawn, so what is left when readiness starts is a little under 60 seconds.
  expect(forwarded[0]!).toBeGreaterThan(STARTUP_TIMEOUT_MS - 5000);
  expect(forwarded[0]!).toBeLessThanOrEqual(STARTUP_TIMEOUT_MS);
});

test("TOOL-003 readiness targets are the frontend, the backend, and each selected worker with an HTTP port", () => {
  const selected = config();
  selected.workers.notification = { entry: "apps/worker/notification/src/index.ts", port: 9001, readinessPath: "/ready" };
  selected.workers.mail = { entry: "apps/worker/mail/src/index.ts" };
  const always: ReadyTarget[] = [
    { name: "frontend", port: 8889, path: "/", kind: "frontend" },
    { name: "backend", port: 8888, path: "/api/status", kind: "backend" },
  ];
  expect(readyTargets(selected, [])).toEqual(always);
  expect(readyTargets(selected, ["mail"])).toEqual(always);
  expect(readyTargets(selected, ["notification", "mail"])).toEqual([...always,
    { name: "worker:notification", port: 9001, path: "/ready", kind: "worker" }]);
});

/**
 * Writes an old invocation record through a temporary file and a rename. Its supervisor is this test process with
 * another start time, so the record counts as left by a serve that is gone. Returns the exact text written.
 */
async function staleRecord(root: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const lock = resolve(root, ".local/serve.lock");
  const supervisor = await captureProcess(process.pid);
  const raw = JSON.stringify({ token: "old-token", checkout: await realpath(root), uid: process.getuid?.() ?? -1,
    supervisor: { ...supervisor, started: `${supervisor.started} stale` }, groups: [], ...overrides });
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(resolve(lock, "owner.tmp"), raw, { mode: 0o600 });
  await rename(resolve(lock, "owner.tmp"), resolve(lock, "owner.json"));
  return raw;
}

/** What `.local/` of a checkout holds: entry names (lock, guard, moved records) and the lock record text. */
async function lockState(root: string): Promise<{ entries: string[]; record: string | null }> {
  const local = resolve(root, ".local");
  return {
    entries: (await readdir(local).catch(() => [])).sort(),
    record: await readFile(resolve(local, "serve.lock/owner.json"), "utf8").catch(() => null),
  };
}

test("TOOL-005 a recovery guard left by a crash blocks serve and leaves the old record where it is", async () => {
  const root = await temporaryRoot();
  const record = await staleRecord(root);
  await mkdir(resolve(root, ".local/serve.recovery.lock"));
  await expect(Invocation.acquire(root)).rejects.toThrow("Pemulihan serve perlu diselesaikan secara manual.");
  expect(await lockState(root)).toEqual({ entries: ["serve.lock", "serve.recovery.lock"], record });
});

test("TOOL-005 a recoverer that finds the guard taken fails and leaves the other recovery alone", async () => {
  const root = await temporaryRoot();
  const record = await staleRecord(root);
  // Another recoverer takes the guard right after this one found the old supervisor gone.
  await expect(Invocation.acquire(root, {
    processIdentity: async () => { await mkdir(resolve(root, ".local/serve.recovery.lock")); return null; },
  })).rejects.toThrow("Pemulihan serve sedang berjalan atau perlu dihentikan secara manual.");
  expect(await lockState(root)).toEqual({ entries: ["serve.lock", "serve.recovery.lock"], record });
});

test("TOOL-005 two processes recovering the same old record end with exactly one owner", async () => {
  const root = await temporaryRoot();
  const record = await staleRecord(root);
  const modulePath = resolve(import.meta.dir, "../../../scripts/lib/invocation.ts");
  const gate = resolve(root, "start");
  const release = resolve(root, "release");
  // Each process reports its outcome in a file; the owner keeps the lock until both outcomes exist.
  const code = (index: number) => `
    const { Invocation } = await import(${JSON.stringify(modulePath)});
    const { renameSync, writeFileSync } = await import("node:fs");
    const report = (text) => {
      writeFileSync(${JSON.stringify(root)} + "/outcome-${index}.tmp", text);
      renameSync(${JSON.stringify(root)} + "/outcome-${index}.tmp", ${JSON.stringify(root)} + "/outcome-${index}");
    };
    writeFileSync(${JSON.stringify(root)} + "/ready-${index}", "ready");
    while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(2);
    let owner;
    try { owner = await Invocation.acquire(${JSON.stringify(root)}); report("acquired"); }
    catch (error) { report("rejected: " + error.message); }
    if (owner) {
      while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(10);
      await owner.release();
    }
  `;
  const children = [0, 1].map((index) => Bun.spawn([process.execPath, "-e", code(index)], { stdout: "ignore", stderr: "pipe" }));
  fixtureProcesses.push(...children);
  const waitFor = async (paths: string[], what: string) => {
    const deadline = Date.now() + 10000;
    while (!(await Promise.all(paths.map((path) => Bun.file(path).exists()))).every(Boolean)) {
      if (Date.now() >= deadline) throw new Error(`${what} tidak tersedia dalam 10 detik.`);
      await Bun.sleep(10);
    }
  };
  await waitFor([0, 1].map((index) => resolve(root, `ready-${index}`)), "Proses pemulih");
  await Bun.write(gate, "go");
  await waitFor([0, 1].map((index) => resolve(root, `outcome-${index}`)), "Hasil pemulihan");
  const outcomes = (await Promise.all([0, 1].map((index) => Bun.file(resolve(root, `outcome-${index}`)).text()))).sort();
  await Bun.write(release, "go");
  for (const child of children) {
    const [stderr, status] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  }
  expect(outcomes[0]).toBe("acquired");
  // Which safe refusal the other process gets depends on how far the owner was; none of them moves the old record.
  expect([
    "rejected: Pemulihan serve sedang berjalan atau perlu dihentikan secara manual.",
    "rejected: Pemulihan serve perlu diselesaikan secara manual.",
    "rejected: Identitas invocation berubah saat pemulihan.",
    "rejected: Serve lain dari checkout ini masih aktif.",
  ]).toContain(outcomes[1]!);
  // The owner released without clearing the old record, so the record is back in the lock and nothing else is left.
  expect(await lockState(root)).toEqual({ entries: ["serve.lock"], record });
}, 15000);

test("TOOL-005 an old record of another checkout or user is refused and never moved", async () => {
  for (const overrides of [{ checkout: "/tmp/another-foundation-checkout" }, { uid: (process.getuid?.() ?? 0) + 1 }]) {
    const root = await temporaryRoot();
    const record = await staleRecord(root, overrides);
    await expect(Invocation.acquire(root)).rejects.toThrow("Catatan serve bukan milik checkout dan user ini.");
    expect(await lockState(root)).toEqual({ entries: ["serve.lock"], record });
  }
});

test("TOOL-005 recovery fails safely when the old record changes before the guard is taken", async () => {
  const root = await temporaryRoot();
  await staleRecord(root);
  let changed = "";
  await expect(Invocation.acquire(root, {
    processIdentity: async () => {
      if (!changed) changed = await staleRecord(root, { token: "newer-token" });
      return null;
    },
  })).rejects.toThrow("Identitas invocation berubah saat pemulihan.");
  expect(await lockState(root)).toEqual({ entries: ["serve.lock"], record: changed });
});

test("TOOL-005 recovery fails safely when the old supervisor proves alive at the second look", async () => {
  const root = await temporaryRoot();
  const record = await staleRecord(root, { supervisor: await captureProcess(process.pid) });
  let calls = 0;
  // The first look (before the guard) misses the process; the second look inside the guard sees it alive.
  await expect(Invocation.acquire(root, {
    processIdentity: async (pid) => (++calls === 1 ? null : processIdentity(pid)),
  })).rejects.toThrow("Identitas invocation berubah saat pemulihan.");
  expect(calls).toBe(2);
  expect(await lockState(root)).toEqual({ entries: ["serve.lock"], record });
});

test("TOOL-005 recovery fails safely when the lock directory is replaced during the review", async () => {
  const root = await temporaryRoot();
  const record = await staleRecord(root);
  let calls = 0;
  // Inside the guard, the lock directory is swapped for a new one that holds the same record text.
  await expect(Invocation.acquire(root, {
    processIdentity: async () => {
      if (++calls === 2) {
        await rename(resolve(root, ".local/serve.lock"), resolve(root, "replaced-lock"));
        await staleRecord(root);
      }
      return null;
    },
  })).rejects.toThrow("Lock berubah saat pemulihan.");
  expect(calls).toBe(2);
  expect(await lockState(root)).toEqual({ entries: ["serve.lock"], record });
});

test("TOOL-004 Ctrl+C or termination during preflight stops serve, releases its lock, and puts back an old record", async () => {
  const sockets: Socket[] = [];
  const silent = createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((done) => silent.listen(0, "127.0.0.1", () => done()));
  const address = silent.address();
  if (!address || typeof address === "string") throw new Error("Port fixture tidak tersedia.");
  try {
    for (const [signal, code, withOldRecord] of [["SIGINT", 130, false], ["SIGTERM", 143, true]] as const) {
      const root = await temporaryCheckout();
      const record = withOldRecord ? await staleRecord(root) : null;
      const child = Bun.spawn([process.execPath, "--no-env-file", resolve(root, "scripts/serve.ts")], {
        cwd: root, stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "development",
          DATABASE_URL: `postgres://foundation_backend:signal-private-secret@127.0.0.1:${address.port}/foundation` },
      });
      fixtureProcesses.push(child);
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        .then(([stdout, stderr]) => stdout + stderr);
      // The database never answers, so serve stays in preflight once doctor has connected.
      const connected = sockets.length;
      const deadline = Date.now() + 10000;
      while (sockets.length === connected) {
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`Serve tidak mencapai pemeriksaan database. ${await output}`);
        await Bun.sleep(20);
      }
      expect(await exists(resolve(root, ".local/serve.lock/owner.json"))).toBe(true);
      if (record) expect((await lockState(root)).record).not.toBe(record);
      const sent = performance.now();
      child.kill(signal);
      expect(await child.exited).toBe(code);
      expect(performance.now() - sent).toBeLessThan(2000);
      const text = await output;
      expect(text).toContain("Serve dihentikan sebelum layanan dijalankan.");
      expect(text).not.toContain("Menjalankan ");
      expect(text).not.toContain("signal-private-secret");
      expect(await lockState(root)).toEqual(record ? { entries: ["serve.lock"], record } : { entries: [], record: null });
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => silent.close(() => done()));
  }
}, 30000);
