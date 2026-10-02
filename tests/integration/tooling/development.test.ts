import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runDoctor } from "../../../scripts/doctor";
import { services, supervise } from "../../../scripts/serve";
import { insideRoot, loadConfig, selectWorkers, type DevelopmentConfig } from "../../../scripts/lib/development";
import { clearPorts, listeners } from "../../../scripts/lib/ports";
import { captureProcess } from "../../../scripts/lib/process-identity";
import { Invocation } from "../../../scripts/lib/invocation";
import { waitForReadiness } from "../../../scripts/lib/readiness";

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
  for (const key of ["DATABASE_URL", "NOTIFICATION_DATABASE_URL", "NODE_ENV", "SESSION_SECRET"]) {
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

test("TOOL-001 doctor reports missing prerequisites without stopping a listener or leaking credentials", async () => {
  const root = await temporaryRoot();
  const listener = await fixtureListener();
  const selected = config();
  selected.backend.port = listener.port;
  process.env.DATABASE_URL = "invalid-url-with-private-secret";
  process.env.NODE_ENV = "development";
  const checks = await runDoctor(selected, [], root);
  expect(checks.some((item) => item.name === "Entry backend" && item.status === "error")).toBe(true);
  expect(checks.some((item) => item.name === `Port ${listener.port}` && item.status === "warning")).toBe(true);
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
  const definitions = services(selected, ["notification", "report"]);
  expect(definitions[0].env.PORT).toBe("8888");
  expect(definitions[0].env.DATABASE_URL).toBe("backend-private-url");
  expect(definitions[1].command).toContain("8889");
  expect(definitions[1].env.DATABASE_URL).toBeUndefined();
  expect(definitions[1].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[2].env.DATABASE_URL).toBe("notification-private-url");
  expect(definitions[3].env.DATABASE_URL).toBeUndefined();
  expect(definitions[2].env.SESSION_SECRET).toBeUndefined();
  expect(definitions[3].env.SESSION_SECRET).toBeUndefined();
  expect(definitions.every((item) => item.env.NOTIFICATION_DATABASE_URL === undefined)).toBe(true);
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

test("TOOL-005 a second invocation cannot take the active lock", async () => {
  const root = await temporaryRoot();
  const first = await Invocation.acquire(root);
  try { await expect(Invocation.acquire(root)).rejects.toThrow("masih aktif"); }
  finally { await first.release(); }
  const next = await Invocation.acquire(root);
  await next.release();
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
